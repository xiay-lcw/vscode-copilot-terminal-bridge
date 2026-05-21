import * as vscode from 'vscode';
import { sq } from './exec';
import { TransportResolver } from './transport';

interface FgRunInput {
  command: string;
  cwd?: string;
  profile?: string;
}

export class FgRunTool implements vscode.LanguageModelTool<FgRunInput> {
  constructor(
    private readonly log: vscode.LogOutputChannel,
    private readonly resolve: TransportResolver,
  ) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<FgRunInput>,
    _token: vscode.CancellationToken,
  ): vscode.PreparedToolInvocation {
    const { command, profile } = options.input;
    return {
      invocationMessage: new vscode.MarkdownString(
        profile ? `Running \`${command}\` on **${profile}**` : `Running \`${command}\``
      ),
      toolSpecificData: {
        kind: 'terminal',
        commandLine: { original: profile ? `[${profile}] ${command}` : command },
        language: 'shellscript',
        terminalCommandOutput: { text: '' },
      },
    } as vscode.PreparedToolInvocation;
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<FgRunInput>,
    _token: vscode.CancellationToken,
    progress?: { report(value: any): void },
  ): Promise<vscode.LanguageModelToolResult> {
    const { command, cwd, profile } = options.input;
    let transport;
    try { transport = this.resolve(profile); } catch (e: any) {
      return new vscode.LanguageModelToolResult([
        new vscode.LanguageModelTextPart(`${e.message}\n[exit code: -1]`),
      ]);
    }
    this.log.info(`fg_run [${transport.name}]: ${command}${cwd ? ` (cwd: ${cwd})` : ''}`);

    const start = Date.now();
    const script = cwd ? `cd ${sq(cwd)} || exit 1\n${command}` : command;

    const { stdout, exitCode } = await transport.execStreaming(script, (accumulated) => {
      if (!progress) return;
      progress.report({
        toolSpecificData: {
          kind: 'terminal',
          terminalCommandOutput: { text: accumulated.replace(/\n/g, '\r\n') },
        },
      });
    });

    const duration = Date.now() - start;
    this.log.info(`fg_run complete: exit_code=${exitCode} duration=${duration}ms`);

    const result = new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(`${stdout}\n[exit code: ${exitCode}]`),
    ]);
    (result as any).toolMetadata = {
      terminalCommandOutput: { text: stdout.replace(/\n/g, '\r\n') },
      terminalCommandState: { exitCode, duration },
    };
    return result;
  }
}
