/**
 * TUI state: a pure reducer plus a pure key map. Components render it; effects live in App.
 */
import { needsHuman, type ChangeState, type Epic } from '../domain/epic.ts';

export type Focus = 'epics' | 'changes' | 'viewer';

export type DocName = 'idea.md' | 'exploration.md' | 'epic-spec.md';
export const DOCS: readonly DocName[] = ['idea.md', 'exploration.md', 'epic-spec.md'];

export type View =
  | { readonly kind: 'doc'; readonly name: DocName }
  | { readonly kind: 'change-spec' }
  | { readonly kind: 'change' }
  | { readonly kind: 'diff' }
  | { readonly kind: 'log' }
  | { readonly kind: 'help' };

export type PromptKind =
  | 'approve'
  | 'approve-all'
  | 'revise'
  | 'back-stage'
  | 'back-note'
  | 'new-title'
  | 'new-idea'
  | 'abandon'
  | 'drop'
  | 'assign'
  | 'quit';

export type Prompt = {
  readonly kind: PromptKind;
  readonly label: string;
  readonly value: string;
  readonly required: boolean;
  /** Carried between the steps of a two-step prompt, or the change a prompt is about. */
  readonly context?: string;
};

export type Tone = 'info' | 'success' | 'error';

export type ActivityLine = { readonly label: string; readonly text: string };

export type UiState = {
  readonly actor: string;
  readonly all: readonly Epic[];
  readonly mineOnly: boolean;
  /** Index into `visibleEpics`. */
  readonly selected: number;
  readonly changeIndex: number;
  readonly focus: Focus;
  /** undefined = follow whatever needs attention. */
  readonly view: View | undefined;
  readonly scroll: number;
  readonly prompt: Prompt | undefined;
  readonly busy: readonly string[];
  readonly activity: readonly ActivityLine[];
  readonly message: { readonly text: string; readonly tone: Tone } | undefined;
};

export const initialState = (actor: string): UiState => ({
  actor,
  all: [],
  mineOnly: false,
  selected: 0,
  changeIndex: 0,
  focus: 'epics',
  view: undefined,
  scroll: 0,
  prompt: undefined,
  busy: [],
  activity: [],
  message: undefined,
});

export type UiAction =
  | { readonly type: 'loaded'; readonly epics: readonly Epic[]; readonly select?: string }
  | { readonly type: 'move'; readonly delta: number }
  | { readonly type: 'focus'; readonly focus?: Focus }
  | { readonly type: 'toggle-mine' }
  | { readonly type: 'view'; readonly view: View | undefined }
  | { readonly type: 'scroll'; readonly delta: number }
  | { readonly type: 'prompt'; readonly prompt: Prompt | undefined }
  | { readonly type: 'input'; readonly value: string }
  | { readonly type: 'busy'; readonly slug: string; readonly on: boolean }
  | { readonly type: 'activity'; readonly line: ActivityLine }
  | { readonly type: 'message'; readonly text: string; readonly tone: Tone };

const clamp = (n: number, max: number): number => Math.max(0, Math.min(n, Math.max(0, max)));

export const visibleEpics = (s: Pick<UiState, 'all' | 'mineOnly' | 'actor'>): readonly Epic[] =>
  s.mineOnly ? s.all.filter((e) => e.owner === s.actor) : s.all;

export const selectedEpic = (s: UiState): Epic | undefined => visibleEpics(s)[s.selected];

export const selectedChange = (s: UiState): ChangeState | undefined => selectedEpic(s)?.changes[s.changeIndex];

export const isBusy = (s: UiState, slug: string | undefined): boolean => slug !== undefined && s.busy.includes(slug);

const SPEC_STATUSES: readonly ChangeState['status'][] = ['draft', 'revising', 'ready', 'dropped'];

/** The view to show when the user has not picked one: whatever the next decision is about. */
export const defaultView = (e: Epic | undefined, change: ChangeState | undefined): View => {
  if (!e) return { kind: 'help' };
  if (e.stage === 'explore') return { kind: 'doc', name: e.revision === 0 ? 'idea.md' : 'exploration.md' };
  if (e.stage === 'spec') return { kind: 'doc', name: e.status === 'ready' && !e.pendingFeedback.length ? 'exploration.md' : 'epic-spec.md' };
  if (!change) return { kind: 'doc', name: 'epic-spec.md' };
  return SPEC_STATUSES.includes(change.status) ? { kind: 'change-spec' } : { kind: 'change' };
};

export const currentView = (s: UiState): View => s.view ?? defaultView(selectedEpic(s), selectedChange(s));

export { needsHuman };

/** What `a` approves: the selected change (its spec or its code), or the open stage gate. */
export const approvalTarget = (s: UiState): { readonly kind: 'change'; readonly change: ChangeState } | { readonly kind: 'stage' } | undefined => {
  const e = selectedEpic(s);
  if (!e) return undefined;
  if (e.stage !== 'changes') return { kind: 'stage' };
  const c = selectedChange(s);
  return c && (c.status === 'draft' || c.status === 'awaiting_review') ? { kind: 'change', change: c } : undefined;
};

