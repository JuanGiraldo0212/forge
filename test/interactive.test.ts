/**
 * Interactive exploration: the agent pauses with questions, the owner answers, the same session resumes.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Deps } from '../src/application/deps.ts';
import { loadEpic } from '../src/application/deps.ts';
import { answerQuestions, approveStage, createEpic, reviseStage, runGatedStage, runnable } from '../src/application/stages.ts';
import type { AgentRequest } from '../src/ports/index.ts';
import { answerAction } from '../src/ui/actions.ts';
import { CALL_COST, EPIC_SPEC, makeDeps, makeRepo, scriptedAgent, stageOf, tempDir, type Script } from './helpers.ts';

const DOC = '## Summary\nAll clear.\n## Decisions\n- Q1: Postgres\n## Open questions\nNone';

const setup = async (script: Script, explore: Record<string, unknown> = {}) => {
  const dir = await tempDir();
  const ws = await makeRepo(dir, 'planning');
  const api = await makeRepo(dir, 'api');
  const calls: AgentRequest[] = [];
  const made = await makeDeps({ workspace: ws.repo, worktrees: join(dir, 'wt'), agent: scriptedAgent(calls, script), repos: [{ name: 'api', dir: api.repo, checks: [{ name: 'test', run: 'true' }] }] });
  const deps: Deps = { ...made.deps, config: { ...made.deps.config, explore: { ...made.deps.config.explore, ...explore } } };
  const created = await createEpic(deps, 'Search', 'Users want search.');
  assert.ok(created.ok);
  return { deps, calls, slug: created.value };
};

const epicOf = async (deps: Deps, slug: string) => {
  const e = await loadEpic(deps, slug);
  assert.ok(e.ok);
  return e.value;
};

const run = async (deps: Deps, slug: string) => {
  const r = await runnable(deps, slug, false);
  assert.ok(r.ok, JSON.stringify(r));
  assert.ok(r.value.stage === 'explore' || r.value.stage === 'spec');
  const g = await runGatedStage(deps, r.value.epic, r.value.stage);
  assert.ok(g.ok, JSON.stringify(g));
  return g.value;
};

describe('interactive exploration', () => {
  it('pauses with questions, resumes the same session with the answers, then writes the exploration', async () => {
    let turn = 0;
    const { deps, calls, slug } = await setup(async (req) => {
      if (stageOf(req) === 'epic spec') return { text: EPIC_SPEC };
      turn++;
      if (turn === 1) return { questions: [{ question: 'Which database?', why: 'Changes the index design', options: [{ label: 'Postgres', description: 'What prod runs', recommended: true }, { label: 'MySQL' }] }, { question: 'Who searches?', why: 'Scope', options: [] }] };
      return { text: DOC };
    });

    const first = await run(deps, slug);
    assert.equal(first.kind, 'questions');
    assert.ok(calls[0]!.ask, 'explore agents may ask');
    assert.match(calls[0]!.prompt, /ask_human tool/);
    let e = await epicOf(deps, slug);
    assert.equal(e.status, 'awaiting_answers');
    assert.deepEqual(e.dialog?.questions.map((q) => q.id), ['Q1', 'Q2']);
    assert.equal((await runnable(deps, slug, false)).ok, false, 'no run until answered');
    assert.equal(await deps.artifacts.read(slug, 'exploration.md'), undefined, 'nothing written yet');

    const partial = await answerQuestions(deps, slug, [{ questionId: 'Q1', text: 'Postgres' }]);
    assert.ok(partial.ok && partial.value.remaining[0] === 'Q2');
    assert.equal((await epicOf(deps, slug)).status, 'awaiting_answers');

    // Answering the last one resumes the agent straight away.
    const resumed = await answerAction(deps, slug, [{ questionId: 'Q2', text: 'Admins only' }]);
    assert.ok(resumed.ok, resumed.text);
    const second = calls.at(-1)!;
    assert.equal(second.resume, calls[0] && e.dialog?.sessionId, 'same session');
    assert.match(second.prompt, /Q1: Which database\?\n  Answer \(owner@example\.com\): Postgres/);
    assert.match(second.prompt, /Q2: Who searches\?\n  Answer \(owner@example\.com\): Admins only/);
    assert.doesNotMatch(second.prompt, /# Stage: explore/, 'a resume sends only what is new');

    e = await epicOf(deps, slug);
    assert.equal(e.status, 'awaiting_approval');
    assert.match((await deps.artifacts.read(slug, 'exploration.md'))!, /## Decisions/);
    assert.equal(e.costUsd.toFixed(4), (calls.length * CALL_COST).toFixed(4), 'resumed session is not double-counted');

    // A revision continues the same conversation, and already-delivered answers are not resent.
    assert.ok((await reviseStage(deps, slug, 'look at the admin panel too')).ok);
    await run(deps, slug);
    const third = calls.at(-1)!;
    assert.equal(third.resume, second.resume);
    assert.match(third.prompt, /look at the admin panel too/);
    assert.doesNotMatch(third.prompt, /Admins only/);

    // Approving moves on; the epic spec agent never asks.
    assert.ok((await approveStage(deps, slug, undefined)).ok);
    await run(deps, slug);
    assert.equal(calls.at(-1)!.ask, undefined);
    assert.equal(calls.at(-1)!.resume, undefined);
    assert.equal((await epicOf(deps, slug)).dialog, undefined);
  });

  it('stops offering the tool after the round limit', async () => {
    let turn = 0;
    const { deps, calls, slug } = await setup(
      async () => {
        turn++;
        return turn <= 2 ? { questions: [{ question: `Q round ${turn}?`, why: 'w', options: [] }] } : { text: DOC };
      },
      { maxQuestionRounds: 2 },
    );
    await run(deps, slug);
    assert.ok((await answerAction(deps, slug, [{ questionId: 'Q1', text: 'a' }])).ok);
    assert.equal((await epicOf(deps, slug)).dialog?.rounds, 2);
    assert.ok(calls.at(-1)!.ask, 'second round could still ask');
    assert.ok((await answerAction(deps, slug, [{ questionId: 'Q2', text: 'b' }])).ok);
    assert.equal(calls.at(-1)!.ask, undefined, 'no third round');
    assert.match(calls.at(-1)!.prompt, /can't ask more questions/);
    assert.equal((await epicOf(deps, slug)).status, 'awaiting_approval');
  });

  it('can be turned off', async () => {
    const { deps, calls, slug } = await setup(async () => ({ text: DOC }), { interactive: false });
    await run(deps, slug);
    assert.equal(calls[0]!.ask, undefined);
  });

  it('rejects unknown, duplicate and empty answers', async () => {
    const { deps, slug } = await setup(async () => ({ questions: [{ question: 'x?', why: 'y', options: [] }] }));
    await run(deps, slug);
    assert.equal((await answerQuestions(deps, slug, [{ questionId: 'Q9', text: 'a' }])).ok, false);
    assert.equal((await answerQuestions(deps, slug, [{ questionId: 'Q1', text: '  ' }])).ok, false);
    assert.ok((await answerQuestions(deps, slug, [{ questionId: 'Q1', text: 'a' }])).ok);
    assert.equal((await answerQuestions(deps, slug, [{ questionId: 'Q1', text: 'again' }])).ok, false);
  });
});
