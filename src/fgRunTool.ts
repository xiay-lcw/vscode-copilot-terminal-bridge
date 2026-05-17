import * as vscode from 'vscode';
import { shellExecStreaming, sq } from './exec';

interface FgRunInput {
  command: string;
  cwd?: string;
}

export class FgRunTool implements vscode.LanguageModelTool<FgRunInput> {
  constructor(private readonly log: vscode.LogOutputChannel) {}

  prepareInvocation(
    options: vscode.LanguageModelToolInvocationPrepareOptions<FgRunInput>,
    _token: vscode.CancellationToken,
  ): vscode.PreparedToolInvocation {
    const { command } = options.input;
    return {
      invocationMessage: new vscode.MarkdownString(`Running \`${command}\``),
      toolSpecificData: {
        kind: 'terminal',
        commandLine: { original: command },
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
    const { command, cwd } = options.input;
    this.log.info(`fg_run: ${command}${cwd ? ` (cwd: ${cwd})` : ''}`);

    const start = Date.now();
    const script = cwd ? `cd ${sq(cwd)} || exit 1\n${command}` : command;

    const { stdout, exitCode } = await shellExecStreaming(script, (accumulated) => {
      if (!progress) return;
      const lastLine = accumulated.trimEnd().split('\n').pop() ?? '';
      progress.report({
        message: lastLine,
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
