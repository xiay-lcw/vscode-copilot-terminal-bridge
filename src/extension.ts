import * as vscode from 'vscode';
import { FgRunTool } from './fgRunTool';
import { BgLaunchTool, BgStatusTool, BgGetOutputTool, BgSendCmdTool, BgExitTool, BgListJobsTool } from './bg';
import { ExtHostPatcher } from './patcher';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('Terminal Bridge', { log: true });
  context.subscriptions.push(log);

  // Patch ext host to forward toolSpecificData through IPC
  const patcher = new ExtHostPatcher(log);
  const patched = await patcher.ensurePatch();
  if (patched) {
    vscode.window.showInformationMessage(
      'Terminal Bridge: ext host patched for terminal rendering. Restart to apply.',
      'Restart Now',
    ).then(choice => {
      if (choice === 'Restart Now') {
        vscode.commands.executeCommand('workbench.action.reloadWindow');
      }
    });
  }

  const reg = (name: string, tool: vscode.LanguageModelTool<any>) =>
    context.subscriptions.push(vscode.lm.registerTool(name, tool));

  reg('terminal_fg_run', new FgRunTool(log));
  reg('terminal_bg_launch', new BgLaunchTool(log));
  reg('terminal_bg_status', new BgStatusTool(log));
  reg('terminal_bg_get_output', new BgGetOutputTool(log));
  reg('terminal_bg_send_cmd', new BgSendCmdTool(log));
  reg('terminal_bg_exit', new BgExitTool(log));
  reg('terminal_bg_list_jobs', new BgListJobsTool(log));

  // Temporary harness test command — triggers our tool via #run reference
  context.subscriptions.push(vscode.commands.registerCommand('terminal-bridge.testChat', async () => {
    await vscode.commands.executeCommand('workbench.action.chat.newChat');
    // Small delay to let new chat open
    await new Promise(r => setTimeout(r, 500));
    await vscode.commands.executeCommand('workbench.action.chat.open', {
      query: 'use #run to execute: echo LINE1 && sleep 3 && echo LINE2 && sleep 3 && echo LINE3',
      isPartialQuery: false,
    });
  }));

  log.info('Terminal Bridge activated — 7 tools registered');
}
