/**
 * App updates without Electron: when updates run, how updater events move the status, and the restart.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { UpdateView } from '../src/desktop/shared/api.ts';
import { nextStatus, updateController, updatesOffReason, type UpdateDeps, type Updater, type UpdaterEvent, type UpdateEnvironment } from '../src/desktop/main/updates.ts';

const installed: UpdateEnvironment = {
  packaged: true,
  platform: 'linux',
  appImage: '/home/me/Forge.AppImage',
  debPackage: false,
  feedConfigured: true,
  disabledByEnv: false,
};

type Script = { readonly check?: readonly UpdaterEvent[]; readonly install?: readonly UpdaterEvent[]; readonly checkFails?: string };

/** An updater that replays events: `check` on every check, `install` synchronously from install (as electron-updater reports a failed install). */
const scriptedUpdater = (script: Script): Updater & { readonly calls: { check: number; install: number } } => {
  let listener: (event: UpdaterEvent) => void = () => {};
  const calls = { check: 0, install: 0 };
  return {
    calls,
    check: async () => {
      calls.check += 1;
      if (script.checkFails) throw new Error(script.checkFails);
      for (const event of script.check ?? []) listener(event);
    },
    install: () => {
      calls.install += 1;
      for (const event of script.install ?? []) listener(event);
    },
    onEvent: (fn) => {
      listener = fn;
    },
  };
};

const DOWNLOAD: readonly UpdaterEvent[] = [
  { kind: 'checking' },
  { kind: 'available', version: '0.2.0' },
  { kind: 'progress', percent: 40.4 },
  { kind: 'downloaded', version: '0.2.0' },
];

const setup = (script: Script, patch: Partial<UpdateDeps> = {}) => {
  const updater = scriptedUpdater(script);
  const published: UpdateView[] = [];
  const restarts = { failed: 0 };
  const controller = updateController({
    version: '0.1.0',
    offReason: null,
    installs: true,
    releaseUrl: (v) => `https://example.test/releases/tag/v${v}`,
    updater,
    now: () => '2026-11-09T12:00:00.000Z',
    publish: (view) => published.push(view),
    allowRestart: () => true,
    restartFailed: () => {
      restarts.failed += 1;
    },
    ...patch,
  });
  return { controller, updater, published, restarts };
};

describe('when updates run', () => {
  it('runs in an installed AppImage or .deb, on Windows, and on macOS', () => {
    assert.equal(updatesOffReason(installed), null);
    assert.equal(updatesOffReason({ ...installed, appImage: undefined, debPackage: true }), null);
    assert.equal(updatesOffReason({ ...installed, platform: 'win32', appImage: undefined }), null);
    assert.equal(updatesOffReason({ ...installed, platform: 'darwin', appImage: undefined }), null);
  });

  it('is off from a checkout, without a feed, when turned off, and for Linux installs it cannot replace', () => {
    assert.match(updatesOffReason({ ...installed, packaged: false }) ?? '', /installed app/);
    assert.match(updatesOffReason({ ...installed, feedConfigured: false }) ?? '', /no update feed/);
    assert.match(updatesOffReason({ ...installed, disabledByEnv: true }) ?? '', /FORGE_DISABLE_AUTO_UPDATE/);
    assert.match(updatesOffReason({ ...installed, appImage: undefined }) ?? '', /AppImage or the \.deb/);
  });
});

