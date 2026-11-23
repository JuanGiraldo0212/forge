/**
 * Epic lifecycle as an event-sourced aggregate.
 * The event log is the source of truth (and the audit trail); state is a pure fold over it.
 *
 *   requirements ─[gate]─► spec (epic spec: an RFC that plans the changes) ─[gate]─► changes ─[gate]─► development
 *   In "changes" each change spec is drafted and approved on its own; the gate approves the whole set.
 *   In "development" each approved change is built, reviewed and merged:
 *   draft ─[approve]─► ready ─► running ─► awaiting_review ─[approve]─► approved ─► mr_open ─► merged
 *   While running, the reviewer's findings go back to the author for a few rounds before the gate. While mr_open,
 *   feedback picked up on the MR makes the change ready again (reworked and pushed to the same MR), or escalated
 *   when it must wait for the owner.
 */

export const DOC_STAGES = ['requirements', 'spec', 'changes', 'development'] as const;
export type DocStage = (typeof DOC_STAGES)[number];
/** Stages that produce one document and close with a single gate. */
export type GatedStage = 'requirements' | 'spec';
export type Stage = DocStage | 'done' | 'abandoned';

export const STAGE_LABEL: Readonly<Record<Stage, string>> = {
  requirements: 'requirements',
  spec: 'epic spec',
  changes: 'change specs',
  development: 'development',
  done: 'done',
  abandoned: 'abandoned',
};

export const ARTIFACT_FILE: Readonly<Record<GatedStage, string>> = {
  requirements: 'requirements.md',
  spec: 'epic-spec.md',
};

export const IDEA_FILE = 'idea.md';

export const changeFile =(changeId: string): string => `changes/${changeId}.md`;

/**
 * `ready`: the stage agent may run. `awaiting_answers`: the agent paused with questions for the human.
 * `awaiting_approval`: a human gate is open.
 */
export type DocStatus = 'ready' | 'running' | 'awaiting_answers' | 'awaiting_approval';

export type QuestionOption = {
  readonly label: string;
  readonly description?: string;
  /** The agent's own pick, if it has one. */
  readonly recommended?: boolean;
};

/** A question a stage agent asked mid-run. The run pauses until the human answers. */
export type Question = {
  readonly id: string;
  /** A few words naming the topic, e.g. "Priority shape". */
  readonly header?: string;
  readonly text: string;
  readonly why: string;
  readonly options: readonly QuestionOption[];
  /** The owner may pick several options. */
  readonly multiSelect?: boolean;
};

/** Logs written before options had descriptions stored them as plain strings. */
const normalizeOptions = (options: readonly (QuestionOption | string)[]): readonly QuestionOption[] =>
  options.map((o) => (typeof o === 'string' ? { label: o } : o));

export type Answer = { readonly text: string; readonly by: string; readonly at: string };

export type AskedQuestion = Question & { readonly round: number; readonly answer?: Answer };

/** The conversation of a single-document stage: one agent session, paused and resumed around questions. */
export type StageDialog = {
  readonly stage: GatedStage;
  /** Undefined once the session can't be resumed (e.g. after sending the stage back). */
  readonly sessionId?: string;
  /** Last running total the SDK reported for the session: the baseline for the next resumed run. */
  readonly sessionCostUsd?: number;
  readonly rounds: number;
  /** Answers up to this round have been handed to the agent. */
  readonly delivered: number;
  readonly questions: readonly AskedQuestion[];
};

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

/**
 * Where a review finding stands. `open`: still to fix. `fixed`: the reviewer saw it fixed. `disputed`: the author
 * explained why it should not change. `needs_input`: the author needs the owner to decide. `invalid`: the reviewer
 * or the owner dismissed it. Logs from before the review loop have no status: read it as open.
 */
export type FindingStatus = 'open' | 'fixed' | 'disputed' | 'needs_input' | 'invalid';

export type Finding = {
  /** F1, F2…: stable across reviews of the same change, so a later review can say which ones are fixed. */
  readonly id?: string;
  readonly severity: 'blocking' | 'advisory';
  readonly summary: string;
  readonly file?: string;
  readonly line?: number;
  readonly detail?: string;
  readonly status?: FindingStatus;
  /** The latest word on it: the author's reason or question, the reviewer's verdict, or the owner's note. */
  readonly note?: string;
};

