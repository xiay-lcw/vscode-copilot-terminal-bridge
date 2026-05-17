import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Two patches that enable terminal-style tool rendering for extension tools:
 *
 * 1. Ext host (extensionHostProcess.js): forward toolSpecificData from
 *    prepareInvocation() through IPC. Without this, only 4 fields cross the
 *    wire (invocationMessage, pastTenseMessage, confirmationMessages, presentation).
 *
 * 2. Workbench (workbench.desktop.main.js): after invoke() completes, merge
 *    toolMetadata from the result into toolSpecificData on the invocation model.
 *    This lets the tool set output text and exit code after execution.
 */

const PATCH_MARKER = '/*terminal-bridge-patched*/';

// --- Patch 1: ext host — forward toolSpecificData from prepareInvocation ---
const EH_FIND = 'return{confirmationMessages:s.confirmationMessages?{title:typeof s.confirmationMessages.title=="string"?s.confirmationMessages.title:ge.from(s.confirmationMessages.title),message:typeof s.confirmationMessages.message=="string"?s.confirmationMessages.message:ge.from(s.confirmationMessages.message),approveCombination:l&&d?{label:l,key:d,arguments:a.arguments}:void 0}:void 0,invocationMessage:ge.fromStrict(s.invocationMessage),pastTenseMessage:ge.fromStrict(s.pastTenseMessage),presentation:s.presentation}';

const EH_REPLACE = 'return{confirmationMessages:s.confirmationMessages?{title:typeof s.confirmationMessages.title=="string"?s.confirmationMessages.title:ge.from(s.confirmationMessages.title),message:typeof s.confirmationMessages.message=="string"?s.confirmationMessages.message:ge.from(s.confirmationMessages.message),approveCombination:l&&d?{label:l,key:d,arguments:a.arguments}:void 0}:void 0,invocationMessage:ge.fromStrict(s.invocationMessage),pastTenseMessage:ge.fromStrict(s.pastTenseMessage),presentation:s.presentation,toolSpecificData:s.toolSpecificData}';

// --- Patch 2: workbench — merge toolMetadata into toolSpecificData after invoke ---
const WB_FIND = 'this.ensureToolDetails(e,v,g.data,c);let x=await c?.didExecuteTool';

const WB_REPLACE = 'this.ensureToolDetails(e,v,g.data,c);c&&c.toolSpecificData?.kind==="terminal"&&v?.toolMetadata&&Object.assign(c.toolSpecificData,v.toolMetadata);let x=await c?.didExecuteTool';

interface PatchTarget {
  name: string;
  path: string;
  backupPath: string;
  find: string;
  replace: string;
}

export class ExtHostPatcher {
  private readonly targets: PatchTarget[];
  private readonly log: vscode.LogOutputChannel;

  constructor(log: vscode.LogOutputChannel) {
    this.log = log;
    const appRoot = vscode.env.appRoot;

    const ehPath = path.join(appRoot, 'out', 'vs', 'workbench', 'api', 'node', 'extensionHostProcess.js');
    const wbPath = path.join(appRoot, 'out', 'vs', 'workbench', 'workbench.desktop.main.js');

    this.targets = [
      { name: 'ext-host', path: ehPath, backupPath: ehPath + '.terminal-bridge-backup', find: EH_FIND, replace: EH_REPLACE },
      { name: 'workbench', path: wbPath, backupPath: wbPath + '.terminal-bridge-backup', find: WB_FIND, replace: WB_REPLACE },
    ];
  }

  isPatched(): boolean {
    return this.targets.every(t => {
      try { return fs.readFileSync(t.path, 'utf8').includes(PATCH_MARKER); } catch { return false; }
    });
  }

  async ensurePatch(): Promise<boolean> {
    if (this.isPatched()) {
      this.log.info('[Patcher] Already patched');
      return false;
    }

    let applied = 0;
    for (const t of this.targets) {
      if (!fs.existsSync(t.path)) {
        this.log.warn(`[Patcher] ${t.name} bundle not found: ${t.path}`);
        continue;
      }

      let content = fs.readFileSync(t.path, 'utf8');
      if (content.includes(PATCH_MARKER)) { applied++; continue; }

      if (!content.includes(t.find)) {
        this.log.warn(`[Patcher] ${t.name}: target pattern not found — VS Code version may have changed`);
        continue;
      }

      if (!fs.existsSync(t.backupPath)) {
        fs.copyFileSync(t.path, t.backupPath);
        this.log.info(`[Patcher] ${t.name}: backup created`);
      }

      content = PATCH_MARKER + '\n' + content.replace(t.find, t.replace);
      const tmp = t.path + '.tmp-' + Date.now();
      fs.writeFileSync(tmp, content, 'utf8');
      fs.renameSync(tmp, t.path);
      this.log.info(`[Patcher] ${t.name}: patch applied`);
      applied++;
    }

    return applied > 0;
  }

  restore(): boolean {
    let restored = 0;
    for (const t of this.targets) {
      if (fs.existsSync(t.backupPath)) {
        fs.copyFileSync(t.backupPath, t.path);
        fs.unlinkSync(t.backupPath);
        this.log.info(`[Patcher] ${t.name}: restored from backup`);
        restored++;
      }
    }
    return restored > 0;
  }
}