/** What `v` revises: the selected change if it takes feedback, otherwise the stage (or the whole change set). */
export const revisionTarget = (s: UiState): { readonly kind: 'change'; readonly change: ChangeState } | { readonly kind: 'stage' } => {
  const c = selectedEpic(s)?.stage === 'changes' ? selectedChange(s) : undefined;
  const revisable: readonly ChangeState['status'][] = ['draft', 'revising', 'awaiting_review', 'escalated', 'mr_open'];
  return c && revisable.includes(c.status) ? { kind: 'change', change: c } : { kind: 'stage' };
};

const FOCUS_ORDER: readonly Focus[] = ['epics', 'changes', 'viewer'];

const reselect = (s: UiState, slug: string | undefined, next: Pick<UiState, 'all' | 'mineOnly' | 'actor'>): number => {
  const list = visibleEpics(next);
  const index = list.findIndex((e) => e.slug === slug);
  return index >= 0 ? index : clamp(s.selected, list.length - 1);
};

export const reducer = (s: UiState, a: UiAction): UiState => {
  switch (a.type) {
    case 'loaded': {
      const current = a.select ?? selectedEpic(s)?.slug;
      const next = { ...s, all: a.epics };
      const selected = reselect(s, current, next);
      const changed = selected !== s.selected || a.select !== undefined || visibleEpics(next)[selected]?.slug !== current;
      return {
        ...next,
        selected,
        changeIndex: changed ? 0 : clamp(s.changeIndex, (visibleEpics(next)[selected]?.changes.length ?? 1) - 1),
        view: changed ? undefined : s.view,
        scroll: changed ? 0 : s.scroll,
      };
    }
    case 'toggle-mine': {
      const current = selectedEpic(s)?.slug;
      const next = { ...s, mineOnly: !s.mineOnly };
      return { ...next, selected: reselect(s, current, next), changeIndex: 0, view: undefined, scroll: 0 };
    }
    case 'move': {
      if (s.focus === 'viewer') return { ...s, scroll: Math.max(0, s.scroll + a.delta) };
      if (s.focus === 'changes') {
        const max = (selectedEpic(s)?.changes.length ?? 1) - 1;
        const changeIndex = clamp(s.changeIndex + a.delta, max);
        return changeIndex === s.changeIndex ? s : { ...s, changeIndex, view: undefined, scroll: 0 };
      }
      const selected = clamp(s.selected + a.delta, visibleEpics(s).length - 1);
      return selected === s.selected ? s : { ...s, selected, changeIndex: 0, view: undefined, scroll: 0 };
    }
    case 'focus': {
      const hasChanges = (selectedEpic(s)?.changes.length ?? 0) > 0;
      const order = FOCUS_ORDER.filter((f) => f !== 'changes' || hasChanges);
      const focus = a.focus ?? order[(order.indexOf(s.focus) + 1) % order.length] ?? 'epics';
      return { ...s, focus };
    }
    case 'view':
      return { ...s, view: a.view, scroll: 0 };
    case 'scroll':
      return { ...s, scroll: Math.max(0, s.scroll + a.delta) };
    case 'prompt':
      return { ...s, prompt: a.prompt, message: a.prompt ? undefined : s.message };
    case 'input':
      return s.prompt ? { ...s, prompt: { ...s.prompt, value: a.value } } : s;
    case 'busy':
      return { ...s, busy: a.on ? [...s.busy, a.slug] : s.busy.filter((b) => b !== a.slug) };
    case 'activity':
      return { ...s, activity: [...s.activity, a.line].slice(-200) };
    case 'message':
      return { ...s, message: { text: a.text, tone: a.tone } };
  }
};

/** Side-effecting commands the App executes. */
export type Command =
  | { readonly type: 'run'; readonly force: boolean }
  | { readonly type: 'submit'; readonly prompt: Prompt }
  | { readonly type: 'edit' }
  | { readonly type: 'sync' }
  | { readonly type: 'quit' };

export type Intent = { readonly ui: UiAction } | { readonly command: Command };

export type KeyInfo = {
  readonly upArrow: boolean;
  readonly downArrow: boolean;
  readonly pageUp: boolean;
  readonly pageDown: boolean;
  readonly return: boolean;
  readonly escape: boolean;
  readonly tab: boolean;
  readonly backspace: boolean;
  readonly delete: boolean;
  readonly ctrl: boolean;
  readonly shift: boolean;
};

const ask = (kind: PromptKind, label: string, required: boolean, context?: string): Intent => ({
  ui: { type: 'prompt', prompt: { kind, label, value: '', required, context } },
});

const say = (text: string, tone: Tone = 'error'): Intent => ({ ui: { type: 'message', text, tone } });

