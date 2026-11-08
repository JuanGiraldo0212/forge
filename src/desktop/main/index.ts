/**
 * Electron main process: windows, IPC, and the workspace backend. All forge logic (agents, git, files)
 * runs here, in Node, or on an SSH host the app is connected to; the renderer only talks to it through
 * the validated ForgeApi.
 */
import { app, BrowserWindow, dialog, ipcMain, safeStorage, session as electronSession, shell } from 'electron';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startRemote } from '../remote/client.ts';
import { channel, CONNECTION_METHODS, EVENTS, METHODS } from '../shared/api.ts';
import { workspaceBackend } from './backend.ts';
import { runCaptureScript } from './capture.ts';
import { connectionManager } from './connection.ts';
import { loadServerBundle } from './serverBundle.ts';
import { fileSettings } from './settings.ts';
import { fixPath } from './shellEnv.ts';

const here = fileURLToPath(new URL('.', import.meta.url));

/**
 * In a packaged app the SDK's native binary sits in app.asar, where it cannot be executed.
 * electron-builder unpacks it (asarUnpack); point the SDK at the unpacked copy.
 */
const agentExecutable = (): string | undefined => {
  if (!app.isPackaged) return undefined;
  try {
    const pkg = createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`);
    return join(dirname(pkg), process.platform === 'win32' ? 'claude.exe' : 'claude').replace(/app\.asar([\\/])/, 'app.asar.unpacked$1');
  } catch {
    return undefined;
  }
};

let window: BrowserWindow | undefined;

const send = (event: string, payload?: unknown) => {
  if (window && !window.isDestroyed()) window.webContents.send(event, payload);
};

const settings = fileSettings(join(app.getPath('userData'), 'forge-settings.json'), {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain),
  decrypt: (cipher) => safeStorage.decryptString(cipher),
});

const chooseFolder = async (title: string) => {
  const result = await dialog.showOpenDialog(window!, { title, properties: ['openDirectory'] });
  return result.canceled ? undefined : result.filePaths[0];
};

const local = workspaceBackend({
  settings,
  chooseFolder,
  openExternal: (url) => shell.openExternal(url),
  // While connected to a host, the UI shows the host's workspace; local events would only confuse it.
  events: {
    epicsChanged: () => !connections.isRemote() && send(EVENTS.epicsChanged),
    busy: (busy) => !connections.isRemote() && send(EVENTS.busy, busy),
    opened: (info) => !connections.isRemote() && window?.setTitle(`forge — ${info.name}`),
  },
  agentExecutable: agentExecutable(),
});

const connections = connectionManager({
  settings,
  local,
  bundle: () => loadServerBundle(here),
  start: startRemote,
  readFile: (path) => readFile(path),
  env: process.env,
  send: (event, payload) => send(EVENTS[event], payload),
  shown: (workspace, connection) =>
    window?.setTitle(['forge', workspace?.name, connection.kind === 'remote' ? connection.label : undefined].filter(Boolean).join(' — ')),
  log: (line) => console.warn(line),
});

for (const method of [...METHODS, ...CONNECTION_METHODS]) {
  ipcMain.handle(channel(method), (event, ...args: unknown[]) => {
    // Only our own window may call in.
    if (event.sender !== window?.webContents) throw new Error('Unknown sender');
    return connections.dispatch(method, args);
  });
}

const createWindow = () => {
  window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 960,
    minHeight: 600,
    title: 'forge',
    backgroundColor: '#111316',
    show: false,
    webPreferences: {
      preload: join(here, '../preload/index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: true,
    },
  });
  window.once('ready-to-show', () => window?.show());

  // Links open in the browser; the app window never navigates away or opens new windows.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (e, url) => {
    if (url !== window?.webContents.getURL()) e.preventDefault();
  });

  if (process.env.ELECTRON_RENDERER_URL) void window.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void window.loadFile(join(here, '../renderer/index.html'));
};

/** Agents run in this process: quitting stops them, so ask first. */
let quitting = false;
app.on('before-quit', (e) => {
  const busy = connections.busy();
  if (quitting || busy.length === 0 || process.env.FORGE_DESKTOP_CAPTURE) return;
  const where = connections.connection();
  e.preventDefault();
  const choice = dialog.showMessageBoxSync(window!, {
    type: 'warning',
    buttons: ['Keep running', 'Stop agents and quit'],
    defaultId: 0,
    cancelId: 0,
    message: `Agents are running on ${busy.join(', ')}${where.kind === 'remote' ? ` (on ${where.label})` : ''}.`,
    detail: 'Quitting stops them. Interrupted changes are handed back to you the next time you run them.',
  });
  if (choice === 1) {
    quitting = true;
    connections.close();
    app.quit();
  }
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin' || process.env.FORGE_DESKTOP_CAPTURE) app.quit();
});

app.whenReady().then(async () => {
  await fixPath();

  if (app.isPackaged) {
    // Strict CSP for the bundled renderer: no remote code, no inline scripts, no eval.
    electronSession.defaultSession.webRequest.onHeadersReceived((details, callback) => {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
          ],
        },
      });
    });
  }
  // The app never needs camera, microphone, notifications from pages, etc.
  electronSession.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));

  const initial = process.env.FORGE_WORKSPACE ?? (await settings.recent())[0];
  if (initial) await local.dispatch('openWorkspace', [initial]);

  createWindow();
  if (process.env.FORGE_DESKTOP_CAPTURE && window) void runCaptureScript(window, process.env.FORGE_DESKTOP_CAPTURE).finally(() => app.exit(0));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
