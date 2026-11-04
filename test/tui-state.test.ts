import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChangeState, Epic } from '../src/domain/epic.ts';
import { currentView, initialState, keyToIntent, reducer, selectedEpic, type KeyInfo, type UiState } from '../src/tui/state.ts';

const noKey: KeyInfo = {
  upArrow: false,
  downArrow: false,
  pageUp: false,
  pageDown: false,
  return: false,
  escape: false,
  tab: false,
  backspace: false,
  delete: false,
  ctrl: false,
  shift: false,
};

const ME = 'me@example.com';

const epic = (slug: string, patch: Partial<Epic> = {}): Epic => ({
  slug,
  title: slug,
  owner: ME,
  createdAt: '',
  updatedAt: '',
  stage: 'explore',
  status: 'ready',
  revision: 0,
  pendingFeedback: [],
  notes: [],
  changes: [],
  costUsd: 0,
  ...patch,
});

const change = (id: string, status: ChangeState['status']): ChangeState => ({
  id,
  title: id,
  status,
  specFeedback: [],
  failures: [],
  feedback: [],
  findings: [],
});

const loaded = (epics: Epic[]): UiState => reducer(initialState(ME), { type: 'loaded', epics });
const press = (s: UiState, input: string, key: Partial<KeyInfo> = {}) => keyToIntent(s, input, { ...noKey, ...key }, 10);
const promptLabel = (i: ReturnType<typeof press>) => (i && 'ui' in i && i.ui.type === 'prompt' ? (i.ui.prompt?.label ?? '') : '');

describe('tui reducer', () => {
  it('keeps the selection on the same epic when the list reorders', () => {
    let s = reducer(loaded([epic('a'), epic('b')]), { type: 'move', delta: 1 });
    s = reducer(s, { type: 'loaded', epics: [epic('b'), epic('a')] });
    assert.equal(selectedEpic(s)?.slug, 'b');
  });

  it('filters to my epics and keeps the selection when it can', () => {
    let s = loaded([epic('theirs', { owner: 'bo@example.com' }), epic('mine')]);
    s = reducer(s, { type: 'move', delta: 1 });
    s = reducer(s, { type: 'toggle-mine' });
    assert.equal(selectedEpic(s)?.slug, 'mine');
    s = reducer(s, { type: 'move', delta: -1 });
    assert.equal(selectedEpic(s)?.slug, 'mine', 'only one visible');
  });

  it('follows the next decision by default: a draft shows its spec, code under review shows the review', () => {
    const s = loaded([epic('a', { stage: 'changes', changes: [change('C1', 'draft'), change('C2', 'awaiting_review')] })]);
    assert.deepEqual(currentView(s), { kind: 'change-spec' });
    const next = reducer(reducer(s, { type: 'focus', focus: 'changes' }), { type: 'move', delta: 1 });
    assert.deepEqual(currentView(next), { kind: 'change' });
  });
});

describe('tui keys', () => {
  it('a targets the gate before the change specs stage, and the selected change after', () => {
    assert.match(promptLabel(press(loaded([epic('a', { status: 'awaiting_approval' })]), 'a')), /^Approve \(/);
    const changes = loaded([epic('a', { stage: 'changes', changes: [change('C1', 'draft'), change('C2', 'awaiting_review'), change('C3', 'ready')] })]);
    assert.match(promptLabel(press(changes, 'a')), /Approve C1 change spec/);
    const second = reducer(reducer(changes, { type: 'focus', focus: 'changes' }), { type: 'move', delta: 1 });
    assert.match(promptLabel(press(second, 'a')), /Approve C2 code \(opens the MR\)/);
    const third = reducer(second, { type: 'move', delta: 1 });
    const none = press(third, 'a');
    assert.ok(none && 'ui' in none && none.ui.type === 'message', 'a ready change has nothing to approve');
  });

  it('v revises the selected change, or the whole set when the change takes no feedback', () => {
    const s = loaded([epic('a', { stage: 'changes', changes: [change('C1', 'draft'), change('C2', 'ready')] })]);
    assert.match(promptLabel(press(s, 'v')), /Feedback on C1 \(its spec\)/);
    const onReady = reducer(reducer(s, { type: 'focus', focus: 'changes' }), { type: 'move', delta: 1 });
    assert.match(promptLabel(press(onReady, 'v')), /whole change set/);
  });

  it('A only offers to approve when there are drafts', () => {
    assert.match(promptLabel(press(loaded([epic('a', { stage: 'changes', changes: [change('C1', 'draft')] })]), 'A')), /Approve every draft/);
    const none = press(loaded([epic('a', { stage: 'changes', changes: [change('C1', 'ready')] })]), 'A');
    assert.ok(none && 'ui' in none && none.ui.type === 'message');
  });

  it('refuses actions on a running epic and asks before quitting', () => {
    const busy = reducer(loaded([epic('a')]), { type: 'busy', slug: 'a', on: true });
    const r = press(busy, 'r');
    assert.ok(r && 'ui' in r && r.ui.type === 'message' && r.ui.tone === 'error');
    const q = press(busy, 'q');
    assert.ok(q && 'ui' in q && q.ui.type === 'prompt' && q.ui.prompt?.kind === 'quit');
    assert.deepEqual(press(loaded([epic('a')]), 'q'), { command: { type: 'quit' } });
  });

  it('edits prompt text and blocks empty required input', () => {
    let s = reducer(loaded([epic('a')]), { type: 'prompt', prompt: { kind: 'revise', label: 'What should change:', value: '', required: true } });
    const empty = press(s, '', { return: true });
    assert.ok(empty && 'ui' in empty && empty.ui.type === 'message');
    for (const ch of 'more tests') {
      const i = press(s, ch);
      if (i && 'ui' in i) s = reducer(s, i.ui);
    }
    const back = press(s, '', { backspace: true });
    if (back && 'ui' in back) s = reducer(s, back.ui);
    assert.equal(s.prompt?.value, 'more test');
    assert.deepEqual(press(s, 'r'), { ui: { type: 'input', value: 'more testr' } }, 'letters type into the prompt, not commands');
    const submit = press(s, '', { return: true });
    assert.ok(submit && 'command' in submit && submit.command.type === 'submit');
  });
});