/** How the building agent answered one finding or one piece of MR feedback. */
export type ResponseOutcome = 'fixed' | 'not_fixing' | 'needs_input';

export type FeedbackResponse = {
  readonly id: string;
  readonly outcome: ResponseOutcome;
  /** What was done, why not, or (for needs_input) the question for the owner. Posted on the MR for MR feedback. */
  readonly reply: string;
};

export type ThreadNote = { readonly author: string; readonly body: string };

/** Something on an open MR that forge picked up for its agent: a thread that mentions it, or a failed pipeline. */
export type MergeRequestFeedbackItem =
  | {
      readonly id: string;
      readonly kind: 'comment';
      readonly discussionId: string;
      /** The notes that asked for forge (they are not picked up twice). */
      readonly noteIds: readonly number[];
      /** The thread up to the last of those notes, oldest first. */
      readonly thread: readonly ThreadNote[];
      readonly file?: string;
      readonly line?: number;
    }
  | {
      readonly id: string;
      readonly kind: 'ci';
      readonly pipelineId: number;
      /** Failed job names and log tails, normalized: the same failure twice in a row stops the automatic fixes. */
      readonly signature: string;
      readonly jobs: readonly { readonly name: string; readonly log: string }[];
    };

/** MR feedback being worked on: picked up, answered by the agent, then replied to on the MR once pushed. */
export type MergeRequestFeedback = {
  readonly items: readonly MergeRequestFeedbackItem[];
  readonly responses?: readonly FeedbackResponse[];
};

/** Automatic reworks of an open MR since a human last acted on the change. */
export type MergeRequestAutomation = {
  readonly rounds: number;
  readonly ciRounds: number;
  /** The change's spend when the automatic reworks began, to cap what they spend. */
  readonly baselineCostUsd: number;
  readonly lastCiSignature?: string;
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

/**
 * A spec document forge publishes as an MR on the workspace repo, for the team to review there: the epic spec,
 * or one change spec.
 */
export type SpecReview = { readonly kind: 'epic' } | { readonly kind: 'change'; readonly changeId: string };

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
  /** The latest review's findings are on the MR as comments. Reset by every new review. */
  readonly reviewPosted?: boolean;
  /** Ids of findings already posted on the MR, so a finding still open after a rework is not posted again. */
  readonly postedFindings?: readonly string[];
  /** What this change's agents and reviews have spent. */
  readonly costUsd?: number;
  /** MR notes and pipelines forge already acted on (or chose to ignore). */
  readonly handledNotes?: readonly number[];
  readonly handledPipelines?: readonly number[];
  readonly mergeRequestFeedback?: MergeRequestFeedback;
  readonly automation?: MergeRequestAutomation;
  /** The MR's head is a commit forge did not push: automatic fixes wait until forge pushes again. */
  readonly foreignHead?: string;
};

/**
 * A chat thread: one per agent the human can talk to. The single-document stages and the change set are
 * named by their stage; each change by its id.
 */
export type ChatThread = 'requirements' | 'spec' | 'changes' | (string & {});

export type ChatRole = 'human' | 'agent' | 'forge';

