/**
 * Renderer view model: pure state, reducer and "what can I do here" rules. No React, no DOM, no IPC.
 */
import { changeSetApproved, DOC_STAGES, needsHuman, stageDialog, stageIndex, type ChangeState, type DocStage, type Epic, type Stage } from '../../domain/epic.ts';
import type { Outcome, WorkspaceInfo } from '../shared/api.ts';

export type Tab = 'idea' | 'questions' | 'requirements' | 'spec' | 'change' | 'review' | 'diff' | 'history';

export type NoteSpec = { readonly title: string; readonly label: string; readonly required: boolean; readonly confirm: string };

export type ActionId =
  | 'run'
  | 'force-run'
  | 'stop'
  | 'approve'
  | 'approve-all'
  | 'revise'
  | 'drop'
  | 'back'
  | 'abandon'
  | 'sync'
  | 'assign'
  | 'answer';

export type ActionSpec = {
  readonly id: ActionId;
  readonly label: string;
  readonly kind: 'primary' | 'secondary' | 'danger';
  /** The change it applies to; undefined = the epic (gate or whole change set). */
  readonly changeId?: string;
  /** Ask for a note before running the action. */
  readonly note?: NoteSpec;
};

export type Dialog =
  | { readonly kind: 'note'; readonly action: ActionSpec; readonly slug: string }
  | { readonly kind: 'new-epic' }
  | { readonly kind: 'back'; readonly slug: string }
  | { readonly kind: 'assign'; readonly slug: string; readonly owner: string }
  | { readonly kind: 'settings' }
  | { readonly kind: 'repos'; readonly setupRoot: string | null };

export type State = {
  readonly workspace: WorkspaceInfo | null;
  readonly recent: readonly string[];
  readonly epics: readonly Epic[];
  readonly selected: string | undefined;
  readonly changeId: string | undefined;
  /** The stage whose documents are shown; undefined = follow the epic's current stage. */
  readonly view: DocStage | undefined;
  /** undefined = follow whatever needs a decision. */
  readonly tab: Tab | undefined;
  readonly filter: 'all' | 'mine';
  readonly busy: readonly string[];
  readonly toast: (Outcome & { readonly id: number }) | undefined;
  readonly dialog: Dialog | undefined;
  /** Bumped to refetch the open document after a save. */
  readonly revision: number;
};

export const initialState: State = {
  workspace: null,
  recent: [],
  epics: [],
  selected: undefined,
  changeId: undefined,
  view: undefined,
  tab: undefined,
  filter: 'all',
  busy: [],
  toast: undefined,
  dialog: undefined,
  revision: 0,
};

export type Action =
  | { readonly type: 'workspace'; readonly workspace: WorkspaceInfo | null; readonly recent?: readonly string[] }
  | { readonly type: 'epics'; readonly epics: readonly Epic[]; readonly select?: string }
  | { readonly type: 'select'; readonly slug: string }
  | { readonly type: 'select-change'; readonly changeId: string | undefined }
  | { readonly type: 'view'; readonly view: DocStage | undefined }
  | { readonly type: 'tab'; readonly tab: Tab | undefined }
  | { readonly type: 'filter'; readonly filter: 'all' | 'mine' }
  | { readonly type: 'busy'; readonly busy: readonly string[] }
  | { readonly type: 'toast'; readonly outcome: Outcome | undefined }
  | { readonly type: 'dialog'; readonly dialog: Dialog | undefined }
  | { readonly type: 'saved' };

let toastId = 0;

export const visibleEpics = (s: State): readonly Epic[] =>
  s.filter === 'mine' && s.workspace ? s.epics.filter((e) => e.owner === s.workspace!.actor) : s.epics;

export const selectedEpic = (s: State): Epic | undefined => s.epics.find((e) => e.slug === s.selected);

export const selectedChange = (s: State): ChangeState | undefined => selectedEpic(s)?.changes.find((c) => c.id === s.changeId);

/** The change most in need of a decision: drafts and reviews first, then escalations, then the first. */
export const focusChange = (e: Epic): ChangeState | undefined => {
  const order: readonly ChangeState['status'][] = ['awaiting_review', 'draft', 'escalated', 'revising', 'ready', 'running', 'mr_open', 'approved', 'merged', 'dropped'];
  return [...e.changes].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status))[0];
};

