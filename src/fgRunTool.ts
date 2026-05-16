import * as vscode from 'vscode';
import { shellExec, sq } from './exec';

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
      confirmationMessages: {
        title: 'Run in terminal?',
        message: new vscode.MarkdownString(`\`\`\`\`\`bash\n${command}\n\`\`\`\`\``),
      },
      // Patched ext host forwards this → main thread renders terminal card
      toolSpecificData: {
        commandLine: { original: command },
        language: 'shellscript',
      },
    } as vscode.PreparedToolInvocation;
  }

  async invoke(
    options: vscode.LanguageModelToolInvocationOptions<FgRunInput>,
    _token: vscode.CancellationToken,
  ): Promise<vscode.LanguageModelToolResult> {
    const { command, cwd } = options.input;
    this.log.info(`fg_run: ${command}${cwd ? ` (cwd: ${cwd})` : ''}`);

    const start = Date.now();
    const script = cwd ? `cd ${sq(cwd)} || exit 1\n${command}` : command;
    const { stdout, exitCode } = await shellExec(script);
    const duration = Date.now() - start;

    this.log.info(`fg_run complete: exit_code=${exitCode} duration=${duration}ms`);
    return new vscode.LanguageModelToolResult([
      new vscode.LanguageModelTextPart(`${stdout}\n[exit code: ${exitCode}]`),
    ]);
  }
}
