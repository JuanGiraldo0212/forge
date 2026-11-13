import { join } from 'node:path';
import { replay, type Epic, type EpicEvent } from '../domain/epic.ts';
import type { DomainError } from '../domain/lifecycle.ts';
import { err, ok, type Result } from '../domain/result.ts';
import type { AgentRunner, ArtifactStore, CheckRunner, Clock, CodeHost, EpicStore, Logger, RepoContext, Vcs } from '../ports/index.ts';
import type { Config, RepoConfig } from './config.ts';

/** One code repo an epic can change. */
export type RepoDeps = {
  readonly name: string;
  /** Absolute path of the developer's clone. */
  readonly root: string;
  readonly config: RepoConfig;
  readonly vcs: Vcs;
  readonly host: CodeHost;
};

/** The workspace repo, for publishing specs as MRs. Absent when that is turned off or not possible. */
export type WorkspaceRepoDeps = {
  /** GitLab project path or id. */
  readonly project: string;
  readonly remote: string;
  readonly baseBranch: string;
  /** Where the epics folder is inside the repo, with forward slashes (e.g. "epics"). */
  readonly epicsPath: string;
  readonly vcs: Vcs;
  readonly host: CodeHost;
};

export type Deps = {
  readonly config: Config;
  /** Who is acting: the human running forge. Agents act as "forge". */
  readonly actor: string;
  /** Root of the workspace (the planning repo, or the single code repo); planning agents run here. */
  readonly workspaceRoot: string;
  readonly epics: EpicStore;
  readonly artifacts: ArtifactStore;
  /** Where epics live; agents are kept out of forge's own bookkeeping there. */
  readonly epicsRoot: string;
  /** Workspace-wide instructions and rules. */
  readonly context: RepoContext;
  /** Instructions and rules of any directory: a repo snapshot, a change worktree. */
  readonly contextFor: (root: string, opts?: { readonly claudeMd?: boolean }) => RepoContext;
  readonly repos: Readonly<Record<string, RepoDeps>>;
  readonly workspaceRepo?: WorkspaceRepoDeps;
  readonly agent: AgentRunner;
  readonly checks: CheckRunner;
  readonly clock: Clock;
  readonly log: Logger;
};

/** An event without its stamp; `emit` adds time and actor. */
export type EventBody = EpicEvent extends infer E ? (E extends EpicEvent ? Omit<E, 'at' | 'by'> : never) : never;

export const loadEpic = async (deps: Deps, slug: string): Promise<Result<Epic, DomainError>> => {
  const epic = replay(await deps.epics.load(slug));
  return epic ? ok(epic) : err({ code: 'not_found', message: `No epic "${slug}".` });
};

export const emit = async (
  deps: Deps,
  slug: string,
  bodies: readonly EventBody[],
  by: string = deps.actor,
): Promise<void> => {
  const at = deps.clock();
  await deps.epics.append(
    slug,
    bodies.map((b) => ({ ...b, at, by }) as EpicEvent),
  );
};

/** Emits as the harness itself, for events produced by agents and checks. */
export const emitAsForge = (deps: Deps, slug: string, bodies: readonly EventBody[]): Promise<void> =>
  emit(deps, slug, bodies, 'forge');

export const baseRef = (repo: RepoConfig): string => `${repo.remote}/${repo.baseBranch}`;

export const changeBranch = (config: Config, slug: string, changeId: string): string =>
  `${config.branchPrefix}/${slug}/${changeId}`;

export const repoFor = (deps: Deps, name: string): Result<RepoDeps, DomainError> => {
  const repo = deps.repos[name];
  return repo ? ok(repo) : err({ code: 'unknown_repo', message: `Repo "${name}" is not configured.` });
};

/**
 * Workspace instructions plus those of each directory an agent works in. `dirs` maps a repo name to
 * the checkout the agent actually sees (a planning snapshot, or a change worktree).
 */
export const instructionsFor = async (
  deps: Deps,
  dirs: readonly { readonly name: string; readonly root: string }[],
  opts: { readonly claudeMd?: boolean } = {},
): Promise<string> => {
  const workspace = await deps.context.instructions();
  const perRepo = await Promise.all(
    dirs
      .filter((d) => d.root !== deps.workspaceRoot)
      .map(async (d) => {
        const text = await deps.contextFor(d.root, opts).instructions();
        return text ? `## Repository "${d.name}" (${d.root})\n\n${text}` : '';
      }),
  );
  return [workspace, ...perRepo].filter(Boolean).join('\n\n');
};

/** Agents never need forge's own event logs; reading them only burns tokens. */
export const forgeInternals = (deps: Deps): readonly string[] => [join(deps.epicsRoot, '**', 'events.jsonl')];
