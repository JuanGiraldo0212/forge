/**
 * Chatting with an epic's agents: answers, change requests queued as feedback, and when chat can't change anything.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { chatThreadOf, feedbackTarget, sendChat } from '../src/application/chat.ts';
import { approveAllDrafts, approveChangeSet, runChanges, runDevelopment } from '../src/application/changes.ts';
import { loadEpic, type Deps } from '../src/application/deps.ts';
import { approveStage, createEpic, runGatedStage } from '../src/application/stages.ts';
import type { Epic } from '../src/domain/epic.ts';
import type { AgentRequest } from '../src/ports/index.ts';
import { epicSpec, makeDeps, makeRepo, REQUIREMENTS, scriptedAgent, stageOf, tempDir, type Script } from './helpers.ts';

const ADD_TEST = `import assert from 'node:assert/strict';\nimport { add } from '../src/add.mjs';\nassert.equal(add(2, 3), 5);\n`;

const draft = {
  id: 'C1',
  title: 'Add numbers',
  repo: 'app',
  kind: 'feature',
  risk: 'low',
  files: ['src/add.mjs', 'test/add.test.mjs'],
  dependsOn: [],
  goal: 'Add numbers.',
  behavior: 'add(a, b) returns a + b.',
  verification: ['add test passes'],
  mustNotBreak: ['existing tests'],
};

/** Chat replies come from `chat`; everything else follows the normal happy path. */
const setup = async (chat: (req: AgentRequest) => { reply: string; feedback?: string }) => {
  const dir = await tempDir();
  const app = await makeRepo(dir, 'app');
  const calls: AgentRequest[] = [];
  const script: Script = async (req) => {
    switch (stageOf(req)) {
      case 'chat':
        return { structured: chat(req) };
      case 'requirements':
        return { text: REQUIREMENTS };
      case 'epic spec':
        return { text: epicSpec([['C1', 'app']]) };
      case 'change specs':
        return { structured: { changes: [draft] } };
      case 'review':
        return { structured: { findings: [{ severity: 'advisory', summary: 'Name the parameters', file: 'src/add.mjs', line: 1 }] } };
    }
    await mkdir(join(req.cwd, 'src'), { recursive: true });
    await mkdir(join(req.cwd, 'test'), { recursive: true });
    await writeFile(join(req.cwd, 'src/add.mjs'), 'export const add = (a, b) => a + b;\n');
    await writeFile(join(req.cwd, 'test/add.test.mjs'), ADD_TEST);
    return { text: 'done' };
  };
  const { deps } = await makeDeps({
    workspace: app.repo,
    worktrees: join(dir, 'worktrees'),
    agent: scriptedAgent(calls, script),
    repos: [{ name: 'app', dir: app.repo, checks: [{ name: 'test', run: 'node test/add.test.mjs' }] }],
  });
  return { deps, calls, chats: () => calls.filter((c) => stageOf(c) === 'chat') };
};

const epicOf = async (deps: Deps, slug: string): Promise<Epic> => {
  const e = await loadEpic(deps, slug);
  assert.ok(e.ok);
  return e.value;
};

/** An epic whose requirements document waits for approval. */
const atRequirementsGate = async (deps: Deps): Promise<string> => {
  const created = await createEpic(deps, 'Adder', 'Add two numbers.');
  assert.ok(created.ok);
  const run = await runGatedStage(deps, await epicOf(deps, created.value), 'requirements');
  assert.ok(run.ok && run.value.kind === 'artifact', JSON.stringify(run));
  return created.value;
};

/** An epic whose C1 was built and reviewed, waiting for code review. */
const atCodeReview = async (deps: Deps): Promise<string> => {
  const slug = await atRequirementsGate(deps);
  assert.ok((await approveStage(deps, slug, undefined)).ok);
  assert.ok((await runGatedStage(deps, await epicOf(deps, slug), 'spec')).ok);
  assert.ok((await approveStage(deps, slug, undefined)).ok);
  assert.ok((await runChanges(deps, await epicOf(deps, slug))).ok);
  assert.ok((await approveAllDrafts(deps, slug, undefined)).ok);
  assert.ok((await approveChangeSet(deps, slug, undefined)).ok);
  const built = await runDevelopment(deps, await epicOf(deps, slug), false);
  assert.ok(built.ok && built.value.outcomes[0]?.result === 'awaiting_review', JSON.stringify(built));
  return slug;
};