export type ChatEntry = {
  readonly role: ChatRole;
  readonly text: string;
  readonly at: string;
  readonly by: string;
  /** For an agent reply that asked for a change: the instruction handed to the agent that revises the work. */
  readonly feedback?: string;
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
  /** Questions and answers of the current single-document stage. */
  readonly dialog?: StageDialog;
  /** Conversations of approved stages, kept for reference (and restored if the epic is sent back). */
  readonly pastDialogs: Partial<Record<GatedStage, StageDialog>>;
  readonly lastError?: string;
  readonly costUsd: number;
  /** Chat threads with the epic's agents, by thread. */
  readonly chats: Readonly<Record<string, readonly ChatEntry[]>>;
  /** The MR on the workspace repo holding the epic spec (the latest one). */
  readonly specMergeRequest?: MergeRequestRef;
  /**
   * The MR on the workspace repo holding each change spec, by change id. Kept apart from `changes`: a change sent
   * back and redrafted under the same id continues its open MR.
   */
  readonly changeSpecMergeRequests: Readonly<Record<string, MergeRequestRef>>;
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
  | {
      readonly type: 'StageStarted';
      readonly stage: DocStage;
      readonly snapshots?: readonly RepoSnapshot[];
      /** Set when a paused session resumes: answers up to this round have now been given to the agent. */
      readonly deliveredRound?: number;
    }
  | ({
      readonly type: 'ArtifactProduced';
      readonly stage: GatedStage;
      readonly sessionId?: string;
      readonly sessionCostUsd?: number;
    } & Cost)
  | ({
      readonly type: 'QuestionsAsked';
      readonly stage: GatedStage;
      readonly questions: readonly Question[];
      readonly sessionId: string;
      readonly sessionCostUsd: number;
    } & Cost)
  | { readonly type: 'QuestionAnswered'; readonly stage: GatedStage; readonly questionId: string; readonly answer: string }
  | ({ readonly type: 'StageFailed'; readonly stage: DocStage; readonly reason: string } & Cost)
  | { readonly type: 'GateApproved'; readonly stage: GatedStage; readonly note?: string }
  /** Every live change spec is approved: the epic moves on to development. */
  | { readonly type: 'ChangeSetApproved'; readonly note?: string }
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
  | ({
      readonly type: 'ChangeStarted';
      readonly branch: string;
      /** Read-only snapshots of other repos holding merged dependencies, as the agent saw them. */
      readonly dependencySnapshots?: readonly RepoSnapshot[];
    } & ChangeRef)
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
  | ({
      readonly type: 'ChangeReviewed';
      readonly findings: readonly Finding[];
      readonly gateRequired: boolean;
      /** Why the automatic fix rounds stopped with findings still open, if they did. */
      readonly autofixStopped?: string;
    } & ChangeRef &
      Cost)
  /** The review found what the author must fix first: the author gets another round before anyone else looks. */
  | ({ readonly type: 'ReviewFixRequested'; readonly round: number; readonly findings: readonly Finding[] } & ChangeRef & Cost)
  /** The author's answer to each finding it was asked to fix. */
  | ({ readonly type: 'FindingsAnswered'; readonly responses: readonly FeedbackResponse[] } & ChangeRef)
  /** The owner set a finding aside (it is not raised again), or opened it again. */
  | ({ readonly type: 'FindingDismissed'; readonly findingId: string; readonly note?: string } & ChangeRef)
  | ({ readonly type: 'FindingReopened'; readonly findingId: string } & ChangeRef)
  | ({ readonly type: 'ChangeApproved'; readonly note?: string } & ChangeRef)
  | ({ readonly type: 'ChangeReworkRequested'; readonly note: string } & ChangeRef)
  | ({ readonly type: 'MergeRequestOpened'; readonly iid: number; readonly url: string } & ChangeRef)
  | ({
      readonly type: 'ReviewCommentsPosted';
      readonly iid: number;
      readonly inline: number;
      readonly general: number;
      readonly findingIds?: readonly string[];
    } & ChangeRef)
  /**
   * The MR watcher picked up threads that mention forge, or a failed pipeline. With `held` the automatic fixes
   * stopped (a limit was hit) and the change waits for its owner; otherwise it is reworked straight away.
   */
  | ({
      readonly type: 'MergeRequestFeedbackReceived';
      readonly iid: number;
      readonly items: readonly MergeRequestFeedbackItem[];
      /** Notes and pipelines looked at and deliberately left alone (not a member, a bot, no failing job that counts). */
      readonly ignoredNotes?: readonly number[];
      readonly ignoredPipelines?: readonly number[];
      readonly held?: string;
    } & ChangeRef)
  | ({ readonly type: 'MergeRequestFeedbackAnswered'; readonly responses: readonly FeedbackResponse[] } & ChangeRef)
  /** Forge answered each picked-up thread (and failed pipeline) on the MR after pushing the rework. */
  | ({ readonly type: 'MergeRequestFeedbackReplied'; readonly iid: number; readonly commit: string } & ChangeRef)
  /** Someone else pushed to the MR: forge stops fixing it automatically until forge pushes again. */
  | ({ readonly type: 'MergeRequestWatchPaused'; readonly headSha: string } & ChangeRef)
  /**
   * The owner hands an escalated change with an open MR back to the watcher as it is: no rework, held feedback set
   * aside, the automatic rework count started again.
   */
  | ({ readonly type: 'MergeRequestWatchResumed'; readonly note?: string } & ChangeRef)
  | ({ readonly type: 'ChangeMerged' } & ChangeRef)
  /** Without `changeId`: the epic spec's MR. */
  | { readonly type: 'SpecMergeRequestOpened'; readonly changeId?: string; readonly iid: number; readonly url: string }
  /** The MR of a change spec that was dropped or left the plan was closed. */
  | ({ readonly type: 'SpecMergeRequestClosed'; readonly iid: number } & ChangeRef)
  | { readonly type: 'EpicAbandoned'; readonly note: string }
  | {
      readonly type: 'ChatMessage';
      readonly thread: ChatThread;
      readonly role: ChatRole;
      readonly text: string;
      readonly feedback?: string;
      readonly costUsd?: number;
    };

export type EpicEvent = EventBody & { readonly at: string; readonly by: string };
export type EpicEventType = EpicEvent['type'];

export const stageIndex = (stage: Stage): number => ['requirements', 'spec', 'changes', 'development', 'done', 'abandoned'].indexOf(stage);

const nextStage = (stage: GatedStage): DocStage => (stage === 'requirements' ? 'spec' : 'changes');

const dialogFor = (e: Epic, stage: GatedStage): StageDialog =>
  e.dialog?.stage === stage ? e.dialog : { stage, rounds: 0, delivered: 0, questions: [] };

/** What the owner chose for one question. */
export type Choice =
  | { readonly kind: 'options'; readonly labels: readonly string[] }
  | { readonly kind: 'other'; readonly text: string }
  | { readonly kind: 'agent' };

export const AGENT_DECIDES = 'No preference: use your judgment, and say what you chose in Decisions.';

/** The answer text the agent receives. Picking an option sends its label (and description, for context). */
export const answerText = (q: Question, choice: Choice): string => {
  if (choice.kind === 'agent') return AGENT_DECIDES;
  if (choice.kind === 'other') return choice.text.trim();
  return choice.labels
    .map((label) => {
      const o = q.options.find((x) => x.label === label);
      return o?.description ? `${label} (${o.description})` : label;
    })
    .join('; ');
};

/**
 * Typed answers from the CLI and TUI: "2" or "1,3" pick options by number, empty leaves it to the
 * agent, anything else is the answer itself.
 */
export const choiceFromInput = (q: Question, input: string): Choice => {
  const text = input.trim();
  if (!text) return { kind: 'agent' };
  const picks = text.split(/[\s,]+/).map(Number);
  const valid = q.options.length > 0 && picks.every((n) => Number.isInteger(n) && n >= 1 && n <= q.options.length);
  if (!valid || (!q.multiSelect && picks.length > 1)) return { kind: 'other', text };
  return { kind: 'options', labels: [...new Set(picks)].map((n) => q.options[n - 1]!.label) };
};

/** A stage's conversation: the live one if it is the current stage, else the one kept when it was approved. */
export const stageDialog = (e: Epic, stage: GatedStage): StageDialog | undefined =>
  e.dialog?.stage === stage ? e.dialog : e.pastDialogs[stage];

/** Questions still waiting for a human answer. */
export const openQuestions = (e: Epic): readonly AskedQuestion[] => e.dialog?.questions.filter((q) => !q.answer) ?? [];

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
      return {
        ...e,
        status: 'running',
        lastError: undefined,
        dialog: ev.deliveredRound !== undefined && e.dialog ? { ...e.dialog, delivered: ev.deliveredRound } : e.dialog,
      };
    case 'ArtifactProduced':
      return addCost(
        {
          ...e,
          status: 'awaiting_approval',
          revision: e.revision + 1,
          pendingFeedback: [],
          dialog: ev.sessionId ? { ...dialogFor(e, ev.stage), sessionId: ev.sessionId, sessionCostUsd: ev.sessionCostUsd } : e.dialog,
        },
        ev.costUsd,
      );
    case 'QuestionsAsked': {
      const d = dialogFor(e, ev.stage);
      const round = d.rounds + 1;
      return addCost(
        {
          ...e,
          status: 'awaiting_answers',
          dialog: {
            ...d,
            sessionId: ev.sessionId,
            sessionCostUsd: ev.sessionCostUsd,
            rounds: round,
            questions: [...d.questions, ...ev.questions.map((q) => ({ ...q, options: normalizeOptions(q.options), round }))],
          },
        },
        ev.costUsd,
      );
    }
    case 'QuestionAnswered': {
      const d = dialogFor(e, ev.stage);
      const questions = d.questions.map((q) => (q.id === ev.questionId ? { ...q, answer: { text: ev.answer, by: ev.by, at: ev.at } } : q));
      // Once every question has an answer the agent can be resumed.
      const open = questions.some((q) => !q.answer);
      return { ...e, status: open ? 'awaiting_answers' : 'ready', dialog: { ...d, questions } };
    }
    case 'StageFailed':
      return addCost({ ...e, status: 'ready', lastError: ev.reason }, ev.costUsd);
    case 'GateApproved': {
      const pastDialogs = e.dialog?.stage === ev.stage ? { ...e.pastDialogs, [ev.stage]: e.dialog } : e.pastDialogs;
      const moved = { ...e, stage: nextStage(ev.stage), status: 'ready' as const, dialog: undefined, pastDialogs };
      return ev.note ? note(moved, { stage: ev.stage, kind: 'approve', text: ev.note, ...stamp }) : moved;
    }
    case 'ChangeSetApproved': {
      const moved = { ...e, stage: 'development' as const, status: 'ready' as const, pendingFeedback: [] };
      return ev.note ? note(moved, { stage: 'changes', kind: 'approve', text: ev.note, ...stamp }) : moved;
    }
    case 'RevisionRequested':
      return note(
        { ...e, status: 'ready', pendingFeedback: [...e.pendingFeedback, ev.note] },
        { stage: ev.stage, kind: 'revise', text: ev.note, ...stamp },
      );
    case 'SentBack': {
      // Answers stay useful context; the old session does not. Stages from `to` on are redone.
      const kept = stageDialog(e, ev.to);
      const pastDialogs = Object.fromEntries(
        Object.entries(e.pastDialogs).filter(([stage]) => stageIndex(stage as GatedStage) < stageIndex(ev.to)),
      ) as Epic['pastDialogs'];
      return note(
        {
          ...e,
          stage: ev.to,
          status: 'ready',
          changes: [],
          pendingFeedback: [ev.note],
          dialog: kept && { ...kept, sessionId: undefined, sessionCostUsd: undefined },
          pastDialogs,
        },
        { stage: ev.to, kind: 'back', text: ev.note, ...stamp },
      );
    }
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
        reviewPosted: false,
        status: ev.gateRequired ? 'awaiting_review' : 'approved',
      }));
    case 'ReviewFixRequested':
      return updateChange(addCost(e, ev.costUsd), ev.changeId, (c) => ({ ...c, findings: ev.findings }));
    case 'FindingsAnswered':
      return updateChange(e, ev.changeId, (c) => ({ ...c, findings: applyResponses(c.findings, ev.responses) }));
    case 'FindingDismissed':
      return updateChange(e, ev.changeId, (c) => ({
        ...c,
        findings: c.findings.map((f) => (f.id === ev.findingId ? { ...f, status: 'invalid', note: ev.note ?? `dismissed by ${ev.by}` } : f)),
      }));
    case 'FindingReopened':
      return updateChange(e, ev.changeId, (c) => ({
        ...c,
        findings: c.findings.map((f) => (f.id === ev.findingId ? { ...f, status: 'open', note: `reopened by ${ev.by}` } : f)),
      }));
    case 'ChangeApproved': {
      // Approving the code settles the questions it left for the owner.
      const approved = updateChange(e, ev.changeId, (c) => ({
        ...c,
        status: 'approved',
        automation: undefined,
        findings: c.findings.map((f) => (f.status === 'needs_input' ? { ...f, status: 'invalid', note: `settled: ${ev.by} approved the code` } : f)),
      }));
      return ev.note
        ? note(approved, { stage: 'development', kind: 'approve', text: ev.note, changeId: ev.changeId, ...stamp })
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
          automation: undefined,
          // The owner's feedback answers the questions left for them: the reviewer judges those findings again.
          findings: c.findings.map((f) => (f.status === 'needs_input' ? { ...f, status: 'open', note: `the owner answered: ${ev.note}` } : f)),
        })),
        { stage: 'development', kind: 'revise', text: ev.note, changeId: ev.changeId, ...stamp },
      );
    case 'MergeRequestOpened':
      // Forge just pushed: whatever someone else pushed before is now under forge's commit.
      return updateChange(e, ev.changeId, (c) => ({ ...c, status: 'mr_open', mergeRequest: { iid: ev.iid, url: ev.url }, foreignHead: undefined }));
    case 'ReviewCommentsPosted':
      return updateChange(e, ev.changeId, (c) => ({
        ...c,
        reviewPosted: true,
        postedFindings: [...(c.postedFindings ?? []), ...(ev.findingIds ?? [])],
      }));
    case 'MergeRequestFeedbackReceived':
      return updateChange(e, ev.changeId, (c) => {
        const handledNotes = [
          ...(c.handledNotes ?? []),
          ...ev.items.flatMap((i) => (i.kind === 'comment' ? i.noteIds : [])),
          ...(ev.ignoredNotes ?? []),
        ];
        const handledPipelines = [
          ...(c.handledPipelines ?? []),
          ...ev.items.flatMap((i) => (i.kind === 'ci' ? [i.pipelineId] : [])),
          ...(ev.ignoredPipelines ?? []),
        ];
        if (ev.items.length === 0) return { ...c, handledNotes, handledPipelines };
        // Feedback the agent has not answered yet (the change was held) is kept with the new one.
        const pending = c.mergeRequestFeedback && !c.mergeRequestFeedback.responses ? c.mergeRequestFeedback.items : [];
        const withFeedback: ChangeState = { ...c, handledNotes, handledPipelines, mergeRequestFeedback: { items: [...pending, ...ev.items] } };
        if (ev.held) return { ...withFeedback, status: 'escalated', escalation: ev.held };
        const ci = ev.items.find((i) => i.kind === 'ci');
        return {
          ...withFeedback,
          status: 'ready',
          failures: [],
          escalation: undefined,
          automation: {
            rounds: (c.automation?.rounds ?? 0) + 1,
            ciRounds: (c.automation?.ciRounds ?? 0) + (ci ? 1 : 0),
            baselineCostUsd: c.automation?.baselineCostUsd ?? c.costUsd ?? 0,
            lastCiSignature: ci?.kind === 'ci' ? ci.signature : c.automation?.lastCiSignature,
          },
        };
      });
    case 'MergeRequestFeedbackAnswered':
      return updateChange(e, ev.changeId, (c) =>
        c.mergeRequestFeedback ? { ...c, mergeRequestFeedback: { ...c.mergeRequestFeedback, responses: ev.responses } } : c,
      );
    case 'MergeRequestFeedbackReplied':
      return updateChange(e, ev.changeId, (c) => ({ ...c, mergeRequestFeedback: undefined }));
    case 'MergeRequestWatchPaused':
      return updateChange(e, ev.changeId, (c) => ({ ...c, foreignHead: ev.headSha }));
    case 'MergeRequestWatchResumed':
      return updateChange(e, ev.changeId, (c) => ({
        ...c,
        status: 'mr_open',
        escalation: undefined,
        automation: undefined,
        mergeRequestFeedback: undefined,
        findings: c.findings.map((f) => (f.status === 'needs_input' ? { ...f, status: 'invalid', note: `settled: ${ev.by} resumed the MR as it is` } : f)),
      }));
    case 'ChangeMerged': {
      const next = updateChange(e, ev.changeId, (c) => ({ ...c, status: 'merged' }));
      return finished(next.changes) ? { ...next, stage: 'done' } : next;
    }
    case 'SpecMergeRequestOpened': {
      const mr = { iid: ev.iid, url: ev.url };
      return ev.changeId === undefined
        ? { ...e, specMergeRequest: mr }
        : { ...e, changeSpecMergeRequests: { ...e.changeSpecMergeRequests, [ev.changeId]: mr } };
    }
    case 'SpecMergeRequestClosed': {
      const { [ev.changeId]: _closed, ...rest } = e.changeSpecMergeRequests;
      return { ...e, changeSpecMergeRequests: rest };
    }
    case 'ChatMessage': {
      const entry: ChatEntry = { role: ev.role, text: ev.text, ...stamp, ...(ev.feedback ? { feedback: ev.feedback } : {}) };
      return addCost({ ...e, chats: { ...e.chats, [ev.thread]: [...(e.chats[ev.thread] ?? []), entry] } }, ev.costUsd);
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
    stage: 'requirements',
    status: 'ready',
    revision: 0,
    pendingFeedback: [],
    notes: [],
    changes: [],
    pastDialogs: {},
    costUsd: 0,
    chats: {},
    changeSpecMergeRequests: {},
  };
  return rest.reduce((e, ev) => ({ ...addChangeCost(applyEvent(e, ev), ev), updatedAt: ev.at }), initial);
};

