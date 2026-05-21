import * as vscode from 'vscode';
import { listProfiles, readProfile, writeProfile, deleteProfile, getProfilesDir } from './profiles';
import { ProfileConfig } from './transport';

function txt(s: string): vscode.LanguageModelToolResult {
  return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(s)]);
}

// ---------------------------------------------------------------------------
// terminal_profile_list
// ---------------------------------------------------------------------------

export class ProfileListTool implements vscode.LanguageModelTool<Record<string, never>> {
  async invoke(): Promise<vscode.LanguageModelToolResult> {
    const names = listProfiles();
    if (names.length === 0) return txt(`profiles_dir: ${getProfilesDir()}\ncount: 0`);
    const lines = names.map(n => {
      const cfg = readProfile(n);
      return cfg?.type === 'ssh' ? `${n}: ssh (${cfg.host})` : `${n}: ${cfg?.type ?? 'unknown'}`;
    });
    return txt(`profiles_dir: ${getProfilesDir()}\n${lines.join('\n')}\ncount: ${names.length}`);
  }
}

// ---------------------------------------------------------------------------
// terminal_profile_get
// ---------------------------------------------------------------------------

interface GetInput { name: string }

export class ProfileGetTool implements vscode.LanguageModelTool<GetInput> {
  async invoke(opts: vscode.LanguageModelToolInvocationOptions<GetInput>): Promise<vscode.LanguageModelToolResult> {
    const { name } = opts.input;
    const cfg = readProfile(name);
    if (!cfg) return txt(`ok: false\nerror: Profile '${name}' not found`);
    return txt(`ok: true\nname: ${name}\n${JSON.stringify(cfg, null, 2)}`);
  }
}

// ---------------------------------------------------------------------------
// terminal_profile_set
// ---------------------------------------------------------------------------

interface SetInput {
  name: string;
  type: string;
  host?: string;
  port?: number;
  user?: string;
  identityFile?: string;
  distribution?: string;
}

export class ProfileSetTool implements vscode.LanguageModelTool<SetInput> {
  constructor(private readonly onInvalidate: (name: string) => void) {}

  async invoke(opts: vscode.LanguageModelToolInvocationOptions<SetInput>): Promise<vscode.LanguageModelToolResult> {
    const { name, ...rest } = opts.input;
    try {
      writeProfile(name, rest as ProfileConfig);
      this.onInvalidate(name);
      return txt(`ok: true\nprofile: ${name}\ntype: ${rest.type}`);
    } catch (e: any) {
      return txt(`ok: false\nerror: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// terminal_profile_delete
// ---------------------------------------------------------------------------

interface DeleteInput { name: string }

export class ProfileDeleteTool implements vscode.LanguageModelTool<DeleteInput> {
  constructor(private readonly onInvalidate: (name: string) => void) {}

  async invoke(opts: vscode.LanguageModelToolInvocationOptions<DeleteInput>): Promise<vscode.LanguageModelToolResult> {
    const { name } = opts.input;
    const ok = deleteProfile(name);
    if (ok) this.onInvalidate(name);
    return txt(ok ? `ok: true\ndeleted: ${name}` : `ok: false\nerror: Profile '${name}' not found`);
  }
}
