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
 *
 * 3. Ext host: forward toolSpecificData from progress.report() during invoke.
 *
 * 4. Workbench: merge toolSpecificData in acceptProgress() and trigger re-render
 *    so the terminal card shows streaming output during execution.
 *
 * 5. product.json: enable toolProgress proposed API for this extension.
 */

const PATCH_MARKER = '/*terminal-bridge-patched*/';
const PATCH_VERSION = 'v5'; // bump when adding/changing patches
const VERSIONED_MARKER = `${PATCH_MARKER}${PATCH_VERSION}`;
const EXTENSION_ID = 'terminal-bridge.terminal-bridge';

// --- Patch 1: ext host — forward toolSpecificData from prepareInvocation ---
const EH1_FIND = 'return{confirmationMessages:s.confirmationMessages?{title:typeof s.confirmationMessages.title=="string"?s.confirmationMessages.title:ge.from(s.confirmationMessages.title),message:typeof s.confirmationMessages.message=="string"?s.confirmationMessages.message:ge.from(s.confirmationMessages.message),approveCombination:l&&d?{label:l,key:d,arguments:a.arguments}:void 0}:void 0,invocationMessage:ge.fromStrict(s.invocationMessage),pastTenseMessage:ge.fromStrict(s.pastTenseMessage),presentation:s.presentation}';

const EH1_REPLACE = 'return{confirmationMessages:s.confirmationMessages?{title:typeof s.confirmationMessages.title=="string"?s.confirmationMessages.title:ge.from(s.confirmationMessages.title),message:typeof s.confirmationMessages.message=="string"?s.confirmationMessages.message:ge.from(s.confirmationMessages.message),approveCombination:l&&d?{label:l,key:d,arguments:a.arguments}:void 0}:void 0,invocationMessage:ge.fromStrict(s.invocationMessage),pastTenseMessage:ge.fromStrict(s.pastTenseMessage),presentation:s.presentation,toolSpecificData:s.toolSpecificData}';

// --- Patch 2: workbench — merge toolMetadata into toolSpecificData after invoke ---
const WB1_FIND = 'this.ensureToolDetails(e,v,g.data,c);let x=await c?.didExecuteTool';

const WB1_REPLACE = 'this.ensureToolDetails(e,v,g.data,c);c&&c.toolSpecificData?.kind==="terminal"&&v?.toolMetadata&&Object.assign(c.toolSpecificData,v.toolMetadata);let x=await c?.didExecuteTool';

// --- Patch 3: ext host — forward toolSpecificData from progress.report() ---
const EH2_FIND = 'this._proxy.$acceptToolProgress(t.callId,{message:ge.fromStrict(l.message),progress:a===void 0?void 0:a/100})';

const EH2_REPLACE = 'this._proxy.$acceptToolProgress(t.callId,{message:ge.fromStrict(l.message),progress:a===void 0?void 0:a/100,toolSpecificData:l.toolSpecificData})';

// --- Patch 4: workbench — merge toolSpecificData in acceptProgress + trigger re-render ---
const WB2_FIND = 'acceptProgress(i){let e=this._progress.get();this._progress.set({progress:i.progress||e.progress||0,message:i.message},void 0)}';

const WB2_REPLACE = 'acceptProgress(i){i.toolSpecificData&&this._toolSpecificData&&Object.assign(this._toolSpecificData,i.toolSpecificData);let e=this._progress.get();this._progress.set({progress:i.progress||e.progress||0,message:i.message},void 0)}';

// --- Patch 5: workbench — Nst._renderSnapshotOutput updates content when mirror exists ---
const WB3_FIND = '_renderSnapshotOutput(e){if(this._snapshotMirror){this._layoutOutput(e.lineCount??this._lastRenderedLineCount??0);return}';

const WB3_REPLACE = '_renderSnapshotOutput(e){if(this._snapshotMirror){this._snapshotMirror.setOutput(e),this._snapshotMirror.render().then(t=>{let n=t?.lineCount??e.lineCount??0;this._layoutOutput(n),this._isAtBottom&&this._scrollOutputToBottom()});return}';

// --- Patch 6: workbench — Nst._updateTerminalContent polls every 500ms during execution ---
const WB4_FIND = 'async _updateTerminalContent(){let e=await this._resolveLiveTerminal(),t=e?this._resolveCommand():void 0,o=this._getTerminalCommandOutput();if(!(e&&t&&await this._renderLiveOutput(e,t))){if(this._disposeLiveMirror(),o){await this._renderSnapshotOutput(o);return}this._hasTerminalSession&&this._renderUnavailableMessage(e)}}';