export const reducer = (s: State, a: Action): State => {
  switch (a.type) {
    case 'workspace':
      return { ...initialState, workspace: a.workspace, recent: a.recent ?? s.recent, filter: s.filter };
    case 'epics': {
      const want = a.select ?? s.selected;
      const selected = a.epics.some((e) => e.slug === want) ? want : a.epics[0]?.slug;
      const epic = a.epics.find((e) => e.slug === selected);
      const keepChange = selected === s.selected && epic?.changes.some((c) => c.id === s.changeId);
      // Same epic, same stage: keep what the user is looking at. A new stage brings its own documents.
      const stay = selected === s.selected && !a.select && epic?.stage === selectedEpic(s)?.stage;
      return {
        ...s,
        epics: a.epics,
        selected,
        changeId: keepChange ? s.changeId : epic && focusChange(epic)?.id,
        view: stay ? s.view : undefined,
        tab: stay ? s.tab : undefined,
      };
    }
    case 'select': {
      if (a.slug === s.selected) return s;
      const epic = s.epics.find((e) => e.slug === a.slug);
      return { ...s, selected: a.slug, changeId: epic && focusChange(epic)?.id, view: undefined, tab: undefined };
    }
    case 'select-change':
      return { ...s, changeId: a.changeId, tab: s.tab === 'history' ? s.tab : undefined };
    case 'view':
      return { ...s, view: a.view, tab: undefined };
    case 'tab':
      return { ...s, tab: a.tab };
    case 'filter':
      return { ...s, filter: a.filter };
    case 'busy':
      return { ...s, busy: a.busy };
    case 'toast':
      return { ...s, toast: a.outcome && { ...a.outcome, id: ++toastId } };
    case 'dialog':
      return { ...s, dialog: a.dialog };
    case 'saved':
      return { ...s, revision: s.revision + 1 };
  }
};

/** The stage an epic is in, as a view; a finished or abandoned epic shows its changes. */
export const stageView = (e: Epic): DocStage => ((DOC_STAGES as readonly Stage[]).includes(e.stage) ? (e.stage as DocStage) : 'changes');

/** Stages the user can look at: the current one and those before it. */
export const canView = (e: Epic, stage: DocStage): boolean => stageIndex(stage) <= stageIndex(stageView(e));

export const currentView = (s: State): DocStage => {
  const e = selectedEpic(s);
  if (!e) return 'requirements';
  return s.view && canView(e, s.view) ? s.view : stageView(e);
};

/** Each stage shows only its own documents; History is the epic's audit trail and shows everywhere. */
export const tabsFor = (e: Epic, view: DocStage, change: ChangeState | undefined): readonly Tab[] => {
  const questions: Tab[] = (view === 'requirements' || view === 'spec') && stageDialog(e, view)?.questions.length ? ['questions'] : [];
  if (view === 'requirements') return ['idea', ...questions, 'requirements', 'history'];
  if (view === 'spec') return [...questions, 'spec', 'history'];
  if (!change) return ['history'];
  if (view === 'changes') return ['change', 'history'];
  return ['change', 'review', ...(change.branch ? (['diff'] as Tab[]) : []), 'history'];
};

/** The tab to show when the user has not picked one: whatever the next decision is about. */
export const defaultTab = (e: Epic, change: ChangeState | undefined, view: DocStage = stageView(e)): Tab => {
  if (e.status === 'awaiting_answers' && e.dialog?.stage === view) return 'questions';
  if (view === 'requirements')
    return e.stage === 'requirements' && e.revision === 0 ? (e.dialog?.questions.length ? 'questions' : 'idea') : 'requirements';
  if (view === 'spec') return 'spec';
  if (!change) return 'history';
  if (view === 'changes') return 'change';
  if (change.status === 'awaiting_review' || change.status === 'escalated' || change.status === 'mr_open' || change.status === 'merged')
    return 'review';
  return 'change';
};

export const currentTab = (s: State): Tab => {
  const e = selectedEpic(s);
  if (!e) return 'idea';
  const view = currentView(s);
  const change = selectedChange(s);
  return s.tab && tabsFor(e, view, change).includes(s.tab) ? s.tab : defaultTab(e, change, view);
};

/**
 * Chat threads for what is on screen, the most specific first: the stage's agent, or the selected change's
 * agent (with the change set as a second thread while change specs are drafted).
 */
export const chatThreads = (e: Epic, view: DocStage, change: ChangeState | undefined): readonly string[] => {
  if (view === 'requirements' || view === 'spec') return [view];
  if (view === 'changes') return change ? [change.id, 'changes'] : ['changes'];
  return change ? [change.id] : [];
};

