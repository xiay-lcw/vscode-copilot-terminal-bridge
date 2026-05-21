import * as vscode from 'vscode';
import { FgRunTool } from './fgRunTool';
import { BgLaunchTool, BgStatusTool, BgGetOutputTool, BgSendCmdTool, BgExitTool, BgListJobsTool } from './bg';
import { ExtHostPatcher } from './patcher';
import { Transport, ProfileConfig, createTransport, createDefaultTransport } from './transport';

let activeTransport: Transport;

function resolveTransport(log: vscode.LogOutputChannel): Transport {
  const cfg = vscode.workspace.getConfiguration('terminal-bridge');
  const profiles: Record<string, ProfileConfig> = cfg.get('profiles') ?? {};
  const activeName: string = cfg.get('activeProfile') ?? '';

  if (activeName && profiles[activeName]) {
    log.info(`Using profile: ${activeName} (${profiles[activeName].type})`);
    return createTransport(activeName, profiles[activeName]);
  }
  const t = createDefaultTransport();
  log.info(`Using default transport: ${t.type}`);
  return t;
}

function getProfileNames(): string[] {
  const profiles: Record<string, ProfileConfig> =
    vscode.workspace.getConfiguration('terminal-bridge').get('profiles') ?? {};
  return Object.keys(profiles);
}

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

  // Initialize transport
  activeTransport = resolveTransport(log);
  const getTransport = () => activeTransport;

  // Register tools
  const reg = (name: string, tool: vscode.LanguageModelTool<any>) =>
    context.subscriptions.push(vscode.lm.registerTool(name, tool));

  reg('terminal_fg_run', new FgRunTool(log, getTransport));
  reg('terminal_bg_launch', new BgLaunchTool(log, getTransport));
  reg('terminal_bg_status', new BgStatusTool(log, getTransport));
  reg('terminal_bg_get_output', new BgGetOutputTool(log, getTransport));
  reg('terminal_bg_send_cmd', new BgSendCmdTool(log, getTransport));
  reg('terminal_bg_exit', new BgExitTool(log, getTransport));
  reg('terminal_bg_list_jobs', new BgListJobsTool(log, getTransport));

  // Status bar — shows active profile
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'terminal-bridge.switchProfile';
  statusBar.tooltip = 'Terminal Bridge: Switch Profile';
  const updateStatusBar = () => {
    statusBar.text = `$(terminal) ${activeTransport.name}`;
  };
  updateStatusBar();
  statusBar.show();
  context.subscriptions.push(statusBar);

  // Switch profile command
  context.subscriptions.push(vscode.commands.registerCommand('terminal-bridge.switchProfile', async () => {
    const names = getProfileNames();
    if (names.length === 0) {
      vscode.window.showInformationMessage('No profiles configured. Add profiles in terminal-bridge.profiles setting.');
      return;
    }
    const picked = await vscode.window.showQuickPick(names, { placeHolder: 'Select terminal profile' });
    if (!picked) return;
    const profiles: Record<string, ProfileConfig> =
      vscode.workspace.getConfiguration('terminal-bridge').get('profiles') ?? {};
    activeTransport.dispose();
    activeTransport = createTransport(picked, profiles[picked]);
    await vscode.workspace.getConfiguration('terminal-bridge').update('activeProfile', picked, vscode.ConfigurationTarget.Global);
    updateStatusBar();
    log.info(`Switched to profile: ${picked} (${activeTransport.type})`);
  }));

  // React to config changes
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('terminal-bridge.profiles') || e.affectsConfiguration('terminal-bridge.activeProfile')) {
      activeTransport.dispose();
      activeTransport = resolveTransport(log);
      updateStatusBar();
    }
  }));

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

  // Dispose transport on deactivation
  context.subscriptions.push({ dispose: () => activeTransport.dispose() });

  log.info(`Terminal Bridge activated — 7 tools registered, profile: ${activeTransport.name} (${activeTransport.type})`);
}
