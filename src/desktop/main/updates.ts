/**
 * App updates: when to check, what each updater event means, and when the app may restart to install.
 * Electron-free, so tests drive it with a scripted updater; electronUpdater.ts is the real one.
 */
import type { Outcome } from '../../ui/actions.ts';
import { canCheckForUpdates, type UpdateMethod, type UpdateStatus, type UpdateView } from '../shared/api.ts';

/** What the updater reports, decoded from electron-updater's events. */
export type UpdaterEvent =
  | { readonly kind: 'checking' }
  | { readonly kind: 'available'; readonly version: string }
  | { readonly kind: 'not-available' }
  | { readonly kind: 'progress'; readonly percent: number }
  | { readonly kind: 'downloaded'; readonly version: string }
  | { readonly kind: 'error'; readonly message: string };

export type Updater = {
  /** Checks the feed; where the platform installs in place, an available update downloads on its own. */
  readonly check: () => Promise<void>;
  /** Starts the installer and quits the app. A failure arrives as an `error` event, and the app keeps running. */
  readonly install: () => void;
  readonly onEvent: (listener: (event: UpdaterEvent) => void) => void;
};

/** For installs where updates are off: nothing to check, nothing to install. */
export const noUpdater: Updater = { check: async () => {}, install: () => {}, onEvent: () => {} };

export type UpdateEnvironment = {
  readonly packaged: boolean;
  readonly platform: NodeJS.Platform;
  /** Set by the AppImage runtime to the AppImage's path. */
  readonly appImage: string | undefined;
  /** electron-builder marks a .deb install with resources/package-type = "deb". */
  readonly debPackage: boolean;
  /** electron-builder writes resources/app-update.yml when the build has a publish config. */
  readonly feedConfigured: boolean;
  readonly disabledByEnv: boolean;
};

/** Why updates are off on this install, or null when they run. */
export const updatesOffReason = (env: UpdateEnvironment): string | null => {
  if (!env.packaged) return 'Updates run only in the installed app, not from a checkout.';
  if (env.disabledByEnv) return 'Updates are turned off by FORGE_DISABLE_AUTO_UPDATE.';
  if (!env.feedConfigured) return 'This build has no update feed.';
  if (env.platform === 'linux' && !env.appImage && !env.debPackage) return 'Updates on Linux need the AppImage or the .deb package.';
  return null;
};

/**
 * macOS refuses to install an update into an unsigned app (Squirrel.Mac checks the code signature), and
 * releases aren't signed yet. There the app links to the release instead. Signing would make this true.
 */
export const installsInPlace = (platform: NodeJS.Platform): boolean => platform !== 'darwin';

type StepContext = { readonly installs: boolean; readonly releaseUrl: (version: string) => string; readonly now: string };

type Steps = { readonly [K in UpdaterEvent['kind']]: (status: UpdateStatus, event: Extract<UpdaterEvent, { kind: K }>, ctx: StepContext) => UpdateStatus };

const STEPS: Steps = {
  checking: () => ({ kind: 'checking' }),
  available: (_status, { version }, ctx) =>
    ctx.installs ? { kind: 'downloading', version, percent: 0 } : { kind: 'manual', version, url: ctx.releaseUrl(version) },
  'not-available': (_status, _event, ctx) => ({ kind: 'current', checkedAt: ctx.now }),
  progress: (status, { percent }) => {
    if (status.kind !== 'downloading' || Math.round(percent) === status.percent) return status;
    return { ...status, percent: Math.round(percent) };
  },
  downloaded: (_status, { version }) => ({ kind: 'ready', version }),
  error: (status, { message }) => {
    if (status.kind === 'installing') return { kind: 'ready', version: status.version, problem: message };
    return { kind: 'failed', message };
  },
};

/**
 * Once an update is downloaded, only a newer download replaces it, so the restart offer never flickers
 * away; an install in progress ends only by failing.
 */
const ignores = (status: UpdateStatus, event: UpdaterEvent): boolean => {
  if (status.kind === 'off') return true;
  if (status.kind === 'ready') return event.kind !== 'downloaded';
  if (status.kind === 'installing') return event.kind !== 'error';
  return false;
};

/** The status after an updater event. */
export const nextStatus = (status: UpdateStatus, event: UpdaterEvent, ctx: StepContext): UpdateStatus => {
  if (ignores(status, event)) return status;
  // A mapped dispatch table loses the per-key event type at the lookup; STEPS itself is checked per key.
  const step = STEPS[event.kind] as (status: UpdateStatus, event: UpdaterEvent, ctx: StepContext) => UpdateStatus;
  return step(status, event, ctx);
};

export type UpdateDeps = {
  readonly version: string;
  readonly offReason: string | null;
  readonly installs: boolean;
  readonly releaseUrl: (version: string) => string;
  readonly updater: Updater;
  readonly now: () => string;
  /** To the renderer, on every change. */
  readonly publish: (view: UpdateView) => void;
  /**
   * Asks about running agents, if any. True means the app may quit now without asking again. It runs
   * before the installer starts: electron-updater launches the installer first and quits after, so a
   * "Keep running" answer in before-quit would come too late.
   */
  readonly allowRestart: () => boolean;
  /** The installer didn't start and the app keeps running: quitting must ask about agents again. */
  readonly restartFailed: () => void;
};

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export const updateController = (deps: UpdateDeps) => {
  let status: UpdateStatus = deps.offReason ? { kind: 'off', reason: deps.offReason } : { kind: 'idle' };
  const ctx = (): StepContext => ({ installs: deps.installs, releaseUrl: deps.releaseUrl, now: deps.now() });
  const view = (): UpdateView => ({ version: deps.version, status });

  const set = (next: UpdateStatus): void => {
    if (next === status) return;
    const wasInstalling = status.kind === 'installing';
    status = next;
    deps.publish(view());
    if (wasInstalling && status.kind !== 'installing') deps.restartFailed();
  };

  if (status.kind !== 'off') deps.updater.onEvent((event) => set(nextStatus(status, event, ctx())));

  const check = async (): Promise<UpdateView> => {
    if (!canCheckForUpdates(status)) return view();
    try {
      await deps.updater.check();
    } catch (error) {
      set(nextStatus(status, { kind: 'error', message: message(error) }, ctx()));
    }
    return view();
  };

  const restart = async (): Promise<Outcome> => {
    if (status.kind !== 'ready') return { ok: false, text: 'No update is ready to install.', tone: 'error' };
    if (!deps.allowRestart()) return { ok: false, text: 'Kept running. The update installs when you quit forge.', tone: 'info' };
    const { version } = status;
    set({ kind: 'installing', version });
    try {
      deps.updater.install();
    } catch (error) {
      set(nextStatus(status, { kind: 'error', message: message(error) }, ctx()));
    }
    const after = view().status;
    if (after.kind !== 'ready') return { ok: true, text: `Restarting to install forge ${version}…`, tone: 'info' };
    return { ok: false, text: `Couldn't install forge ${version}: ${after.problem ?? 'the installer did not start'}.`, tone: 'error' };
  };

  const methods: { readonly [M in UpdateMethod]: () => Promise<unknown> } = {
    updateState: async () => view(),
    checkForUpdates: check,
    restartToUpdate: restart,
  };

  return {
    view,
    check,
    restart,
    /** Update methods take no arguments, so whatever the renderer passed is ignored. */
    dispatch: (method: UpdateMethod): Promise<unknown> => methods[method](),
  };
};
