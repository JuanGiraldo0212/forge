/**
 * The MR watcher: what happens to an open MR while it waits to be merged. Forge syncs its state (merged, closed),
 * picks up threads that ask for forge and pipelines that failed on forge's commit, and reworks the change straight
 * away, pushing to the same MR and answering each thread. No human approves those reworks; limits on how many and how
 * much hand new feedback to the owner instead, as does anything the agent says only the owner can decide.
 *
 * Comments are untrusted input to a build agent: only notes from project members with Developer access or more
 * (or allowlisted bots) are acted on, and by default only when they mention forge.
 */
import { type ChangeState, type Epic, type MergeRequestFeedbackItem } from '../domain/epic.ts';
import type { DomainError } from '../domain/lifecycle.ts';
import { failureSignature } from '../domain/policy.ts';
import { ok, type Result } from '../domain/result.ts';
import { autoReworkHold, isForgeNote, mentions } from '../domain/review.ts';
import type { MergeRequestNote, MergeRequestState } from '../ports/index.ts';
import { FOLLOWED, runBuild, syncMergeRequests, type ChangeOutcome, type SyncRow } from './build.ts';
import { emitAsForge, loadEpic, repoFor, type Deps, type RepoDeps } from './deps.ts';
import { heldReply } from './render.ts';

/** GitLab's Developer role: the least access that may push to a branch. */
const DEVELOPER = 30;
const MAX_JOBS = 3;
const LOG_TAIL = 6000;
const NOTE_MAX = 4000;
const THREAD_MAX = 10;

export type PickedUp = {
  readonly changeId: string;
  readonly items: readonly MergeRequestFeedbackItem[];
  readonly held?: string;
};

export type WatchReport = {
  readonly rows: readonly SyncRow[];
  readonly pickedUp: readonly PickedUp[];
  readonly outcomes: readonly ChangeOutcome[];
  /** Why the picked-up changes could not be reworked now (they stay ready for the next run). */
  readonly buildError?: string;
};

/** Whether the epic has an MR worth looking at. */
export const watchesMergeRequests = (e: Epic): boolean =>
  e.stage === 'development' && e.changes.some((c) => c.mergeRequest && FOLLOWED.includes(c.status));

/** Picked up by the watcher, but its rework never started (the build failed to start, or the batch was full). */
const stranded = (c: ChangeState): boolean =>
  c.status === 'ready' && Boolean(c.automation) && Boolean(c.mergeRequestFeedback) && !c.mergeRequestFeedback?.responses;

/** A job log as the agent should read it: no color codes or GitLab section markers, only its end. */
export const cleanJobLog = (log: string): string => {
  const text = log
    .replace(/\x1b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/section_(start|end):\d+:[^\r\n]*?\r/g, '')
    .replace(/\r\n?/g, '\n');
  return text.length <= LOG_TAIL ? text : `[... ${text.length - LOG_TAIL} chars cut ...]\n${text.slice(-LOG_TAIL)}`;
};

const isMergeResultRef = (ref: string | undefined, iid: number): boolean => ref === `refs/merge-requests/${iid}/merge` || ref === `refs/merge-requests/${iid}/train`;

const clip = (text: string): string => (text.length <= NOTE_MAX ? text : `${text.slice(0, NOTE_MAX)} [... cut]`);

type Collected = {
  readonly items: readonly MergeRequestFeedbackItem[];
  readonly ignoredNotes: readonly number[];
  readonly ignoredPipelines: readonly number[];
};

