import * as vscode from 'vscode';
import { randomBytes } from 'node:crypto';
import { sq } from './exec';
import { Transport } from './transport';

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const JOBS = '$HOME/.local/share/terminal/jobs';
const JOB_ID_RE = /^bg_\d+_[0-9a-f]{16}$/;

function jd(id: string): string { return `${JOBS}/${id}`; }

function genId(): string {
  return `bg_${Date.now()}_${randomBytes(8).toString('hex')}`;
}

function txt(s: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);
}

function badId(id: string): vscode.LanguageModelToolResult | null {
  return JOB_ID_RE.test(id) ? null : txt(`ok: false\nerror: Invalid job_id format: ${id}`);
}

// ---------------------------------------------------------------------------
// bg_launch
// ---------------------------------------------------------------------------

interface LaunchInput { command: string; cwd?: string; interactive?: boolean }

export class BgLaunchTool implements vscode.LanguageModelTool<LaunchInput> {
  constructor(private readonly log: vscode.LogOutputChannel, private readonly getTransport: () => Transport) {}

  prepareInvocation(opts: vscode.LanguageModelToolInvocationPrepareOptions<LaunchInput>) {
    return {
      invocationMessage: 'Launching background job…',
      confirmationMessages: {
        title: 'Launch background command?',
        message: new vscode.MarkdownString(`\`\`\`\`\`bash\n${opts.input.command}\n\`\`\`\`\``),
      },
    };
  }

  async invoke(opts: vscode.LanguageModelToolInvocationOptions<LaunchInput>): Promise<vscode.LanguageModelToolResult> {
    const { command, cwd, interactive = false } = opts.input;
    const id = genId();
    const d = jd(id);
    const mode = interactive ? 'interactive' : 'oneshot';
    this.log.info(`bg_launch [${mode}]: ${command}`);

    // Setup metadata
    const setup = `set -e; mkdir -p ${d}
printf '%s' ${sq(command)} > ${d}/command
printf '%s' ${sq(cwd || '')} > ${d}/cwd
date -Iseconds > ${d}/created_at
printf '%s' ${sq(mode)} > ${d}/mode
touch ${d}/running`;

    const t = this.getTransport();
    const { exitCode: rc } = await t.exec(setup);
    if (rc !== 0) return txt('ok: false\nerror: Failed to create job directory');

    if (interactive) {
      await t.exec(
        `tmux new-session -d -s ${sq(id)}` +
        ` && tmux pipe-pane -t ${sq(id)} "cat >> ${d}/output.log"` +
        ` && tmux send-keys -l -t ${sq(id)} ${sq(command)} Enter`,
      );
    } else {
      // Generate wrapper identical to the Python MCP server's format
      const w = cwd
        ? `cd ${sq(cwd)} || { echo '[2] cd failed' >> "$JD/output.log"; echo 1 > "$JD/exitcode"; rm -f "$JD/running"; exit; }\n`
        : '';
      const wrapper = `#!/usr/bin/env bash
set -o pipefail
JD="${d}"
${w}eval ${sq(command)} > >(stdbuf -oL sed 's/^/[1] /' >> "$JD/output.log") 2> >(stdbuf -oL sed 's/^/[2] /' >> "$JD/output.log")
EXIT=$?
sleep 0.2
echo $EXIT > "$JD/exitcode"
rm -f "$JD/running"`;

      await t.exec(`cat > ${d}/run.sh << 'BWEOF'\n${wrapper}\nBWEOF\ntmux new-session -d -s ${sq(id)} "bash ${d}/run.sh"`);
    }

    return txt(`job_id: ${id}\nlog_path: ${d}/output.log\nmode: ${mode}`);
  }
}

// ---------------------------------------------------------------------------
// bg_status
// ---------------------------------------------------------------------------

interface StatusInput { job_id: string }

export class BgStatusTool implements vscode.LanguageModelTool<StatusInput> {
  constructor(private readonly log: vscode.LogOutputChannel, private readonly getTransport: () => Transport) {}

  async invoke(opts: vscode.LanguageModelToolInvocationOptions<StatusInput>): Promise<vscode.LanguageModelToolResult> {
    const { job_id } = opts.input;
    const err = badId(job_id); if (err) return err;
    const d = jd(job_id);

    const { stdout } = await this.getTransport().exec(`
[ -d ${d} ] || { echo "NOT_FOUND"; exit; }
MODE=$(cat ${d}/mode 2>/dev/null || echo oneshot)
if [ -f ${d}/running ]; then echo "running"; exit; fi
if [ "$MODE" = "interactive" ]; then echo "closed"; exit; fi
if [ -f ${d}/exitcode ]; then EC=$(cat ${d}/exitcode); [ "$EC" = "0" ] && echo "completed $EC" || echo "failed $EC"; exit; fi
echo "unknown"`);

    const parts = stdout.trim().split(' ');
    if (parts[0] === 'NOT_FOUND') return txt(`ok: false\nerror: Job ${job_id} not found`);
    const line = parts.length > 1
      ? `ok: true\njob_id: ${job_id}\nstatus: ${parts[0]}\nexit_code: ${parts[1]}`
      : `ok: true\njob_id: ${job_id}\nstatus: ${parts[0]}`;
    return txt(line);
  }
}

// ---------------------------------------------------------------------------
// bg_get_output
// ---------------------------------------------------------------------------

interface OutputInput { job_id: string; tail?: number }

export class BgGetOutputTool implements vscode.LanguageModelTool<OutputInput> {
  constructor(private readonly log: vscode.LogOutputChannel, private readonly getTransport: () => Transport) {}

