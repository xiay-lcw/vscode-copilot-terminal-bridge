import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Single-quote a string for safe embedding in bash. */
export function sq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

export interface ExecResult {
  stdout: string;
  exitCode: number;
}

/** Write a script to a temp file and return its path. Caller must clean up. */
export function writeTempScript(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'tb-'));
  const scriptPath = join(dir, 'run.sh');
  writeFileSync(scriptPath, script, 'utf8');
  return scriptPath;
}