/** Keys while a prompt is open: a minimal line editor. */
const promptKey = (p: Prompt, input: string, key: KeyInfo): Intent | undefined => {
  if (key.escape) return { ui: { type: 'prompt', prompt: undefined } };
  if (key.return) {
    if (p.required && !p.value.trim()) return say(`${p.label.replace(/:$/, '')} is required (Esc to cancel)`);
    return { command: { type: 'submit', prompt: p } };
  }
  if (key.backspace || key.delete) return { ui: { type: 'input', value: p.value.slice(0, -1) } };
  if (key.ctrl && input === 'u') return { ui: { type: 'input', value: '' } };
  if (key.ctrl || key.tab || key.upArrow || key.downArrow) return undefined;
  return input ? { ui: { type: 'input', value: p.value + input } } : undefined;
};

const toggleView = (current: View, view: View): Intent => ({
  ui: { type: 'view', view: current.kind === view.kind ? undefined : view },
});

export const keyToIntent = (s: UiState, input: string, key: KeyInfo, viewerPage: number): Intent | undefined => {
  if (s.prompt) return promptKey(s.prompt, input, key);

  const e = selectedEpic(s);
  const change = selectedChange(s);
  const view = currentView(s);

  if (key.upArrow || input === 'k') return { ui: { type: 'move', delta: -1 } };
  if (key.downArrow || input === 'j') return { ui: { type: 'move', delta: 1 } };
  if (key.pageDown || input === ' ') return { ui: { type: 'scroll', delta: viewerPage } };
  if (key.pageUp) return { ui: { type: 'scroll', delta: -viewerPage } };
  if (key.tab) return { ui: { type: 'focus' } };
  if (key.escape) return { ui: { type: 'view', view: undefined } };

  const doc = ['1', '2', '3'].indexOf(input);
  if (doc >= 0) return { ui: { type: 'view', view: { kind: 'doc', name: DOCS[doc]! } } };

  switch (input) {
    case 'q':
      return s.busy.length ? ask('quit', 'Agents are running and will be stopped. Quit? (y/N):', false) : { command: { type: 'quit' } };
    case '?':
      return toggleView(view, { kind: 'help' });
    case 'n':
      return ask('new-title', 'New epic title:', true);
    case 'm':
      return { ui: { type: 'toggle-mine' } };
    case 'l':
      return toggleView(view, { kind: 'log' });
    case '4':
      return change ? { ui: { type: 'view', view: { kind: 'change-spec' } } } : say('No change selected.');
    case 't':
      return change ? { ui: { type: 'view', view: { kind: 'change' } } } : say('No change selected.');
    case 'd':
      return change?.branch ? toggleView(view, { kind: 'diff' }) : say('The selected change has no code yet.');
  }

  if (!e) return undefined;
  if (isBusy(s, e.slug) && 'rRaAvbxXso'.includes(input)) return say(`"${e.slug}" is running. Wait for it to finish.`);

  switch (input) {
    case 'r':
      return { command: { type: 'run', force: false } };
    case 'R':
      return { command: { type: 'run', force: true } };
    case 'a': {
      const target = approvalTarget(s);
      if (!target) return say('Select a draft change spec or a change awaiting review (Tab, then ↑/↓), or A to approve all drafts.');
      if (target.kind === 'stage') return ask('approve', 'Approve (optional note for later stages):', false);
      const what = target.change.status === 'draft' ? 'change spec' : 'code (opens the MR)';
      return ask('approve', `Approve ${target.change.id} ${what} (optional note):`, false, target.change.id);
    }
    case 'A':
      return e.stage === 'changes' && e.changes.some((c) => c.status === 'draft')
        ? ask('approve-all', 'Approve every draft change spec that passes its checks? Optional note:', false)
        : say('No draft change specs to approve.');
    case 'v': {
      const target = revisionTarget(s);
      if (target.kind === 'change') {
        const what = target.change.status === 'draft' || target.change.status === 'revising' ? 'its spec' : 'its code';
        return ask('revise', `Feedback on ${target.change.id} (${what}):`, true, target.change.id);
      }
      return ask('revise', e.stage === 'changes' ? 'Feedback on the whole change set:' : 'What should change:', true);
    }
    case 'b':
      return ask('back-stage', 'Send back to (explore/spec):', true);
    case 'x':
      return change ? ask('drop', `Drop ${change.id}? Reason:`, true, change.id) : say('No change selected.');
    case 'X':
      return ask('abandon', `Abandon "${e.slug}"? Reason:`, true);
    case 'o':
      return ask('assign', `New owner for "${e.slug}" (email):`, true);
    case 's':
      return { command: { type: 'sync' } };
    case 'e':
      return view.kind === 'doc' || (view.kind === 'change-spec' && change && (change.status === 'draft' || change.status === 'revising'))
        ? { command: { type: 'edit' } }
        : say('Open a document (1-3) or a draft change spec (4) to edit it.');
  }
  return undefined;
};
