import * as vscode from 'vscode';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

const IS_WINDOWS = platform() === 'win32';

export function registerRunParticipant(
  context: vscode.ExtensionContext,
  log: vscode.LogOutputChannel,
): void {
  const handler: vscode.ChatRequestHandler = async (request, _ctx, stream, token) => {
    const command = request.prompt.trim();
    if (!command) {
      stream.markdown('Usage: `@run <command>`');
      return;
    }

    log.info(`@run: ${command}`);
    stream.markdown(`\`\`\`\n$ ${command}\n`);

    const [cmd, args] = IS_WINDOWS
      ? ['wsl', ['bash', '-c', command]] as const
      : ['bash', ['-c', command]] as const;

    const exitCode = await new Promise<number>((resolve) => {
      const proc = spawn(cmd, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });

      const push = (chunk: Buffer) => {
        if (!token.isCancellationRequested) stream.markdown(chunk.toString('utf-8'));
      };
      proc.stdout.on('data', push);
      proc.stderr.on('data', push);
      proc.on('close', (code) => resolve(code ?? -1));
      proc.on('error', () => resolve(-1));
      token.onCancellationRequested(() => proc.kill('SIGTERM'));
    });

    stream.markdown(`\n\`\`\`\n\n**exit code: ${exitCode}**\n`);
    log.info(`@run complete: exit_code=${exitCode}`);
    return { metadata: { exitCode } };
  };

  const participant = vscode.chat.createChatParticipant('terminal.run', handler);
  participant.iconPath = new vscode.ThemeIcon('terminal');
  context.subscriptions.push(participant);
}
