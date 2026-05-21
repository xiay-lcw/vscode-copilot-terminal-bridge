import * as fs from 'fs';
import * as path from 'path';
import { homedir } from 'os';
import { ProfileConfig } from './transport';

const PROFILES_DIR = path.join(homedir(), '.config', 'terminal-bridge', 'profiles');
const NAME_RE = /^[a-zA-Z0-9_-]+$/;

function validate(name: string): void {
  if (!NAME_RE.test(name)) throw new Error(`Invalid profile name: '${name}' (alphanumeric, dash, underscore only)`);
}

function profilePath(name: string): string {
  validate(name);
  return path.join(PROFILES_DIR, `${name}.json`);
}

export function ensureProfilesDir(): void {
  fs.mkdirSync(PROFILES_DIR, { recursive: true });
}

export function getProfilesDir(): string { return PROFILES_DIR; }

export function listProfiles(): string[] {
  ensureProfilesDir();
  return fs.readdirSync(PROFILES_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace(/\.json$/, ''));
}

export function readProfile(name: string): ProfileConfig | null {
  try {
    return JSON.parse(fs.readFileSync(profilePath(name), 'utf8'));
  } catch {
    return null;
  }
}

export function writeProfile(name: string, config: ProfileConfig): void {
  ensureProfilesDir();
  fs.writeFileSync(profilePath(name), JSON.stringify(config, null, 2), 'utf8');
}

export function deleteProfile(name: string): boolean {
  try { fs.unlinkSync(profilePath(name)); return true; } catch { return false; }
}
