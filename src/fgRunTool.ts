import * as vscode from 'vscode';
import { shellExec, sq } from './exec';

interface FgRunInput {
  command: string;
  cwd?: string;
}

function escapeInlineCode(s: string): string {
  let n = 0, run = 0;
  for (const ch of s) { run = ch === '`' ? run + 1 : 0; n = Math.max(n, run); }
  const fence = '`'.repeat(n + 1);
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${s}${pad}${fence}`;
}

export class FgRunTool implements vscode.LanguageModelTool<FgRunInput> {
  constructor(private readonly log: vscode.LogOutputChannel) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<FgRunInput>,
    _token: vscode.CancellationToken,
  ): vscode.PreparedToolInvocation {
    const { command } = options.input;
    return {
      invocationMessage: new vscode.MarkdownString(`Running ${escapeInlineCode(command)}`),
      confirmationMessages: {
        title: 'Run in terminal?',
        message: new vscode.MarkdownString(`\`\`\`\`\`bash\n${command}\n\`\`\`\`\``),
      },
    };
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<FgRunInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { command, cwd } = options.input;
    this.log.info(`fg_run: ${command}${cwd ? ` (cwd: ${cwd})` : ''}`);

    const script = cwd ? `cd ${sq(cwd)} || exit 1\n${command}` : command;
    const { stdout, exitCode } = await shellExec(script);

    this.log.info(`fg_run complete: exit_code=${exitCode}`);
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(`${stdout}\n[exit code: ${exitCode}]`),
    ]);
  }
}
