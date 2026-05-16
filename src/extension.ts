import * as vscode from 'vscode';
import { FgRunTool } from './fgRunTool';
import { BgLaunchTool, BgStatusTool, BgGetOutputTool, BgSendCmdTool, BgExitTool, BgListJobsTool } from './bg';

export function activate(context: vscode.ExtensionContext): void {
  const log = vscode.window.createOutputChannel('Terminal Bridge', { log: true });
  context.subscriptions.push(log);

  const reg = (name: string, tool: vscode.LanguageModelTool<any>) =>
    context.subscriptions.push(vscode.lm.registerTool(name, tool));

  reg('terminal_fg_run', new FgRunTool(log));
  reg('terminal_bg_launch', new BgLaunchTool(log));
  reg('terminal_bg_status', new BgStatusTool(log));
  reg('terminal_bg_get_output', new BgGetOutputTool(log));
  reg('terminal_bg_send_cmd', new BgSendCmdTool(log));
  reg('terminal_bg_exit', new BgExitTool(log));
  reg('terminal_bg_list_jobs', new BgListJobsTool(log));

  log.info('Terminal Bridge activated — 7 tools registered');
}