export type StepState = 'done' | 'current' | 'gate' | 'todo';

export const stepState = (e: Epic, stage: Stage): StepState => {
  const at = stageIndex(e.stage);
  const mine = stageIndex(stage);
  if (e.stage === 'done' || mine < at) return 'done';
  if (mine > at) return 'todo';
  if (stage === 'changes') return e.status !== 'running' && changeSetApproved(e) ? 'gate' : 'current';
  return stage !== 'development' && (e.status === 'awaiting_approval' || e.status === 'awaiting_answers') ? 'gate' : 'current';
};

const note = (title: string, label: string, required: boolean, confirm: string): NoteSpec => ({ title, label, required, confirm });

/** In the change specs stage, a run drafts, redrafts, builds unblocked changes, or retries opening MRs. */
export const runWouldDoSomething = (e: Epic): boolean => {
  if (e.stage === 'changes') return e.changes.length === 0 || e.pendingFeedback.length > 0 || e.changes.some((c) => c.status === 'revising');
  const merged = new Set(e.changes.filter((c) => c.status === 'merged').map((c) => c.id));
  return e.changes.some((c) => c.status === 'approved' || (c.status === 'ready' && (c.spec?.dependsOn ?? []).every((d) => merged.has(d))));
};

/** Epic-level actions: the gate, the whole change set, and the epic itself. */
export const epicActions = (e: Epic, busy: boolean): readonly ActionSpec[] => {
  if (busy) return [{ id: 'stop', label: 'Stop agents', kind: 'danger' }];
  if (e.stage === 'done' || e.stage === 'abandoned') return [];
  const back: ActionSpec = { id: 'back', label: 'Send back…', kind: 'secondary' };
  const abandon: ActionSpec = { id: 'abandon', label: 'Abandon…', kind: 'danger', note: note('Abandon this epic?', 'Why', true, 'Abandon epic') };

  if (e.stage === 'requirements' || e.stage === 'spec') {
    if (e.status === 'running') return [{ id: 'force-run', label: 'Restart stage', kind: 'secondary' }, abandon];
    if (e.status === 'awaiting_answers') return [{ id: 'answer', label: 'Answer questions', kind: 'primary' }, abandon];
    if (e.status === 'awaiting_approval')
      return [
        { id: 'approve', label: e.stage === 'requirements' ? 'Approve requirements' : 'Approve epic spec', kind: 'primary', note: note('Approve', 'Note for the next stages (optional)', false, 'Approve') },
        ...(e.stage === 'spec' ? [back] : []),
        abandon,
      ];
    return [{ id: 'run', label: e.stage === 'requirements' ? 'Analyze requirements' : 'Write epic spec', kind: 'primary' }, ...(e.stage === 'spec' ? [back] : []), abandon];
  }

  // A drafting run that was cut off (app closed, crash) leaves the stage "running" with no agent attached.
  if (e.status === 'running') return [{ id: 'force-run', label: 'Restart stage', kind: 'primary' }, back, abandon];
  const runnable = runWouldDoSomething(e);

  if (e.stage === 'changes') {
    const drafts = e.changes.filter((c) => c.status === 'draft').length;
    const complete = changeSetApproved(e);
    return [
      ...(complete
        ? [{ id: 'approve' as const, label: 'Start development', kind: 'primary' as const, note: note('Approve the change set', 'Note for development (optional)', false, 'Start development') }]
        : []),
      ...(runnable ? [{ id: 'run' as const, label: e.changes.length === 0 ? 'Draft change specs' : 'Redraft', kind: complete ? ('secondary' as const) : ('primary' as const) }] : []),
      ...(drafts > 1 ? [{ id: 'approve-all' as const, label: `Approve all ${drafts} drafts`, kind: 'secondary' as const, note: note('Approve all drafts', 'Note (optional)', false, 'Approve all') }] : []),
      back,
      abandon,
    ];
  }

  return [
    ...(runnable ? [{ id: 'run' as const, label: 'Build ready changes', kind: 'primary' as const }] : []),
    ...(e.changes.some((c) => c.status === 'mr_open') ? [{ id: 'sync' as const, label: 'Sync MRs', kind: 'secondary' as const }] : []),
    ...(e.changes.some((c) => c.status === 'running') ? [{ id: 'force-run' as const, label: 'Recover interrupted', kind: 'secondary' as const }] : []),
    back,
    abandon,
  ];
};