describe('update status', () => {
  const ctx = { installs: true, releaseUrl: (v: string) => `r/${v}`, now: 'now' };

  it('keeps a downloaded update through later checks, failures and progress', () => {
    const ready = { kind: 'ready', version: '0.2.0' } as const;
    for (const event of [{ kind: 'checking' }, { kind: 'not-available' }, { kind: 'error', message: 'offline' }, { kind: 'progress', percent: 3 }] as const)
      assert.deepEqual(nextStatus(ready, event, ctx), ready);
    assert.deepEqual(nextStatus(ready, { kind: 'downloaded', version: '0.3.0' }, ctx), { kind: 'ready', version: '0.3.0' });
  });

  it('never leaves off', () => {
    const off = { kind: 'off', reason: 'dev' } as const;
    assert.equal(nextStatus(off, { kind: 'available', version: '9.9.9' }, ctx), off);
  });

  it('links to the release where the app cannot install in place', () => {
    assert.deepEqual(nextStatus({ kind: 'checking' }, { kind: 'available', version: '0.2.0' }, { ...ctx, installs: false }), {
      kind: 'manual',
      version: '0.2.0',
      url: 'r/0.2.0',
    });
  });
});

describe('update controller', () => {
  it('downloads an available update and offers the restart', async () => {
    const { controller, published } = setup({ check: DOWNLOAD });
    const view = await controller.check();
    assert.deepEqual(view.status, { kind: 'ready', version: '0.2.0' });
    assert.deepEqual(
      published.map((p) => p.status.kind),
      ['checking', 'downloading', 'downloading', 'ready'],
    );
    assert.deepEqual(published[2]?.status, { kind: 'downloading', version: '0.2.0', percent: 40 });
  });

  it('reports up to date, and a failed check, and checks again after a failure', async () => {
    const { controller, updater } = setup({ checkFails: 'feed unreachable' });
    assert.deepEqual((await controller.check()).status, { kind: 'failed', message: 'feed unreachable' });
    await controller.check();
    assert.equal(updater.calls.check, 2);

    const current = setup({ check: [{ kind: 'checking' }, { kind: 'not-available' }] });
    assert.deepEqual((await current.controller.check()).status, { kind: 'current', checkedAt: '2026-11-09T12:00:00.000Z' });
  });

  it('stops checking once an update waits for a restart', async () => {
    const { controller, updater } = setup({ check: DOWNLOAD });
    await controller.check();
    await controller.check();
    assert.equal(updater.calls.check, 1);
  });

  it('does nothing when updates are off', async () => {
    const { controller, updater } = setup({ check: DOWNLOAD }, { offReason: 'Updates run only in the installed app.' });
    assert.equal((await controller.check()).status.kind, 'off');
    assert.equal((await controller.restart()).ok, false);
    assert.deepEqual(updater.calls, { check: 0, install: 0 });
  });

  it('asks before installing, and installs nothing when the user keeps agents running', async () => {
    const { controller, updater } = setup({ check: DOWNLOAD }, { allowRestart: () => false });
    await controller.check();
    const outcome = await controller.restart();
    assert.equal(outcome.tone, 'info');
    assert.equal(updater.calls.install, 0);
    assert.equal(controller.view().status.kind, 'ready');
  });

  it('installs once the restart is allowed', async () => {
    const { controller, updater, restarts } = setup({ check: DOWNLOAD });
    await controller.check();
    const outcome = await controller.restart();
    assert.equal(outcome.ok, true);
    assert.equal(updater.calls.install, 1);
    assert.deepEqual(controller.view().status, { kind: 'installing', version: '0.2.0' });
    assert.equal(restarts.failed, 0);
  });

  it('keeps the update and re-arms the quit prompt when the installer fails', async () => {
    const { controller, restarts } = setup({ check: DOWNLOAD, install: [{ kind: 'error', message: 'pkexec was cancelled' }] });
    await controller.check();
    const outcome = await controller.restart();
    assert.equal(outcome.ok, false);
    assert.match(outcome.text, /pkexec was cancelled/);
    assert.deepEqual(controller.view().status, { kind: 'ready', version: '0.2.0', problem: 'pkexec was cancelled' });
    assert.equal(restarts.failed, 1);
  });

  it('refuses to restart before an update is downloaded', async () => {
    const { controller, updater } = setup({});
    assert.equal((await controller.restart()).ok, false);
    assert.equal(updater.calls.install, 0);
  });
});
