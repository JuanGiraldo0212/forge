/**
 * One open workspace in the desktop app: composed deps, a watcher on the epics folder, and the
 * registry of running epics (so the UI can show progress and stop them).
 */
import { watch, type FSWatcher } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Deps } from '../../application/deps.ts';
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
  readonly close: () => void;
};

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

  const running = new Map<string, AbortController>();
  const busy = () => [...running.keys()];

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

  return ok({
    info,
    deps,
    gitlabAccess,
    busy,
    exclusive: async (slug, work) => {
      if (running.has(slug)) return err(`"${slug}" is already running. Stop it or wait for it to finish.`);
      const controller = new AbortController();
      running.set(slug, controller);
      events.busy(busy());
      const scoped: Deps = { ...deps, agent: { run: (req) => deps.agent.run({ ...req, signal: controller.signal }) } };
      try {
        return ok(await work(scoped));
      } catch (e) {
        return err((e as Error).message);
      } finally {
        running.delete(slug);
        events.busy(busy());
        events.epicsChanged();
      }
    },
    stop: (slug) => running.get(slug)?.abort(),
    close: () => {
      for (const c of running.values()) c.abort();
      watcher?.close();
      clearTimeout(timer);
    },
  });
};
