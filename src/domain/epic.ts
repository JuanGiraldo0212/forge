/**
 * Epic lifecycle as an event-sourced aggregate.
 * The event log is the source of truth (and the audit trail); state is a pure fold over it.
 *
 *   explore ─[gate]─► spec (epic spec) ─[gate]─► changes
 *   In "changes", every change spec has its own lifecycle:
 *   draft ─[approve]─► ready ─► running ─► awaiting_review ─[approve]─► approved ─► mr_open ─► merged
 */

export const DOC_STAGES = ['explore', 'spec', 'changes'] as const;
export type DocStage = (typeof DOC_STAGES)[number];
/** Stages that produce one document and close with a single gate. */
export type GatedStage = 'explore' | 'spec';
export type Stage = DocStage | 'done' | 'abandoned';

export const STAGE_LABEL: Readonly<Record<Stage, string>> = {
  explore: 'explore',
  spec: 'epic spec',
  changes: 'change specs',
  done: 'done',
  abandoned: 'abandoned',
};

export const ARTIFACT_FILE: Readonly<Record<GatedStage, string>> = {
  explore: 'exploration.md',
  spec: 'epic-spec.md',
};

export const changeFile = (changeId: string): string => `changes/${changeId}.md`;

/** `ready`: the stage agent may run. `awaiting_approval`: a human gate is open. */
export type DocStatus = 'ready' | 'running' | 'awaiting_approval';

export type Risk = 'low' | 'medium' | 'high';
export type ChangeKind = 'feature' | 'fix' | 'refactor' | 'test' | 'chore';

/** The approved, immutable snapshot of a change spec. Edits to the file after approval do not apply. */
export type ApprovedChange = {
  readonly id: string;
  readonly title: string;
  readonly repo: string;
  readonly kind: ChangeKind;
  readonly risk: Risk;
  readonly files: readonly string[];
  readonly dependsOn: readonly string[];
  readonly verification: readonly string[];
  readonly markdown: string;
};

export type Finding = {
  readonly severity: 'blocking' | 'advisory';
  readonly summary: string;
  readonly file?: string;
  readonly line?: number;
  readonly detail?: string;
};

export type ChangeStatus =
  | 'draft'
  | 'revising'
  | 'ready'
  | 'running'
  | 'escalated'
  | 'awaiting_review'
  | 'approved'
  | 'mr_open'
  | 'merged'
  | 'dropped';

export type MergeRequestRef = { readonly iid: number; readonly url: string };

export type ChangeState = {
  readonly id: string;
  readonly title: string;
  readonly status: ChangeStatus;
  /** Set once the change spec is approved. */
  readonly spec?: ApprovedChange;
  /** Feedback the next redraft of this change spec must address. */
  readonly specFeedback: readonly string[];
  readonly branch?: string;
  readonly sessionId?: string;
  /** Last running total the SDK reported for `sessionId`: the baseline for the next resumed run. */
  readonly sessionCostUsd?: number;
  /** Failure signatures of the current attempt; reset when a human gives feedback. */
  readonly failures: readonly string[];
  /** Feedback on the implementation (from code review), for the next build attempt. */
  readonly feedback: readonly string[];
  readonly findings: readonly Finding[];
  readonly escalation?: string;
  readonly commit?: string;
  readonly revertTest?: 'passed' | 'skipped';
  readonly mergeRequest?: MergeRequestRef;
};

export type Note = {
  readonly stage: Stage;
  readonly kind: 'approve' | 'revise' | 'back';
  readonly by: string;
  readonly at: string;
  readonly text: string;
  readonly changeId?: string;
};

export type Epic = {
  readonly slug: string;
  readonly title: string;
  readonly owner: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly stage: Stage;
  readonly status: DocStatus;
  /** Bumped each time a stage document set is (re)generated. */
  readonly revision: number;
  /** Feedback the next run of the current stage must address. Cleared once addressed. */
  readonly pendingFeedback: readonly string[];
  readonly notes: readonly Note[];
  readonly changes: readonly ChangeState[];
  readonly lastError?: string;
  readonly costUsd: number;
};

type Cost = { readonly costUsd: number };

/** Which commit of a repo a planning agent read. */
export type RepoSnapshot = {
  readonly repo: string;
  readonly ref: string;
  readonly commit?: string;
  readonly source: 'snapshot' | 'stale-snapshot' | 'working-copy';
};
type ChangeRef = { readonly changeId: string };

