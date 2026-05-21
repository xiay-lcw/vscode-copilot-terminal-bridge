import * as vscode from 'vscode';
import { FgRunTool } from './fgRunTool';
import { BgLaunchTool, BgStatusTool, BgGetOutputTool, BgSendCmdTool, BgExitTool, BgListJobsTool } from './bg';
import { ExtHostPatcher } from './patcher';
import { Transport, createTransport, createDefaultTransport } from './transport';
import { readProfile, ensureProfilesDir } from './profiles';
import { ProfileListTool, ProfileGetTool, ProfileSetTool, ProfileDeleteTool } from './profileTools';

const transportCache = new Map<string, Transport>();

function makeResolver(log: vscode.LogOutputChannel) {
  return (profileName?: string): Transport => {
    const name = profileName || 'default';
    const cached = transportCache.get(name);
    if (cached) return cached;

    const config = readProfile(name);
    if (config) {
      const t = createTransport(name, config);
      transportCache.set(name, t);
      log.info(`Transport created: ${name} (${t.type})`);
      return t;
    }

    if (name === 'default') {
      const t = createDefaultTransport();
      transportCache.set(name, t);
      log.info(`Default transport: ${t.type}`);
      return t;
    }

    throw new Error(`Profile '${name}' not found. Use terminal_profile_list to see available profiles.`);
  };
}

function invalidateCache(name: string): void {
  const t = transportCache.get(name);
  if (t) { t.dispose(); transportCache.delete(name); }
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = vscode.window.createOutputChannel('Terminal Bridge', { log: true });
  context.subscriptions.push(log);

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

  ensureProfilesDir();
  const resolve = makeResolver(log);

  const reg = (name: string, tool: vscode.LanguageModelTool<any>) =>
    context.subscriptions.push(vscode.lm.registerTool(name, tool));

  reg('terminal_fg_run', new FgRunTool(log, resolve));
  reg('terminal_bg_launch', new BgLaunchTool(log, resolve));
  reg('terminal_bg_status', new BgStatusTool(log, resolve));
  reg('terminal_bg_get_output', new BgGetOutputTool(log, resolve));
  reg('terminal_bg_send_cmd', new BgSendCmdTool(log, resolve));
  reg('terminal_bg_exit', new BgExitTool(log, resolve));
  reg('terminal_bg_list_jobs', new BgListJobsTool(log, resolve));

  reg('terminal_profile_list', new ProfileListTool());
  reg('terminal_profile_get', new ProfileGetTool());
  reg('terminal_profile_set', new ProfileSetTool(invalidateCache));
  reg('terminal_profile_delete', new ProfileDeleteTool(invalidateCache));

  context.subscriptions.push(vscode.commands.registerCommand('terminal-bridge.testChat', async () => {
    await vscode.commands.executeCommand('workbench.action.chat.newChat');
    await new Promise(r => setTimeout(r, 500));
    await vscode.commands.executeCommand('workbench.action.chat.open', {
      query: 'use #run to execute: echo LINE1 && sleep 3 && echo LINE2 && sleep 3 && echo LINE3',
      isPartialQuery: false,
    });
  }));

  context.subscriptions.push({
    dispose: () => transportCache.forEach(t => t.dispose()),
  });

  log.info('Terminal Bridge activated — 11 tools registered');
}