const WB4_REPLACE = 'async _updateTerminalContent(){let e=await this._resolveLiveTerminal(),t=e?this._resolveCommand():void 0,o=this._getTerminalCommandOutput();if(!(e&&t&&await this._renderLiveOutput(e,t))){if(this._disposeLiveMirror(),o){await this._renderSnapshotOutput(o)}else this._hasTerminalSession&&this._renderUnavailableMessage(e)}if(!this._store.isDisposed&&!e)setTimeout(()=>{this._store.isDisposed||this._updateTerminalContent()},500)}';

interface PatchDef { find: string; replace: string }

interface PatchTarget {
  name: string;
  path: string;
  backupPath: string;
  patches: PatchDef[];
}

export class ExtHostPatcher {
  private readonly targets: PatchTarget[];
  private readonly productJsonPath: string;
  private readonly log: vscode.LogOutputChannel;

  constructor(log: vscode.LogOutputChannel) {
    this.log = log;
    const appRoot = vscode.env.appRoot;
    const ehPath = path.join(appRoot, 'out', 'vs', 'workbench', 'api', 'node', 'extensionHostProcess.js');
    const wbPath = path.join(appRoot, 'out', 'vs', 'workbench', 'workbench.desktop.main.js');
    this.productJsonPath = path.join(appRoot, 'product.json');

    this.targets = [
      {
        name: 'ext-host', path: ehPath, backupPath: ehPath + '.terminal-bridge-backup',
        patches: [
          { find: EH1_FIND, replace: EH1_REPLACE },
          { find: EH2_FIND, replace: EH2_REPLACE },
        ],
      },
      {
        name: 'workbench', path: wbPath, backupPath: wbPath + '.terminal-bridge-backup',
        patches: [
          { find: WB1_FIND, replace: WB1_REPLACE },
          { find: WB2_FIND, replace: WB2_REPLACE },
          { find: WB3_FIND, replace: WB3_REPLACE },
          { find: WB4_FIND, replace: WB4_REPLACE },
        ],
      },
    ];
  }

  isPatched(): boolean {
    return this.targets.every(t => {
      try { return fs.readFileSync(t.path, 'utf8').includes(VERSIONED_MARKER); } catch { return false; }
    });
  }

  async ensurePatch(): Promise<boolean> {
    let needsRestart = this.ensureProductJson();

    if (this.isPatched()) {
      this.log.info('[Patcher] Already patched');
      return needsRestart;
    }

    // Stale marker from older patch version — restore from backup first
    for (const t of this.targets) {
      try {
        const content = fs.readFileSync(t.path, 'utf8');
        if (content.includes(PATCH_MARKER) && !content.includes(VERSIONED_MARKER) && fs.existsSync(t.backupPath)) {
          fs.copyFileSync(t.backupPath, t.path);
          this.log.info(`[Patcher] ${t.name}: restored stale patch from backup`);
        }
      } catch {}
    }

    for (const t of this.targets) {
      if (!fs.existsSync(t.path)) {
        this.log.warn(`[Patcher] ${t.name} bundle not found: ${t.path}`);
        continue;
      }

      let content = fs.readFileSync(t.path, 'utf8');
      if (content.includes(VERSIONED_MARKER)) continue;

      if (!fs.existsSync(t.backupPath)) {
        fs.copyFileSync(t.path, t.backupPath);
        this.log.info(`[Patcher] ${t.name}: backup created`);
      }

      let applied = 0;
      for (const p of t.patches) {
        if (content.includes(p.find)) {
          content = content.replace(p.find, p.replace);
          applied++;
        } else {
          this.log.warn(`[Patcher] ${t.name}: pattern not found (may be VS Code version change)`);
        }
      }

      if (applied > 0) {
        content = VERSIONED_MARKER + '\n' + content;
        const tmp = t.path + '.tmp-' + Date.now();
        fs.writeFileSync(tmp, content, 'utf8');
        fs.renameSync(tmp, t.path);
        this.log.info(`[Patcher] ${t.name}: ${applied} patches applied`);
        needsRestart = true;
      }
    }

    return needsRestart;
  }

  private ensureProductJson(): boolean {
    try {
      if (!fs.existsSync(this.productJsonPath)) return false;
      const product = JSON.parse(fs.readFileSync(this.productJsonPath, 'utf8'));
      const eap: Record<string, string[]> = product.extensionEnabledApiProposals ?? {};
      const needed = ['toolProgress'];
      const current = eap[EXTENSION_ID] ?? [];
      const missing = needed.filter(p => !current.includes(p));
      if (missing.length === 0) return false;
      eap[EXTENSION_ID] = [...current, ...missing];
      product.extensionEnabledApiProposals = eap;
      fs.writeFileSync(this.productJsonPath, JSON.stringify(product, null, '\t'), 'utf8');
      this.log.info(`[Patcher] product.json: added ${missing.join(', ')} for ${EXTENSION_ID}`);
      return true;
    } catch (e) {
      this.log.warn(`[Patcher] product.json patch failed: ${e}`);
      return false;
    }
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
