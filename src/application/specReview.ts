/**
 * Spec MRs: the epic spec, and each change spec on its own, are pushed to branches of the workspace repo and
 * opened as MRs there, so the team can review them in GitLab. Each later version (a revision, a redraft, or the
 * owner's edits picked up at approval) is a new commit on the open MR. The MR of a change that is dropped, or that
 * leaves the plan, is closed. The forge process pushes, never an agent.
 *
 * Publishing is best effort: it never fails the step that triggered it, it only logs.
 */
import { parseChangeSpec } from '../domain/changes.ts';
import { ARTIFACT_FILE, changeFile, IDEA_FILE, type Epic, type MergeRequestRef, type SpecReview } from '../domain/epic.ts';
import { err, ok, type Result } from '../domain/result.ts';
import { emitAsForge, loadEpic, type Deps, type EventBody, type WorkspaceRepoDeps } from './deps.ts';

export const specBranch = (deps: Deps, slug: string, review: SpecReview): string =>
  `${deps.config.branchPrefix}/${slug}/${review.kind === 'epic' ? 'epic-spec' : `${review.changeId}-spec`}`;

const label = (review: SpecReview): string => (review.kind === 'epic' ? 'epic spec' : `change spec ${review.changeId}`);

type File = { readonly path: string; readonly content: string };

/** What one spec MR holds and says. */
type Target = {
  readonly review: SpecReview;
  readonly files: readonly File[];
  readonly title: string;
  readonly description: string;
  readonly recorded?: MergeRequestRef;
};

const FOOTER =
  'Written by forge. Approve or ask for revisions in forge: each new version is pushed here as a new commit. ' +
  'Comments on this MR are not read by forge, so bring what matters back to the epic.';

const read = async (deps: Deps, ws: WorkspaceRepoDeps, slug: string, names: readonly string[]): Promise<readonly File[]> => {
  const files = await Promise.all(
    names.map(async (name) => {
      const content = await deps.artifacts.read(slug, name);
      return content === undefined ? undefined : { path: `${ws.epicsPath}/${slug}/${name}`, content };
    }),
  );
  return files.filter((f): f is File => f !== undefined);
};

const epicTarget = async (deps: Deps, ws: WorkspaceRepoDeps, epic: Epic): Promise<Target> => ({
  review: { kind: 'epic' },
  files: await read(deps, ws, epic.slug, [IDEA_FILE, ARTIFACT_FILE.requirements, ARTIFACT_FILE.spec]),
  title: `Epic spec: ${epic.title}`,
  description: [
    `The epic spec for **${epic.title}** (\`${epic.slug}\`), with the idea and the requirements it builds on.`,
    `Owner: ${epic.owner}`,
    FOOTER,
  ].join('\n\n'),
  recorded: epic.specMergeRequest,
});

const changeTarget = async (deps: Deps, ws: WorkspaceRepoDeps, epic: Epic, changeId: string): Promise<Target | undefined> => {
  const change = epic.changes.find((c) => c.id === changeId && c.status !== 'dropped');
  if (!change) return undefined;
  const files = await read(deps, ws, epic.slug, [changeFile(changeId)]);
  const fromFile = files[0] ? parseChangeSpec(files[0].content, changeId) : undefined;
  const header = change.spec ?? (fromFile?.ok ? fromFile.value : undefined);
  const facts = header
    ? `Repo: \`${header.repo}\` · Depends on: ${header.dependsOn.length ? header.dependsOn.join(', ') : 'nothing'}${change.spec ? ' · Approved' : ''}`
    : undefined;
  return {
    review: { kind: 'change', changeId },
    files,
    title: `Change spec ${changeId}: ${change.title} (${epic.title})`,
    description: [
      `Change spec **${changeId}**: ${change.title}. One of the changes of **${epic.title}** (\`${epic.slug}\`); forge builds it as one MR.`,
      facts,
      epic.specMergeRequest ? `Epic spec: ${epic.specMergeRequest.url}` : undefined,
      `Owner: ${epic.owner}`,
      FOOTER,
    ]
      .filter(Boolean)
      .join('\n\n'),
    recorded: epic.changeSpecMergeRequests[changeId],
  };
};

export type Published = { readonly url: string; readonly opened: boolean } | { readonly unchanged: true };

