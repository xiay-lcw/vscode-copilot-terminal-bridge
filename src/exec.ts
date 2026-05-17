import { spawn } from 'node:child_process';
import { platform } from 'node:os';

const IS_WINDOWS = platform() === 'win32';

/** Single-quote a string for safe embedding in bash. */
export function sq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export interface ExecResult {
  stdout: string;
  exitCode: number;
}

function shellArgs(script: string): [string, string[]] {
  return IS_WINDOWS ? ['wsl', ['bash', '-c', script]] : ['bash', ['-c', script]];
}

/** Run a bash script, merging stdout+stderr. Returns when done. */
export function shellExec(script: string, timeoutMs = 300_000): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const [cmd, args] = shellArgs(script);
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    let killed = false;

    const timer = setTimeout(() => { killed = true; proc.kill('SIGTERM'); }, timeoutMs);

    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.stderr.on('data', (c: Buffer) => chunks.push(c));
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(chunks).toString('utf-8'), exitCode: killed ? 124 : (code ?? -1) });
    });
  });
}

/** Run a bash script with streaming output. Calls `onData` with accumulated text on each chunk. */
export function shellExecStreaming(
  script: string,
  onData: (accumulated: string) => void,
  timeoutMs = 300_000,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const [cmd, args] = shellArgs(script);
    const proc = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let killed = false;

    const timer = setTimeout(() => { killed = true; proc.kill('SIGTERM'); }, timeoutMs);

    const handle = (c: Buffer) => { output += c.toString('utf-8'); onData(output); };
    proc.stdout.on('data', handle);
    proc.stderr.on('data', handle);
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: output, exitCode: killed ? 124 : (code ?? -1) });
    });
  });
}
