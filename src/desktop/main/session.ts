/**
 * One open workspace in the desktop app: composed deps, a watcher on the epics folder, and the
 * registry of running epics (so the UI can show progress and stop them).
 */
import { watch, type FSWatcher } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename } from 'node:path';
import { loadEpic, type Deps } from '../../application/deps.ts';
import { watchesMergeRequests } from '../../application/watch.ts';
import { syncAction } from '../../ui/actions.ts';
import { composeDeps, findRepoRoot } from '../../app/compose.ts';
import { err, ok, type Result } from '../../domain/result.ts';
import { instanceHost } from '../../adapters/gitlab.ts';
import type { GitlabAccess } from '../../ports/index.ts';
import type { WorkspaceInfo } from '../shared/api.ts';
import type { WorkspaceSettings } from './settings.ts';

export type SessionEvents = {
  readonly epicsChanged: () => void;
  readonly busy: (busy: readonly string[]) => void;
};

export type Session = {
  readonly info: WorkspaceInfo;
  readonly deps: Deps;
  /** Checks the GitLab sign-in on the machine this session runs on. */
  readonly gitlabAccess: () => Promise<GitlabAccess>;
  /** Runs `work` for one epic with a fresh abort signal threaded into every agent it starts. Refuses if that epic is busy. */
  readonly exclusive: <T>(slug: string, work: (deps: Deps) => Promise<T>) => Promise<Result<T, string>>;
  readonly stop: (slug: string) => void;
  readonly busy: () => readonly string[];
  /** Looks at every epic's open MRs once (what the background watcher does on its own every few minutes). */
  readonly watchMergeRequests: () => Promise<void>;
  readonly close: () => void;
};

/** The first look at open MRs after a workspace opens; later ones follow mergeRequests.pollSeconds. */
const FIRST_WATCH_MS = 15_000;

export const openSession = async (
  path: string,
  settings: WorkspaceSettings,
  events: SessionEvents,
  options: { readonly agentExecutable?: string } = {},
): Promise<Result<Session, string>> => {
  const root = await findRepoRoot(path);
  if (!root.ok) return err(`${path} is not inside a git repository.`);

  // A token stored in the keychain stands in for the env var, for this process only. The glab login needs none.
  const raw = await composeDeps(root.value, { log: { info() {}, warn() {} } });
  if (!raw.ok) return raw;
  const { tokenEnv, auth, baseUrl } = raw.value.deps.config.gitlab;
  const wantsStoredToken = auth === 'token' && !process.env[tokenEnv];
  const stored = wantsStoredToken ? await settings.token(tokenEnv) : undefined;
  if (stored) process.env[tokenEnv] = stored;

  // Progress shows in the UI through epic state; warnings (e.g. a repo snapshot that couldn't refresh) go to the log.
  const composed = await composeDeps(
    root.value,
    { log: { info() {}, warn: (m) => console.warn(`[forge] ${m}`) } },
    { agentExecutable: options.agentExecutable },
  );
  if (!composed.ok) return composed;
  const { deps, warnings, epicsRoot, gitlabAccess } = composed.value;

  /** `settled` resolves once a quiet hold ends or announces itself; a person's action waits on it. */
  type Hold = { readonly controller: AbortController; quiet: boolean; readonly settled: Promise<void> };
  const running = new Map<string, Hold>();
  // Quiet holds (the MR watcher just looking) don't show as busy.
  const busy = () => [...running].filter(([, h]) => !h.quiet).map(([slug]) => slug);

  await mkdir(epicsRoot, { recursive: true });
  let timer: NodeJS.Timeout | undefined;
  let watcher: FSWatcher | undefined;
  try {
    watcher = watch(epicsRoot, { recursive: true }, () => {
      clearTimeout(timer);
      timer = setTimeout(events.epicsChanged, 150);
    });
  } catch {
    // Recursive watching is unsupported on some file systems; the UI still refreshes after every action.
  }

  const info: WorkspaceInfo = {
    root: root.value,
    name: basename(root.value),
    actor: deps.actor,
    repos: Object.values(deps.repos).map((r) => ({
      name: r.name,
      root: r.root,
      project: r.config.project,
      present: !warnings.some((w) => w.startsWith(`repo "${r.name}"`)),
    })),
    warnings,
    gitlabAuth: auth,
    gitlabHost: instanceHost(baseUrl),
    tokenEnv,
    gitlabTokenSet: Boolean(process.env[tokenEnv]),
    canStoreToken: settings.canStoreToken(),
  };

  /**
   * Holds the epic while `work` runs. A quiet hold (the MR watcher just looking) doesn't show the epic as busy
   * until `announce` is called, when agents are about to start. A person's action that comes during a quiet hold
   * waits for the look to end (a few API calls) instead of being refused; once the watcher starts a rework, the
   * epic is busy as usual.
   */
  const hold = async <T>(slug: string, work: (deps: Deps, announce: () => void) => Promise<T>, quiet = false): Promise<Result<T, string>> => {
    for (let held = running.get(slug); held; held = running.get(slug)) {
      if (quiet || !held.quiet) return err(`"${slug}" is already running. Stop it or wait for it to finish.`);
      await held.settled;
    }
    const controller = new AbortController();
    let settle = () => {};
    const entry: Hold = { controller, quiet, settled: new Promise<void>((resolve) => (settle = resolve)) };
    running.set(slug, entry);
    if (!quiet) events.busy(busy());
    const announce = () => {
      if (!entry.quiet) return;
      entry.quiet = false;
      settle();
      events.busy(busy());
    };
    const scoped: Deps = { ...deps, agent: { run: (req) => deps.agent.run({ ...req, signal: controller.signal }) } };
    try {
      return ok(await work(scoped, announce));
    } catch (e) {
      return err((e as Error).message);
    } finally {
      const wasQuiet = entry.quiet;
      running.delete(slug);
      settle();
      if (!wasQuiet) events.busy(busy());
      events.epicsChanged();
    }
  };

  // The MR watcher: while the workspace is open, open MRs are checked on their own. An epic someone is working on
  // is skipped and looked at next time.
  let watching = false;
  const watchMergeRequests = async (): Promise<void> => {
    if (watching) return;
    watching = true;
    try {
      for (const slug of await deps.epics.list()) {
        if (running.has(slug)) continue;
        const epic = await loadEpic(deps, slug);
        if (!epic.ok || !watchesMergeRequests(epic.value)) continue;
        const r = await hold(slug, (d, announce) => syncAction(d, slug, announce), true);
        if (!r.ok) console.warn(`[forge] watching the MRs of ${slug}: ${r.error}`);
        else if (r.value.tone === 'error') console.warn(`[forge] watching the MRs of ${slug}: ${r.value.text}`);
      }
    } catch (e) {
      console.warn(`[forge] watching MRs: ${(e as Error).message}`);
    } finally {
      watching = false;
    }
  };
  const { watch: watchOn, pollSeconds } = deps.config.mergeRequests;
  const firstWatch = watchOn ? setTimeout(() => void watchMergeRequests(), FIRST_WATCH_MS) : undefined;
  const watchTimer = watchOn ? setInterval(() => void watchMergeRequests(), pollSeconds * 1000) : undefined;

  return ok({
    info,
    deps,
    gitlabAccess,
    busy,
    exclusive: (slug, work) => hold(slug, (d) => work(d)),
    stop: (slug) => running.get(slug)?.controller.abort(),
    watchMergeRequests,
    close: () => {
      for (const h of running.values()) h.controller.abort();
      watcher?.close();
      clearTimeout(timer);
      clearTimeout(firstWatch);
      clearInterval(watchTimer);
    },
  });
};