/** Spend recorded on a change's events also counts towards that change. */
const addChangeCost = (e: Epic, ev: EpicEvent): Epic => {
  if (ev.type === 'ChatMessage' || !('changeId' in ev) || !ev.changeId || !('costUsd' in ev) || !ev.costUsd) return e;
  const costUsd = ev.costUsd;
  return updateChange(e, ev.changeId, (c) => ({ ...c, costUsd: (c.costUsd ?? 0) + costUsd }));
};

/** The author's answers, applied to the findings it was asked to fix. Pure. */
export const applyResponses = (findings: readonly Finding[], responses: readonly FeedbackResponse[]): readonly Finding[] => {
  const byId = new Map(responses.map((r) => [r.id, r]));
  return findings.map((f): Finding => {
    const r = f.id ? byId.get(f.id) : undefined;
    if (!r) return f;
    // A fix is for the reviewer to confirm; the finding stays open until then.
    if (r.outcome === 'fixed') return { ...f, note: r.reply };
    return { ...f, status: r.outcome === 'not_fixing' ? 'disputed' : 'needs_input', note: r.reply };
  });
};

/** A finding nobody has settled yet: still to fix, disputed by the author, or waiting on the owner. */
export const unresolved = (f: Finding): boolean =>
  f.status === undefined || f.status === 'open' || f.status === 'disputed' || f.status === 'needs_input';

/** Live changes: everything not dropped. */
export const liveChanges = (e: Epic): readonly ChangeState[] => e.changes.filter((c) => c.status !== 'dropped');

/** Its spec is approved: anything past drafting (epics from before the development stage may have built some already). */
export const specApproved = (c: ChangeState): boolean => c.status !== 'draft' && c.status !== 'revising' && c.status !== 'dropped';

/** The change set is ready for the development gate: at least one live change, every one with an approved spec. */
export const changeSetApproved = (e: Epic): boolean => liveChanges(e).length > 0 && liveChanges(e).every(specApproved);

/** A change, or the epic, is waiting on a human. */
export const needsHuman = (e: Epic): boolean =>
  ((e.stage === 'requirements' || e.stage === 'spec') && (e.status === 'awaiting_approval' || e.status === 'awaiting_answers')) ||
  (e.stage === 'changes' && e.status !== 'running' && changeSetApproved(e)) ||
  e.changes.some((c) => c.status === 'draft' || c.status === 'awaiting_review' || c.status === 'escalated');