type EventBody =
  | { readonly type: 'EpicCreated'; readonly slug: string; readonly title: string; readonly owner: string }
  | { readonly type: 'OwnerChanged'; readonly owner: string }
  | { readonly type: 'StageStarted'; readonly stage: DocStage; readonly snapshots?: readonly RepoSnapshot[] }
  | ({ readonly type: 'ArtifactProduced'; readonly stage: GatedStage } & Cost)
  | ({ readonly type: 'StageFailed'; readonly stage: DocStage; readonly reason: string } & Cost)
  | { readonly type: 'GateApproved'; readonly stage: GatedStage; readonly note?: string }
  | { readonly type: 'RevisionRequested'; readonly stage: DocStage; readonly note: string }
  | { readonly type: 'SentBack'; readonly to: GatedStage; readonly note: string }
  | ({
      readonly type: 'ChangesDrafted';
      readonly drafts: readonly { readonly id: string; readonly title: string }[];
      readonly removed: readonly string[];
      /** true when the whole draft set was regenerated (clears plan-level feedback). */
      readonly full: boolean;
      readonly snapshots?: readonly RepoSnapshot[];
    } & Cost)
  | ({ readonly type: 'ChangeSpecApproved'; readonly spec: ApprovedChange; readonly note?: string } & ChangeRef)
  | ({ readonly type: 'ChangeSpecRevisionRequested'; readonly note: string } & ChangeRef)
  | ({ readonly type: 'ChangeDropped'; readonly note: string } & ChangeRef)
  | ({ readonly type: 'ChangeStarted'; readonly branch: string } & ChangeRef)
  | ({
      readonly type: 'ChangeRoundFailed';
      readonly signature: string;
      readonly sessionId?: string;
      readonly sessionCostUsd?: number;
    } & ChangeRef &
      Cost)
  | ({
      readonly type: 'ChangeEscalated';
      readonly reason: string;
      /** Spend of a run that ended in an agent error, if any. */
      readonly costUsd?: number;
      readonly sessionCostUsd?: number;
    } & ChangeRef)
  | ({
      readonly type: 'ChangeImplemented';
      readonly commit: string;
      readonly revertTest: 'passed' | 'skipped';
      readonly sessionId?: string;
      readonly sessionCostUsd?: number;
    } & ChangeRef &
      Cost)
  | ({ readonly type: 'ChangeReviewed'; readonly findings: readonly Finding[]; readonly gateRequired: boolean } & ChangeRef &
      Cost)
  | ({ readonly type: 'ChangeApproved'; readonly note?: string } & ChangeRef)
  | ({ readonly type: 'ChangeReworkRequested'; readonly note: string } & ChangeRef)
  | ({ readonly type: 'MergeRequestOpened'; readonly iid: number; readonly url: string } & ChangeRef)
  | ({ readonly type: 'ChangeMerged' } & ChangeRef)
  | { readonly type: 'EpicAbandoned'; readonly note: string };

export type EpicEvent = EventBody & { readonly at: string; readonly by: string };
export type EpicEventType = EpicEvent['type'];

export const stageIndex = (stage: Stage): number => ['explore', 'spec', 'changes', 'done', 'abandoned'].indexOf(stage);

const nextStage = (stage: GatedStage): DocStage => (stage === 'explore' ? 'spec' : 'changes');

/** Statuses after which a change has code on a branch; it can no longer be dropped or replanned. */
export const STARTED: readonly ChangeStatus[] = ['running', 'awaiting_review', 'approved', 'mr_open', 'merged'];

const updateChange = (e: Epic, id: string, patch: (c: ChangeState) => ChangeState): Epic => ({
  ...e,
  changes: e.changes.map((c) => (c.id === id ? patch(c) : c)),
});

const addCost = (e: Epic, costUsd: number | undefined): Epic => ({ ...e, costUsd: e.costUsd + (costUsd ?? 0) });

const note = (e: Epic, n: Note): Epic => ({ ...e, notes: [...e.notes, n] });

/** Done when every change that was not dropped is merged. */
const finished = (changes: readonly ChangeState[]): boolean => {
  const live = changes.filter((c) => c.status !== 'dropped');
  return live.length > 0 && live.every((c) => c.status === 'merged');
};

const blankChange = (id: string, title: string): ChangeState => ({
  id,
  title,
  status: 'draft',
  specFeedback: [],
  failures: [],
  feedback: [],
  findings: [],
});