/** Reads what is new on one open MR. Read-only; anything that can't be read now is left for the next look. */
const collectFeedback = async (deps: Deps, repo: RepoDeps, change: ChangeState, state: MergeRequestState): Promise<Collected> => {
  const cfg = deps.config.mergeRequests;
  const iid = change.mergeRequest!.iid;
  const items: MergeRequestFeedbackItem[] = [];
  const ignoredNotes: number[] = [];
  const ignoredPipelines: number[] = [];
  let n = 0;
  const nextId = () => `M${++n}`;

  // The pipeline of forge's own commit only: a pipeline on an older commit says nothing about the code now. A merged
  // results pipeline runs on a merge commit GitLab made from some head of the MR: it counts if that head is forge's.
  const pipelineId = state.pipelineId;
  const onForgeCommit = async (): Promise<boolean> => {
    if (state.pipelineSha === change.commit) return true;
    if (!state.pipelineSha || !change.commit || !isMergeResultRef(state.pipelineRef, iid)) return false;
    const parents = await repo.host.commitParents(state.pipelineSha);
    return parents.ok && parents.value.includes(change.commit);
  };
  if (
    cfg.ciFix.enabled &&
    state.pipeline === 'failed' &&
    pipelineId &&
    !(change.handledPipelines ?? []).includes(pipelineId) &&
    (await onForgeCommit())
  ) {
    const jobs = await repo.host.failedJobs(pipelineId);
    if (!jobs.ok) deps.log.warn(`[${change.id}] could not read the failed jobs of pipeline #${pipelineId}: ${jobs.error.message}`);
    else {
      const counted = jobs.value.filter((j) => !j.allowFailure && (cfg.ciFix.jobs.length === 0 || cfg.ciFix.jobs.includes(j.name)));
      if (counted.length === 0) ignoredPipelines.push(pipelineId);
      else {
        const logs = await Promise.all(
          counted.slice(0, MAX_JOBS).map(async (j) => {
            const log = await repo.host.jobLog(j.id);
            return { name: j.name, log: log.ok ? cleanJobLog(log.value) : `(the log could not be read: ${log.error.message})` };
          }),
        );
        items.push({
          id: nextId(),
          kind: 'ci',
          pipelineId,
          signature: logs.map((j) => failureSignature(j.name, j.log)).join('\n'),
          jobs: logs,
        });
      }
    }
  }

  const { respondTo, mention, bots } = cfg.comments;
  if (respondTo !== 'off') {
    const discussions = await repo.host.listDiscussions(iid);
    if (!discussions.ok) deps.log.warn(`[${change.id}] could not read the threads of MR !${iid}: ${discussions.error.message}`);
    else {
      const handled = new Set(change.handledNotes ?? []);
      const levels = new Map<number, number>();
      const accessOf = async (userId: number): Promise<number | undefined> => {
        if (!levels.has(userId)) {
          const level = await repo.host.accessLevel(userId);
          if (!level.ok) {
            deps.log.warn(`[${change.id}] could not check a commenter's access on MR !${iid}: ${level.error.message}`);
            return undefined;
          }
          levels.set(userId, level.value);
        }
        return levels.get(userId);
      };
      // An allowlisted bot must really be a bot account with access: a person can't take its name to skip the checks.
      const allowedBot = (note: MergeRequestNote) =>
        note.author.bot && bots.some((b) => b.toLowerCase() === note.author.username.toLowerCase());
      /** May this note's author tell the build agent what to do? Undefined when that can't be checked now. */
      const trusted = async (note: MergeRequestNote): Promise<boolean | undefined> => {
        if (note.author.bot && !allowedBot(note)) return false;
        const level = await accessOf(note.author.id);
        return level === undefined ? undefined : level >= DEVELOPER;
      };

      for (const d of discussions.value) {
        if (d.resolved) continue;
        const asking: MergeRequestNote[] = [];
        let unknown = false;
        for (const note of d.notes) {
          if (note.system || handled.has(note.id) || isForgeNote(note.body)) continue;
          const asks = allowedBot(note) || (!note.author.bot && (respondTo === 'members' || mentions(note.body, mention)));
          if (!asks) {
            // A bot that is not allowlisted asking for forge is ignored for good; others' chatter is simply not a request.
            if (note.author.bot && mentions(note.body, mention)) ignoredNotes.push(note.id);
            continue;
          }
          const ok = await trusted(note);
          if (ok === undefined) unknown = true;
          else if (ok) asking.push(note);
          else {
            deps.log.warn(`[${change.id}] ignored a request on MR !${iid} from ${note.author.username}: not a project member with Developer access`);
            ignoredNotes.push(note.id);
          }
        }
        const last = asking.at(-1);
        // Can't tell who may ask: look again next time rather than act on part of the thread.
        if (!last || unknown) continue;
        // The agent reads only what trusted people wrote; forge's own notes count as forge's only when such a person
        // (forge posts with its owner's sign-in) posted them.
        const thread: { author: string; body: string }[] = [];
        for (const note of d.notes.slice(0, d.notes.indexOf(last) + 1)) {
          if (note.system) continue;
          const ok = await trusted(note);
          if (ok === undefined) {
            unknown = true;
            break;
          }
          thread.push(
            ok
              ? { author: isForgeNote(note.body) ? 'forge' : note.author.username, body: clip(note.body) }
              : { author: note.author.username, body: '(left out: not written by a project member with Developer access)' },
          );
        }
        if (unknown) continue;
        const first = d.notes[0];
        items.push({
          id: nextId(),
          kind: 'comment',
          discussionId: d.id,
          noteIds: asking.map((note) => note.id),
          thread: thread.slice(-THREAD_MAX),
          ...(first?.file ? { file: first.file } : {}),
          ...(first?.line ? { line: first.line } : {}),
        });
      }
    }
  }
  return { items, ignoredNotes, ignoredPipelines };
};