  async invoke(opts: vscode.LanguageModelToolInvocationOptions<OutputInput>): Promise<vscode.LanguageModelToolResult> {
    const { job_id, tail = 20 } = opts.input;
    const err = badId(job_id); if (err) return err;
    const d = jd(job_id);
    const n = tail === -1 ? 10000 : Math.min(Math.max(0, tail), 10000);

    const { stdout } = await this.getTransport().exec(
      `[ -d ${d} ] || { echo "__NF__"; exit; }; [ -f ${d}/output.log ] && tail -n ${n} ${d}/output.log || true`,
    );
    if (stdout.trim() === '__NF__') return txt(`ok: false\nerror: Job ${job_id} not found`);

    const block = stdout.split('\n').map(l => `  ${l}`).join('\n');
    return txt(`ok: true\njob_id: ${job_id}\noutput: |\n${block}`);
  }
}

// ---------------------------------------------------------------------------
// bg_send_cmd
// ---------------------------------------------------------------------------

interface SendInput { job_id: string; command: string }

export class BgSendCmdTool implements vscode.LanguageModelTool<SendInput> {
  constructor(private readonly log: vscode.LogOutputChannel, private readonly getTransport: () => Transport) {}

  prepareInvocation(opts: vscode.LanguageModelToolInvocationPrepareOptions<SendInput>) {
    return {
      invocationMessage: `Sending command to ${opts.input.job_id}…`,
      confirmationMessages: {
        title: 'Send command to background job?',
        message: new vscode.MarkdownString(`\`\`\`\`\`bash\n${opts.input.command}\n\`\`\`\`\``),
      },
    };
  }

  async invoke(opts: vscode.LanguageModelToolInvocationOptions<SendInput>): Promise<vscode.LanguageModelToolResult> {
    const { job_id, command } = opts.input;
    const err = badId(job_id); if (err) return err;
    const d = jd(job_id);

    const { stdout } = await this.getTransport().exec(`
[ -d ${d} ] || { echo "not_found"; exit 1; }
[ "$(cat ${d}/mode 2>/dev/null)" = "interactive" ] || { echo "not_interactive"; exit 1; }
[ -f ${d}/running ] || { echo "not_running"; exit 1; }
tmux send-keys -l -t ${sq(job_id)} ${sq(command)} Enter && echo "ok"`);

    const r = stdout.trim();
    if (r === 'ok') return txt(`ok: true\njob_id: ${job_id}`);
    const msgs: Record<string, string> = {
      not_found: `Job ${job_id} not found`,
      not_interactive: 'Job is not interactive',
      not_running: 'Job is not running',
    };
    return txt(`ok: false\nerror: ${msgs[r] ?? r}`);
  }
}

// ---------------------------------------------------------------------------
// bg_exit
// ---------------------------------------------------------------------------

interface ExitInput { job_id: string; timeout?: number }

export class BgExitTool implements vscode.LanguageModelTool<ExitInput> {
  constructor(private readonly log: vscode.LogOutputChannel, private readonly getTransport: () => Transport) {}

  async invoke(opts: vscode.LanguageModelToolInvocationOptions<ExitInput>): Promise<vscode.LanguageModelToolResult> {
    const { job_id, timeout = 60 } = opts.input;
    const err = badId(job_id); if (err) return err;
    const d = jd(job_id);

    await this.getTransport().exec(`
[ -d ${d} ] || exit 0
MODE=$(cat ${d}/mode 2>/dev/null || echo oneshot)
if [ "$MODE" = "interactive" ] && [ -f ${d}/running ]; then
  tmux send-keys -l -t ${sq(job_id)} exit Enter 2>/dev/null || true
  for i in $(seq 1 ${timeout}); do tmux has-session -t ${sq(job_id)} 2>/dev/null || break; sleep 1; done
fi
tmux kill-session -t ${sq(job_id)} 2>/dev/null || true
rm -f ${d}/running`, (timeout + 10) * 1000);

    return txt(`ok: true\njob_id: ${job_id}`);
  }
}

// ---------------------------------------------------------------------------
// bg_list_jobs
// ---------------------------------------------------------------------------

interface ListInput { status_filter?: string; age_secs?: number }

export class BgListJobsTool implements vscode.LanguageModelTool<ListInput> {
  constructor(private readonly log: vscode.LogOutputChannel, private readonly getTransport: () => Transport) {}

  async invoke(opts: vscode.LanguageModelToolInvocationOptions<ListInput>): Promise<vscode.LanguageModelToolResult> {
    const { status_filter, age_secs = -1 } = opts.input;

    const { stdout } = await this.getTransport().exec(`
JD="${JOBS}"; [ -d "$JD" ] || { echo ""; exit; }
NOW=$(date +%s)
for d in "$JD"/bg_*; do [ -d "$d" ] || continue
  ID=$(basename "$d")
  CS=$(date -d "$(cat "$d/created_at" 2>/dev/null)" +%s 2>/dev/null || echo "$NOW"); AGE=$((NOW-CS))
  ${age_secs > 0 ? `[ "$AGE" -gt ${age_secs} ] && continue` : ''}
  if [ -f "$d/running" ]; then ST=running
  elif [ -f "$d/exitcode" ]; then EC=$(cat "$d/exitcode"); [ "$EC" = "0" ] && ST=completed || ST=failed
  else M=$(cat "$d/mode" 2>/dev/null || echo oneshot); [ "$M" = "interactive" ] && ST=closed || ST=unknown; fi
  ${status_filter && status_filter !== 'all' ? `[ "$ST" != ${sq(status_filter)} ] && continue` : ''}
  echo "$ID|$ST|native|$AGE"
done`);

    const lines = stdout.trim().split('\n').filter(l => l.length > 0);
    const header = 'job_id|status|backend|age_secs';
    if (lines.length === 0) return txt(`${header}\ncount: 0`);
    return txt(`${header}\n${lines.join('\n')}\ncount: ${lines.length}`);
  }
}