/** Actions on the selected change, by its status. */
export const changeActions = (c: ChangeState, busy: boolean): readonly ActionSpec[] => {
  if (busy) return [];
  const id = c.id;
  const drop: ActionSpec = { id: 'drop', label: 'Drop…', kind: 'danger', changeId: id, note: note(`Drop ${id}?`, 'Why', true, 'Drop change') };
  switch (c.status) {
    case 'draft':
      return [
        { id: 'approve', label: 'Approve change spec', kind: 'primary', changeId: id, note: note(`Approve ${id}`, 'Note (optional)', false, 'Approve') },
        drop,
      ];
    case 'awaiting_review':
      return [
        { id: 'approve', label: 'Approve code & open MR', kind: 'primary', changeId: id, note: note(`Approve ${id}'s code`, 'Note (optional)', false, 'Approve and open MR') },
      ];
    case 'escalated':
      return [drop];
    case 'mr_open':
      return [{ id: 'sync', label: 'Sync MR', kind: 'secondary' }];
    case 'ready':
    case 'revising':
      return [drop];
    default:
      return [];
  }
};

export const changeHint = (c: ChangeState, stage: Stage = 'development'): string => {
  if (stage === 'changes' && c.status === 'ready') return 'Approved. It builds in development, once every change spec is approved.';
  switch (c.status) {
    case 'draft':
      return 'Draft. Read it, edit it if needed, then approve it, or ask its agent for changes in the chat.';
    case 'revising':
      return 'Feedback queued. It will be redrafted on the next run.';
    case 'ready':
      return c.spec?.dependsOn.length ? `Approved. Builds once ${c.spec.dependsOn.join(', ')} ${c.spec.dependsOn.length > 1 ? 'are' : 'is'} merged.` : 'Approved. Builds on the next run.';
    case 'running':
      return 'An agent is building this change.';
    case 'escalated':
      return `Needs your input: ${c.escalation ?? ''} Tell its agent what to do differently in the chat.`;
    case 'awaiting_review':
      return 'Built and reviewed. Check the findings and the diff, then approve the code, or ask for rework in the chat.';
    case 'approved':
      return 'Code approved. The MR opens on the next run (the last attempt failed).';
    case 'mr_open':
      return 'MR open. Merge it in GitLab, then sync. Ask for rework in the chat.';
    case 'merged':
      return 'Merged.';
    case 'dropped':
      return 'Dropped.';
  }
};

export const epicHint = (e: Epic, busy: boolean): string => {
  if (busy) return 'Agents are working on this epic.';
  if (e.stage === 'done') return 'Done: every change is merged.';
  if (e.stage === 'abandoned') return 'Abandoned.';
  if (e.status === 'running') return 'Marked as running, but no agent is attached in this app. Restart the stage if it was interrupted.';
  if (e.stage === 'requirements' || e.stage === 'spec') {
    if (e.status === 'awaiting_answers') {
      const n = e.dialog?.questions.filter((q) => !q.answer).length ?? 0;
      return `The ${e.stage === 'requirements' ? 'requirements' : 'epic spec'} agent paused with ${n} question${n === 1 ? '' : 's'} for you. Answer and it carries on.`;
    }
    if (e.status === 'awaiting_approval') return `Waiting for you: read the ${e.stage === 'requirements' ? 'requirements' : 'epic spec'}, edit it if needed, then approve it, or ask its agent for changes in the chat.`;
    return e.pendingFeedback.length ? 'Your feedback is queued. Run the agent to regenerate.' : `Next: run the ${e.stage === 'requirements' ? 'requirements agent' : 'epic spec agent'}.`;
  }
  if (e.stage === 'changes') {
    if (e.changes.length === 0) return 'Next: draft change specs from the approved epic spec.';
    const drafts = e.changes.filter((c) => c.status === 'draft');
    if (drafts.length) return `${drafts.length} change spec${drafts.length > 1 ? 's need' : ' needs'} you: ${drafts.map((c) => c.id).join(', ')}.`;
    if (changeSetApproved(e)) return 'Every change spec is approved. Start development to build them.';
    return 'Feedback queued. Redraft to address it.';
  }
  const waiting = e.changes.filter((c) => c.status === 'awaiting_review' || c.status === 'escalated');
  if (waiting.length) return `${waiting.length} change${waiting.length > 1 ? 's need' : ' needs'} you: ${waiting.map((c) => c.id).join(', ')}.`;
  return 'Nothing waiting on you. Build what is ready, or merge open MRs.';
};

export { needsHuman };