const applyEvent = (e: Epic, ev: EpicEvent): Epic => {
  const stamp = { by: ev.by, at: ev.at };
  switch (ev.type) {
    case 'EpicCreated':
      return e;
    case 'OwnerChanged':
      return { ...e, owner: ev.owner };
    case 'StageStarted':
      return { ...e, status: 'running', lastError: undefined };
    case 'ArtifactProduced':
      return addCost({ ...e, status: 'awaiting_approval', revision: e.revision + 1, pendingFeedback: [] }, ev.costUsd);
    case 'StageFailed':
      return addCost({ ...e, status: 'ready', lastError: ev.reason }, ev.costUsd);
    case 'GateApproved': {
      const moved = { ...e, stage: nextStage(ev.stage), status: 'ready' as const };
      return ev.note ? note(moved, { stage: ev.stage, kind: 'approve', text: ev.note, ...stamp }) : moved;
    }
    case 'RevisionRequested':
      return note(
        { ...e, status: 'ready', pendingFeedback: [...e.pendingFeedback, ev.note] },
        { stage: ev.stage, kind: 'revise', text: ev.note, ...stamp },
      );
    case 'SentBack':
      return note(
        { ...e, stage: ev.to, status: 'ready', changes: [], pendingFeedback: [ev.note] },
        { stage: ev.to, kind: 'back', text: ev.note, ...stamp },
      );
    case 'ChangesDrafted': {
      const kept = e.changes.filter((c) => !ev.removed.includes(c.id));
      const byId = new Map(kept.map((c) => [c.id, c]));
      for (const d of ev.drafts) {
        const prev = byId.get(d.id);
        byId.set(d.id, prev ? { ...prev, title: d.title, status: 'draft', specFeedback: [] } : blankChange(d.id, d.title));
      }
      return addCost(
        {
          ...e,
          status: 'ready',
          revision: e.revision + 1,
          changes: [...byId.values()],
          pendingFeedback: ev.full ? [] : e.pendingFeedback,
        },
        ev.costUsd,
      );
    }
    case 'ChangeSpecApproved': {
      const approved = updateChange(e, ev.changeId, (c) => ({ ...c, title: ev.spec.title, status: 'ready', spec: ev.spec }));
      return ev.note
        ? note(approved, { stage: 'changes', kind: 'approve', text: ev.note, changeId: ev.changeId, ...stamp })
        : approved;
    }
    case 'ChangeSpecRevisionRequested':
      return note(
        updateChange(e, ev.changeId, (c) => ({ ...c, status: 'revising', specFeedback: [...c.specFeedback, ev.note] })),
        { stage: 'changes', kind: 'revise', text: ev.note, changeId: ev.changeId, ...stamp },
      );
    case 'ChangeDropped': {
      const next = updateChange(e, ev.changeId, (c) => ({ ...c, status: 'dropped' }));
      return finished(next.changes) ? { ...next, stage: 'done' } : next;
    }
    case 'ChangeStarted':
      return updateChange(e, ev.changeId, (c) => ({ ...c, status: 'running', branch: ev.branch, escalation: undefined }));
    case 'ChangeRoundFailed':
      return updateChange(addCost(e, ev.costUsd), ev.changeId, (c) => ({
        ...c,
        failures: [...c.failures, ev.signature],
        sessionId: ev.sessionId ?? c.sessionId,
        sessionCostUsd: ev.sessionCostUsd ?? c.sessionCostUsd,
      }));
    case 'ChangeEscalated':
      return updateChange(addCost(e, ev.costUsd), ev.changeId, (c) => ({
        ...c,
        status: 'escalated',
        escalation: ev.reason,
        sessionCostUsd: ev.sessionCostUsd ?? c.sessionCostUsd,
      }));
    case 'ChangeImplemented':
      return updateChange(addCost(e, ev.costUsd), ev.changeId, (c) => ({
        ...c,
        commit: ev.commit,
        revertTest: ev.revertTest,
        sessionId: ev.sessionId ?? c.sessionId,
        sessionCostUsd: ev.sessionCostUsd ?? c.sessionCostUsd,
      }));
    case 'ChangeReviewed':
      return updateChange(addCost(e, ev.costUsd), ev.changeId, (c) => ({
        ...c,
        findings: ev.findings,
        status: ev.gateRequired ? 'awaiting_review' : 'approved',
      }));
    case 'ChangeApproved': {
      const approved = updateChange(e, ev.changeId, (c) => ({ ...c, status: 'approved' }));
      return ev.note
        ? note(approved, { stage: 'changes', kind: 'approve', text: ev.note, changeId: ev.changeId, ...stamp })
        : approved;
    }
    case 'ChangeReworkRequested':
      return note(
        updateChange(e, ev.changeId, (c) => ({
          ...c,
          status: 'ready',
          failures: [],
          feedback: [...c.feedback, ev.note],
          escalation: undefined,
        })),
        { stage: 'changes', kind: 'revise', text: ev.note, changeId: ev.changeId, ...stamp },
      );
    case 'MergeRequestOpened':
      return updateChange(e, ev.changeId, (c) => ({ ...c, status: 'mr_open', mergeRequest: { iid: ev.iid, url: ev.url } }));
    case 'ChangeMerged': {
      const next = updateChange(e, ev.changeId, (c) => ({ ...c, status: 'merged' }));
      return finished(next.changes) ? { ...next, stage: 'done' } : next;
    }
    case 'EpicAbandoned':
      return { ...e, stage: 'abandoned', status: 'ready' };
  }
};

/** Pure fold. Returns undefined for an empty or malformed log (first event must be EpicCreated). */
export const replay = (events: readonly EpicEvent[]): Epic | undefined => {
  const [first, ...rest] = events;
  if (first?.type !== 'EpicCreated') return undefined;
  const initial: Epic = {
    slug: first.slug,
    title: first.title,
    owner: first.owner,
    createdAt: first.at,
    updatedAt: first.at,
    stage: 'explore',
    status: 'ready',
    revision: 0,
    pendingFeedback: [],
    notes: [],
    changes: [],
    costUsd: 0,
  };
  return rest.reduce((e, ev) => ({ ...applyEvent(e, ev), updatedAt: ev.at }), initial);
};

/** A change, or the epic, is waiting on a human. */
export const needsHuman = (e: Epic): boolean =>
  ((e.stage === 'explore' || e.stage === 'spec') && e.status === 'awaiting_approval') ||
  e.changes.some((c) => c.status === 'draft' || c.status === 'awaiting_review' || c.status === 'escalated');
