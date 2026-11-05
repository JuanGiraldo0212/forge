#!/usr/bin/env node
// Opens the forge desktop app from this checkout: `npm start` or `npm start -- <workspace path>`.
// Run after `npm run desktop:build` (npm start does that for you).
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron');

const read = (path) => {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return undefined;
  }
};

/**
 * Recent Ubuntu blocks the unprivileged user namespaces Chromium's sandbox needs, and the fallback
 * setuid helper is not root-owned after npm installs it, so Electron aborts with SIGTRAP. Say how to
 * fix it instead. Never fall back to --no-sandbox: the window shows agent-written content.
 */
const sandboxProblem = () => {
  if (process.platform !== 'linux') return undefined;
  if (read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') !== '1') return undefined;
  const helper = join(dirname(electron), 'chrome-sandbox');
  const st = existsSync(helper) ? statSync(helper) : undefined;
  if (st && st.uid === 0 && (st.mode & 0o4000) !== 0) return undefined;
  if (read('/etc/apparmor.d/forge-electron')?.includes(electron)) return undefined;
  return `Electron's sandbox can't start: this system restricts unprivileged user namespaces (AppArmor), and ${helper} is not setuid root.
Fix it once with an AppArmor profile (recommended):

  sudo tee /etc/apparmor.d/forge-electron >/dev/null <<'EOF'
  abi <abi/4.0>,
  include <tunables/global>
  profile forge-electron ${electron} flags=(unconfined) {
    userns,
    include if exists <local/forge-electron>
  }
  EOF
  sudo apparmor_parser -r /etc/apparmor.d/forge-electron

or make the helper setuid root (undone by the next npm install):

  sudo chown root:root ${helper} && sudo chmod 4755 ${helper}`;
};

if (!existsSync(join(root, 'out', 'main', 'index.js'))) {
  console.error('forge: the app is not built. Run "npm run desktop:build" first.');
  process.exit(1);
}
const problem = sandboxProblem();
if (problem) {
  console.error(`forge: ${problem}`);
  process.exit(1);
}

const workspace = process.argv[2] ? resolve(process.argv[2]) : undefined;
const child = spawn(electron, [root], {
  stdio: 'inherit',
  env: { ...process.env, ...(workspace ? { FORGE_WORKSPACE: workspace } : {}) },
});
child.on('exit', (code) => process.exit(code ?? 0));