/** Tells the MR that its new feedback waits for the owner. Best effort. */
const announceHold = async (deps: Deps, repo: RepoDeps, change: ChangeState, items: readonly MergeRequestFeedbackItem[], reason: string, head: string) => {
  const iid = change.mergeRequest!.iid;
  const body = heldReply(reason);
  for (const item of items) {
    const posted =
      item.kind === 'comment'
        ? await repo.host.replyToDiscussion(iid, item.discussionId, body)
        : await repo.host.commentOnMergeRequest(iid, head, [{ body }]).then((r) => (r.failed.length ? { ok: false as const, error: { message: r.failed[0]! } } : { ok: true as const }));
    if (!posted.ok) deps.log.warn(`[${change.id}] could not tell MR !${iid} that its feedback waits for the owner: ${posted.error.message}`);
  }
};

/**
 * Looks at every open MR of the epic once: syncs merges and closes, picks up new feedback, and reworks the changes
 * it picked feedback up for (`onBuild` is called just before, so the caller can show the epic as busy).
 */
export const watchMergeRequests = async (
  deps: Deps,
  slug: string,
  opts: { readonly onBuild?: () => void } = {},
): Promise<Result<WatchReport, DomainError>> => {
  const rows = await syncMergeRequests(deps, slug);
  if (!rows.ok) return rows;
  const loaded = await loadEpic(deps, slug);
  if (!loaded.ok) return loaded;
  const policy = {
    maxAutoReworks: deps.config.mergeRequests.maxAutoReworks,
    maxSpendUsd: deps.config.mergeRequests.maxSpendUsd,
    ciFixRounds: deps.config.mergeRequests.ciFix.maxRounds,
  };

  const pickedUp: PickedUp[] = [];
  for (const row of rows.value) {
    if ('error' in row || row.state !== 'opened') continue;
    const change = loaded.value.changes.find((c) => c.id === row.changeId);
    // Escalated: the owner has it. Their next step decides; what came in meanwhile is picked up after.
    if (!change || change.status !== 'mr_open' || !change.mergeRequest) continue;
    const repo = repoFor(deps, row.repo);
    if (!repo.ok) continue;

    // Someone else pushed: their commits are not forge's to build on until forge pushes again.
    if (row.headSha && change.commit && row.headSha !== change.commit) {
      if (change.foreignHead !== row.headSha)
        await emitAsForge(deps, slug, [{ type: 'MergeRequestWatchPaused', changeId: change.id, headSha: row.headSha }]);
      continue;
    }

    const found = await collectFeedback(deps, repo.value, change, row);
    if (found.items.length === 0 && found.ignoredNotes.length === 0 && found.ignoredPipelines.length === 0) continue;
    const held = found.items.length ? autoReworkHold(policy, change, found.items) : undefined;
    await emitAsForge(deps, slug, [
      {
        type: 'MergeRequestFeedbackReceived',
        changeId: change.id,
        iid: change.mergeRequest.iid,
        items: found.items,
        ...(found.ignoredNotes.length ? { ignoredNotes: found.ignoredNotes } : {}),
        ...(found.ignoredPipelines.length ? { ignoredPipelines: found.ignoredPipelines } : {}),
        ...(held ? { held } : {}),
      },
    ]);
    if (found.items.length === 0) continue;
    if (held) await announceHold(deps, repo.value, change, found.items, held, change.commit ?? row.headSha ?? '');
    pickedUp.push({ changeId: change.id, items: found.items, ...(held ? { held } : {}) });
  }

  const reloaded = await loadEpic(deps, slug);
  if (!reloaded.ok) return reloaded;
  const toBuild = reloaded.value.changes.filter(stranded).map((c) => c.id);
  if (toBuild.length === 0) return ok({ rows: rows.value, pickedUp, outcomes: [] });
  opts.onBuild?.();
  const built = await runBuild(deps, reloaded.value, false, toBuild);
  return built.ok
    ? ok({ rows: rows.value, pickedUp, outcomes: built.value.outcomes })
    : ok({ rows: rows.value, pickedUp, outcomes: [], buildError: built.error.message });
};