describe('chat', () => {
  it('answers questions about a document without changing anything', async () => {
    const { deps, chats } = await setup(() => ({ reply: 'R1 covers it.' }));
    const slug = await atRequirementsGate(deps);
    const r = await sendChat(deps, slug, 'requirements', 'Does this cover negative numbers?');
    assert.deepEqual(r, { ok: true, value: { reply: 'R1 covers it.' } });

    const e = await epicOf(deps, slug);
    assert.equal(e.status, 'awaiting_approval', 'still at the gate');
    assert.deepEqual(e.pendingFeedback, []);
    assert.deepEqual(
      e.chats.requirements!.map((m) => [m.role, m.by, m.text]),
      [
        ['human', 'owner@example.com', 'Does this cover negative numbers?'],
        ['agent', 'forge', 'R1 covers it.'],
      ],
    );
    const req = chats()[0]!;
    assert.equal(req.mode, 'read', 'the chat agent only reads');
    assert.equal(req.cwd, deps.workspaceRoot);
    assert.match(req.prompt, /## Requirements document \(current version\)\n\n# Requirements/);
    assert.match(req.prompt, /Forge then regenerates the requirements document/);
    assert.equal(e.costUsd > 0, true, 'chat spend counts toward the epic');
  });

  it('queues a change request as feedback, and carries the conversation into the next message', async () => {
    let n = 0;
    const { deps, chats } = await setup(() =>
      ++n === 1 ? { reply: 'Will do: adding R2 for negatives.', feedback: 'Add a requirement R2: negative numbers are supported.' } : { reply: 'Yes, queued.' },
    );
    const slug = await atRequirementsGate(deps);
    const r = await sendChat(deps, slug, 'requirements', 'Add negative numbers as a requirement');
    assert.ok(r.ok && r.value.queued, JSON.stringify(r));
    assert.match(r.value.queued, /regenerates the requirements document/);

    const e = await epicOf(deps, slug);
    assert.equal(e.status, 'ready', 'the stage reruns with the feedback');
    assert.deepEqual(e.pendingFeedback, ['Add a requirement R2: negative numbers are supported.']);
    assert.equal(e.chats.requirements![1]!.feedback, 'Add a requirement R2: negative numbers are supported.');
    const revision = (await deps.epics.load(slug)).find((ev) => ev.type === 'RevisionRequested');
    assert.equal(revision?.by, 'owner@example.com', 'the revision is the human\'s request');

    // The stage now waits for its rerun: the next message can still be answered, and sees the history.
    assert.ok((await sendChat(deps, slug, 'requirements', 'Did you get that?')).ok);
    assert.match(chats()[1]!.prompt, /## Conversation so far[\s\S]*Add negative numbers as a requirement[\s\S]*queued as feedback/);
  });

  it('reworks a change\'s code from its thread, with the diff and findings in view', async () => {
    const { deps, chats } = await setup(() => ({ reply: 'Renaming them.', feedback: 'Rename the parameters of add to x and y.' }));
    const slug = await atCodeReview(deps);
    const r = await sendChat(deps, slug, 'C1', 'Please name the parameters x and y');
    assert.ok(r.ok && r.value.queued?.includes('rework the code'), JSON.stringify(r));

    const c1 = (await epicOf(deps, slug)).changes[0]!;
    assert.equal(c1.status, 'ready', 'back to build');
    assert.deepEqual(c1.feedback, ['Rename the parameters of add to x and y.']);
    const req = chats()[0]!;
    assert.match(req.cwd, /worktrees[\\/]app[\\/]/, 'the agent reads the change worktree');
    assert.match(req.prompt, /## Diff against the base branch[\s\S]*\+export const add/);
    assert.match(req.prompt, /\[advisory\] src\/add\.mjs:1: Name the parameters/);
  });

  it('only answers when nothing can change, and says so if the agent tried', async () => {
    const { deps, chats } = await setup(() => ({ reply: 'Sure.', feedback: 'Do it differently.' }));
    const slug = await atRequirementsGate(deps);
    const r = await sendChat(deps, slug, 'requirements', 'Change it', { blocked: 'agents are working on this epic' });
    assert.deepEqual(r, { ok: true, value: { reply: 'Sure.' } });
    const e = await epicOf(deps, slug);
    assert.deepEqual(e.pendingFeedback, []);
    assert.equal(e.chats.requirements!.at(-1)!.role, 'forge');
    assert.match(e.chats.requirements!.at(-1)!.text, /Not queued: agents are working/);
    assert.match(chats()[0]!.prompt, /Nothing can be changed right now: agents are working on this epic/);
  });

  it('knows which threads exist and when they take feedback', async () => {
    const { deps } = await setup(() => ({ reply: '' }));
    const slug = await atRequirementsGate(deps);
    const e = await epicOf(deps, slug);
    assert.ok(chatThreadOf(e, 'requirements').ok);
    assert.ok(!chatThreadOf(e, 'spec').ok, 'the epic spec is not reached yet');
    assert.ok(!chatThreadOf(e, 'C9').ok);
    assert.ok(!(await sendChat(deps, slug, 'spec', 'hi')).ok);
    assert.ok(!(await sendChat(deps, slug, 'requirements', '   ')).ok, 'empty messages are refused');

    assert.ok(!feedbackTarget({ ...e, status: 'awaiting_answers' }, 'requirements').ok, 'questions come first');
    assert.ok(!feedbackTarget({ ...e, status: 'running' }, 'requirements').ok);
    const approved = { ...e, stage: 'spec' as const };
    const t = feedbackTarget(approved, 'requirements');
    assert.ok(!t.ok && /already approved/.test(t.error.message));
    assert.ok(!feedbackTarget({ ...e, stage: 'done' }, 'requirements').ok);
  });
});
