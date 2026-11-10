import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { AGENT_DECIDES, answerText, choiceFromInput, replay, type EpicEvent, type Question } from '../src/domain/epic.ts';
import { ChatPanel } from '../src/desktop/renderer/components/ChatPanel.tsx';
import { QuestionsPanel } from '../src/desktop/renderer/components/QuestionsPanel.tsx';

const q: Question = {
  id: 'Q1',
  header: 'Ordering',
  text: 'Where should ordering happen?',
  why: 'Decides which repo owns it',
  options: [
    { label: 'In api', description: 'web renders what it gets', recommended: true },
    { label: 'In web' },
  ],
};

describe('answers', () => {
  it('turns choices into the text the agent receives', () => {
    assert.equal(answerText(q, { kind: 'options', labels: ['In api'] }), 'In api (web renders what it gets)');
    assert.equal(answerText(q, { kind: 'other', text: '  both ' }), 'both');
    assert.equal(answerText(q, { kind: 'agent' }), AGENT_DECIDES);
  });

  it('reads typed CLI/TUI input: numbers pick options, empty defers, text is the answer', () => {
    assert.deepEqual(choiceFromInput(q, '2'), { kind: 'options', labels: ['In web'] });
    assert.deepEqual(choiceFromInput(q, ''), { kind: 'agent' });
    assert.deepEqual(choiceFromInput(q, '1,2'), { kind: 'other', text: '1,2' }, 'single-choice: several numbers are just text');
    assert.deepEqual(choiceFromInput({ ...q, multiSelect: true }, '2, 1'), { kind: 'options', labels: ['In web', 'In api'] });
    assert.deepEqual(choiceFromInput(q, '7'), { kind: 'other', text: '7' });
    assert.deepEqual(choiceFromInput(q, 'Postgres 16'), { kind: 'other', text: 'Postgres 16' });
  });

  it('reads logs written before options had descriptions', () => {
    const at = '2026-11-05T00:00:00.000Z';
    const events = [
      { type: 'EpicCreated', slug: 'x', title: 'X', owner: 'me', at, by: 'me' },
      { type: 'QuestionsAsked', stage: 'requirements', questions: [{ id: 'Q1', text: 't', why: 'w', options: ['A', 'B'] }], sessionId: 's', sessionCostUsd: 0, costUsd: 0, at, by: 'forge' },
    ] as unknown as EpicEvent[];
    assert.deepEqual(replay(events)!.dialog!.questions[0]!.options, [{ label: 'A' }, { label: 'B' }]);
  });
});

describe('questions panel', () => {
  it('shows one question at a time with option cards, the recommendation, and the two escape hatches', () => {
    const at = '2026-11-05T00:00:00.000Z';
    const epic = replay([
      { type: 'EpicCreated', slug: 'x', title: 'X', owner: 'me', at, by: 'me' },
      { type: 'QuestionsAsked', stage: 'requirements', questions: [q, { ...q, id: 'Q2', header: 'Editing', text: 'Second?' }], sessionId: 's', sessionCostUsd: 0, costUsd: 0, at, by: 'forge' },
    ] as EpicEvent[])!;
    const html = renderToStaticMarkup(<QuestionsPanel epic={epic} dialog={epic.dialog} busy={false} onAnswered={() => {}} />);
    assert.match(html, /Where should ordering happen\?/);
    assert.doesNotMatch(html, /Second\?/, 'only the current question');
    assert.match(html, /1 of 2/);
    assert.match(html, /role="radio"[^>]*>.*In api.*Recommended.*web renders what it gets/s);
    assert.match(html, /Something else/);
    assert.match(html, /Let the agent decide/);
    assert.match(html, /Ordering.*Editing/s, 'step bar uses the headers');
  });
});

describe('chat panel', () => {
  const at = '2026-11-05T10:00:00.000Z';
  const events = [
    { type: 'EpicCreated', slug: 'x', title: 'X', owner: 'me@example.com', at, by: 'me@example.com' },
    { type: 'ChatMessage', thread: 'requirements', role: 'human', text: 'Add filters', at, by: 'me@example.com' },
    { type: 'ChatMessage', thread: 'requirements', role: 'forge', text: 'Not queued: the epic is done.', at, by: 'forge' },
  ] as unknown as EpicEvent[];
  const epic = replay(events)!;
  const render = (threads: readonly string[]) =>
    renderToStaticMarkup(
      <ChatPanel epic={epic} threads={threads} actor="me@example.com" busy={false} onSend={async () => ({ ok: true, text: '', tone: 'success' })} onOpenUrl={() => {}} onCollapse={() => {}} />,
    );

  // Agent replies are sanitized markdown, which needs a DOM; these render without one.
  it('shows the thread with who said what, and the notes from forge', () => {
    const html = render(['requirements']);
    assert.match(html, /Requirements agent/);
    assert.match(html, /You<\/span>[\s\S]*Add filters/);
    assert.match(html, /class="chat-note">Not queued: the epic is done\./);
    assert.equal(epic.chats.requirements!.length, 2);
  });

  it('offers a thread switcher when a change and the change set both have a chat', () => {
    const html = render(['C1', 'changes']);
    assert.match(html, /role="tab" aria-selected="true"[^>]*>C1</);
    assert.match(html, />Change set</);
    assert.match(html, /Ask the c1 agent anything/i, 'an empty thread explains what the chat does');
  });
});
