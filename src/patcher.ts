import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Patches the VS Code ext host to forward toolSpecificData from
 * prepareInvocation() through the IPC boundary.
 *
 * Without this patch, extension-registered tools cannot set toolSpecificData
 * (only invocationMessage, pastTenseMessage, confirmationMessages, presentation
 * are forwarded). The main thread ALREADY handles toolSpecificData — this patch
 * simply removes the ext host serialization gap.
 */

const PATCH_MARKER = '/*terminal-bridge-patched*/';

const FIND = 'return{confirmationMessages:s.confirmationMessages?{title:typeof s.confirmationMessages.title=="string"?s.confirmationMessages.title:ge.from(s.confirmationMessages.title),message:typeof s.confirmationMessages.message=="string"?s.confirmationMessages.message:ge.from(s.confirmationMessages.message),approveCombination:l&&d?{label:l,key:d,arguments:a.arguments}:void 0}:void 0,invocationMessage:ge.fromStrict(s.invocationMessage),pastTenseMessage:ge.fromStrict(s.pastTenseMessage),presentation:s.presentation}';

const REPLACE = 'return{confirmationMessages:s.confirmationMessages?{title:typeof s.confirmationMessages.title=="string"?s.confirmationMessages.title:ge.from(s.confirmationMessages.title),message:typeof s.confirmationMessages.message=="string"?s.confirmationMessages.message:ge.from(s.confirmationMessages.message),approveCombination:l&&d?{label:l,key:d,arguments:a.arguments}:void 0}:void 0,invocationMessage:ge.fromStrict(s.invocationMessage),pastTenseMessage:ge.fromStrict(s.pastTenseMessage),presentation:s.presentation,toolSpecificData:s.toolSpecificData}';

export class ExtHostPatcher {
  private readonly bundlePath: string;
  private readonly backupPath: string;
  private readonly log: vscode.LogOutputChannel;

  constructor(log: vscode.LogOutputChannel) {
    this.log = log;
    const appRoot = vscode.env.appRoot;
    this.bundlePath = path.join(appRoot, 'out', 'vs', 'workbench', 'api', 'node', 'extensionHostProcess.js');
    this.backupPath = this.bundlePath + '.terminal-bridge-backup';
  }

  isPatched(): boolean {
    try {
      return fs.readFileSync(this.bundlePath, 'utf8').includes(PATCH_MARKER);
    } catch {
      return false;
    }
  }

  async ensurePatch(): Promise<boolean> {
    if (!fs.existsSync(this.bundlePath)) {
      this.log.warn(`[Patcher] Ext host bundle not found: ${this.bundlePath}`);
      return false;
    }

    if (this.isPatched()) {
      this.log.info('[Patcher] Already patched');
      return false;
    }

    let content = fs.readFileSync(this.bundlePath, 'utf8');

    if (!content.includes(FIND)) {
      this.log.warn('[Patcher] Target code pattern not found — VS Code version may have changed');
      return false;
    }

    // Backup
    if (!fs.existsSync(this.backupPath)) {
      fs.copyFileSync(this.bundlePath, this.backupPath);
      this.log.info('[Patcher] Backup created');
    }

    content = content.replace(FIND, REPLACE);
    content = PATCH_MARKER + '\n' + content;

    const tempPath = this.bundlePath + '.tmp-' + Date.now();
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, this.bundlePath);

    this.log.info('[Patcher] Patch applied — toolSpecificData now forwarded through ext host IPC');
    return true;
  }

  restore(): boolean {
    if (fs.existsSync(this.backupPath)) {
      fs.copyFileSync(this.backupPath, this.bundlePath);
      fs.unlinkSync(this.backupPath);
      this.log.info('[Patcher] Restored from backup');
      return true;
    }
    return false;
  }
}
