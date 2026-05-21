import { spawn } from 'node:child_process';
import { unlinkSync } from 'node:fs';
import { platform } from 'node:os';
import { ExecResult, writeTempScript } from './exec';

const IS_WINDOWS = platform() === 'win32';

export interface Transport {
  readonly name: string;
  readonly type: string;
  exec(script: string, timeoutMs?: number): Promise<ExecResult>;
  execStreaming(script: string, onData: (accumulated: string) => void, timeoutMs?: number): Promise<ExecResult>;
  dispose(): void;
}

export interface SshProfileConfig { type: 'ssh'; host: string; port?: number; user?: string; identityFile?: string }
export interface WslProfileConfig { type: 'wsl'; distribution?: string }
export interface LocalProfileConfig { type: 'local' }
export type ProfileConfig = SshProfileConfig | WslProfileConfig | LocalProfileConfig;

// ---------------------------------------------------------------------------
// Spawn helpers
// ---------------------------------------------------------------------------

function spawnCollect(
  cmd: string, args: string[], stdin: string | null, timeoutMs: number,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: [stdin !== null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    if (stdin !== null) { proc.stdin!.write(stdin); proc.stdin!.end(); }
    const chunks: Buffer[] = [];
    let killed = false;
    const timer = setTimeout(() => { killed = true; proc.kill('SIGTERM'); }, timeoutMs);
    proc.stdout!.on('data', (c: Buffer) => chunks.push(c));
    proc.stderr!.on('data', (c: Buffer) => chunks.push(c));
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(chunks).toString('utf-8'), exitCode: killed ? 124 : (code ?? -1) });
    });
  });
}

function spawnStream(
  cmd: string, args: string[], stdin: string | null,
  onData: (accumulated: string) => void, timeoutMs: number,
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: [stdin !== null ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    if (stdin !== null) { proc.stdin!.write(stdin); proc.stdin!.end(); }
    let output = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; proc.kill('SIGTERM'); }, timeoutMs);
    const handle = (c: Buffer) => { output += c.toString('utf-8'); onData(output); };
    proc.stdout!.on('data', handle);
    proc.stderr!.on('data', handle);
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout: output, exitCode: killed ? 124 : (code ?? -1) });
    });
  });
}

function cleanupTmpFile(p: string): void {
  try { unlinkSync(p); } catch {}
}

// ---------------------------------------------------------------------------
// Local transport (Linux bash)
// ---------------------------------------------------------------------------

class LocalTransport implements Transport {
  readonly type = 'local';
  constructor(readonly name: string) {}

  async exec(script: string, timeoutMs = 300_000): Promise<ExecResult> {
    const p = writeTempScript(script);
    return spawnCollect('bash', [p], null, timeoutMs).finally(() => cleanupTmpFile(p));
  }

  async execStreaming(script: string, onData: (acc: string) => void, timeoutMs = 300_000): Promise<ExecResult> {
    const p = writeTempScript(script);
    return spawnStream('bash', [p], null, onData, timeoutMs).finally(() => cleanupTmpFile(p));
  }

  dispose() {}
}

// ---------------------------------------------------------------------------
// WSL transport (Windows → WSL bash)
// ---------------------------------------------------------------------------

class WslTransport implements Transport {
  readonly type = 'wsl';
  private readonly distroArgs: string[];

  constructor(readonly name: string, distribution?: string) {
    this.distroArgs = distribution ? ['-d', distribution] : [];
  }

  private toWslPath(winPath: string): string {
    return winPath.replace(/^([A-Za-z]):/, (_, d: string) => `/mnt/${d.toLowerCase()}`).replace(/\\/g, '/');
  }

  async exec(script: string, timeoutMs = 300_000): Promise<ExecResult> {
    const p = writeTempScript(script);
    return spawnCollect('wsl', [...this.distroArgs, 'bash', this.toWslPath(p)], null, timeoutMs)
      .finally(() => cleanupTmpFile(p));
  }

  async execStreaming(script: string, onData: (acc: string) => void, timeoutMs = 300_000): Promise<ExecResult> {
    const p = writeTempScript(script);
    return spawnStream('wsl', [...this.distroArgs, 'bash', this.toWslPath(p)], null, onData, timeoutMs)
      .finally(() => cleanupTmpFile(p));
  }

  dispose() {}
}

// ---------------------------------------------------------------------------
// SSH transport
// ---------------------------------------------------------------------------

class SshTransport implements Transport {
  readonly type = 'ssh';
  private readonly target: string;
  private readonly baseArgs: string[];
  private readonly controlPath: string;

  constructor(readonly name: string, config: SshProfileConfig) {
    this.target = config.user ? `${config.user}@${config.host}` : config.host;
    this.controlPath = `/tmp/tb-ssh-${name}-${process.pid}`;
    this.baseArgs = [
      '-o', `ControlPath=${this.controlPath}`,
      '-o', 'ControlMaster=auto',
      '-o', 'ControlPersist=10m',
      '-o', 'BatchMode=yes',
    ];
    if (config.port) this.baseArgs.push('-p', String(config.port));
    if (config.identityFile) this.baseArgs.push('-i', config.identityFile);
  }

  private get sshCmd(): string { return IS_WINDOWS ? 'wsl' : 'ssh'; }

  private get sshArgs(): string[] {
    const args = [...this.baseArgs, this.target, 'bash', '-s'];
    return IS_WINDOWS ? ['ssh', ...args] : args;
  }

  async exec(script: string, timeoutMs = 300_000): Promise<ExecResult> {
    return spawnCollect(this.sshCmd, this.sshArgs, script, timeoutMs);
  }

  async execStreaming(script: string, onData: (acc: string) => void, timeoutMs = 300_000): Promise<ExecResult> {
    return spawnStream(this.sshCmd, this.sshArgs, script, onData, timeoutMs);
  }

  dispose() {
    const exitArgs = IS_WINDOWS
      ? ['ssh', ...this.baseArgs, '-O', 'exit', this.target]
      : [...this.baseArgs, '-O', 'exit', this.target];
    try { spawn(IS_WINDOWS ? 'wsl' : 'ssh', exitArgs, { stdio: 'ignore' }); } catch {}
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createTransport(name: string, config: ProfileConfig): Transport {
  switch (config.type) {
    case 'local': return new LocalTransport(name);
    case 'wsl': return new WslTransport(name, config.distribution);
    case 'ssh': return new SshTransport(name, config);
  }
}

export function createDefaultTransport(): Transport {
  return IS_WINDOWS ? new WslTransport('default') : new LocalTransport('default');
}
