/**
 * What planning agents (requirements, epic spec, change specs) see of the code repos: read-only snapshots at
 * each repo's base (e.g. origin/main), refreshed before every planning run, so specs describe the code
 * that changes will actually be built on, not whatever a developer happens to have checked out.
 */
import type { AgentRequest } from '../ports/index.ts';
import { baseRef, forgeInternals, instructionsFor, type Deps } from './deps.ts';
import { systemPrompt, type RepoRef } from './prompts.ts';

export type PlanningRepo = RepoRef & {
  readonly ref: string;
  /** How fresh the checkout is: `snapshot` is up to date with the base. */
  readonly source: 'snapshot' | 'stale-snapshot' | 'working-copy';
  readonly commit?: string;
};

export type PlanningView = { readonly repos: readonly PlanningRepo[] };

export const preparePlanning = async (deps: Deps): Promise<PlanningView> => {
  const repos = await Promise.all(
    Object.values(deps.repos).map(async (r): Promise<PlanningRepo> => {
      const ref = baseRef(r.config);
      const base = { name: r.name, project: r.config.project, ref };
      const fetched = await r.vcs.fetch();
      const snap = fetched.ok ? await r.vcs.snapshot(ref) : undefined;
      if (snap?.ok) return { ...base, root: snap.value.path, source: 'snapshot', commit: snap.value.commit };

      const reason = fetched.ok ? (snap && !snap.ok ? snap.error.message : 'unknown error') : fetched.error.message;
      const stale = await r.vcs.existingSnapshot();
      if (stale) {
        deps.log.warn(`${r.name}: could not refresh ${ref} (${reason}); planning from the last snapshot ${stale.commit.slice(0, 8)}.`);
        return { ...base, root: stale.path, source: 'stale-snapshot', commit: stale.commit };
      }
      deps.log.warn(`${r.name}: could not snapshot ${ref} (${reason}); planning from the working copy at ${r.root}.`);
      return { ...base, root: r.root, source: 'working-copy' };
    }),
  );
  return { repos };
};

/** For the event log: which commit of each repo a plan was made against. */
export const snapshotRecord = (view: PlanningView) =>
  view.repos.map((r) => ({ repo: r.name, ref: r.ref, commit: r.commit, source: r.source }));

/** Planning agents run from the workspace, may read every repo snapshot, and never read forge's event logs. */
export const planningRequest = async (
  deps: Deps,
  view: PlanningView,
  epic: string,
  label: string,
  prompt: string,
): Promise<AgentRequest> => ({
  epic,
  label,
  cwd: deps.workspaceRoot,
  additionalDirectories: view.repos.map((r) => r.root).filter((root) => root !== deps.workspaceRoot),
  denyRead: forgeInternals(deps),
  mode: 'read',
  model: deps.config.models.author,
  systemPrompt: systemPrompt(await instructionsFor(deps, view.repos)),
  prompt,
  maxTurns: deps.config.loop.maxTurnsPerRound,
});