const publish = async (deps: Deps, ws: WorkspaceRepoDeps, slug: string, target: Target): Promise<Result<Published, string>> => {
  if (target.files.length === 0) return ok({ unchanged: true });
  const { recorded } = target;
  const state = recorded ? await ws.host.getMergeRequest(recorded.iid) : undefined;
  // Not knowing whether the MR is still open, starting over could clobber it: try again next time.
  if (state && !state.ok) return err(`could not check MR !${recorded!.iid}: ${state.error.message}`);
  const open = recorded && state?.ok && state.value.state === 'opened' ? recorded : undefined;

  const fetched = await ws.vcs.fetch();
  if (!fetched.ok) return err(fetched.error.message);
  const base = `${ws.remote}/${ws.baseBranch}`;
  const branch = specBranch(deps, slug, target.review);
  const wt = await ws.vcs.ensureWorktree(branch, base);
  if (!wt.ok) return err(wt.error.message);
  // An open MR gets a new commit on top of what it has; otherwise (first time, or the last MR was merged or
  // closed) the branch starts over from the base, so the new MR shows only what is new.
  const continuing = open !== undefined && (await ws.vcs.fetchBranch(branch));
  const reset = await ws.vcs.resetTo(wt.value, continuing ? `${ws.remote}/${branch}` : base);
  if (!reset.ok) return err(reset.error.message);
  const written = await ws.vcs.writeFiles(wt.value, target.files);
  if (!written.ok) return err(written.error.message);
  const commit = await ws.vcs.commitAll(wt.value, `${target.title}\n\nPublished by forge for epic ${slug}.`);
  if (!commit.ok) return err(commit.error.message);
  if (commit.value === undefined && (continuing || !open)) return ok({ unchanged: true });

  const pushed = await ws.vcs.push(wt.value, { force: !continuing });
  if (!pushed.ok) return err(`push failed: ${pushed.error.message}`);
  if (open) return ok({ url: open.url, opened: false });

  const mr = await ws.host.openMergeRequest({ sourceBranch: branch, targetBranch: ws.baseBranch, title: target.title, description: target.description });
  if (!mr.ok) return err(`could not open MR: ${mr.error.message}`);
  const changeId = target.review.kind === 'change' ? target.review.changeId : undefined;
  await emitAsForge(deps, slug, [{ type: 'SpecMergeRequestOpened', ...(changeId ? { changeId } : {}), iid: mr.value.iid, url: mr.value.url }]);
  return ok({ url: mr.value.url, opened: true });
};

/** Publishes one document, logging the outcome. Never throws. */
const publishLogged = async (deps: Deps, ws: WorkspaceRepoDeps, slug: string, review: SpecReview, target: () => Promise<Target | undefined>) => {
  let result: Result<Published, string>;
  try {
    const t = await target();
    result = t ? await publish(deps, ws, slug, t) : ok({ unchanged: true });
  } catch (e) {
    result = err((e as Error).message);
  }
  if (!result.ok) deps.log.warn(`Could not publish the ${label(review)} MR on ${ws.project}: ${result.error}`);
  else if ('url' in result.value) deps.log.info(`${result.value.opened ? 'Opened' : 'Updated'} the ${label(review)} MR: ${result.value.url}`);
  return result;
};

/** Pushes the epic spec (with the idea and requirements) to its MR on the workspace repo, opening it if needed. */
export const publishEpicSpec = async (deps: Deps, slug: string): Promise<void> => {
  const ws = deps.workspaceRepo;
  const loaded = ws ? await loadEpic(deps, slug) : undefined;
  if (!ws || !loaded?.ok) return;
  await publishLogged(deps, ws, slug, { kind: 'epic' }, () => epicTarget(deps, ws, loaded.value));
};

/**
 * Pushes each of `changeIds` to its own MR on the workspace repo, opening them as needed, then closes the MRs of
 * changes that were dropped or are no longer planned.
 */
export const publishChangeSpecs = async (deps: Deps, slug: string, changeIds: readonly string[]): Promise<void> => {
  const ws = deps.workspaceRepo;
  if (!ws) return;
  for (const changeId of changeIds) {
    // Reloaded each time: an MR opened a moment ago is on the epic.
    const loaded = await loadEpic(deps, slug);
    if (!loaded.ok) return;
    await publishLogged(deps, ws, slug, { kind: 'change', changeId }, () => changeTarget(deps, ws, loaded.value, changeId));
  }
  await closeStale(deps, ws, slug);
};

/** Closes the MRs of change specs that were dropped or left the plan, and forgets them. */
const closeStale = async (deps: Deps, ws: WorkspaceRepoDeps, slug: string): Promise<void> => {
  const loaded = await loadEpic(deps, slug);
  if (!loaded.ok) return;
  const live = new Set(loaded.value.changes.filter((c) => c.status !== 'dropped').map((c) => c.id));
  const events: EventBody[] = [];
  for (const [changeId, mr] of Object.entries(loaded.value.changeSpecMergeRequests)) {
    if (live.has(changeId)) continue;
    try {
      const state = await ws.host.getMergeRequest(mr.iid);
      if (!state.ok) throw new Error(state.error.message);
      if (state.value.state === 'opened') {
        const closed = await ws.host.closeMergeRequest(mr.iid);
        if (!closed.ok) throw new Error(closed.error.message);
        deps.log.info(`Closed the change spec ${changeId} MR: ${mr.url}`);
      }
      events.push({ type: 'SpecMergeRequestClosed', changeId, iid: mr.iid });
    } catch (e) {
      deps.log.warn(`Could not close the change spec ${changeId} MR ${mr.url}: ${(e as Error).message}`);
    }
  }
  if (events.length > 0) await emitAsForge(deps, slug, events);
};

/** After a change is dropped: closes its spec MR. */
export const closeDroppedChangeSpecs = async (deps: Deps, slug: string): Promise<void> => {
  if (deps.workspaceRepo) await closeStale(deps, deps.workspaceRepo, slug);
};
