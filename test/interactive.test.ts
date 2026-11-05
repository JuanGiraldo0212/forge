/**
 * Interactive planning stages: the agent pauses with questions, the owner answers, the same session resumes.
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { Deps } from '../src/application/deps.ts';
import { loadEpic } from '../src/application/deps.ts';
import { answerQuestions, approveStage, createEpic, reviseStage, runGatedStage, runnable } from '../src/application/stages.ts';
import type { AgentRequest } from '../src/ports/index.ts';
import { answerAction } from '../src/ui/actions.ts';
import { CALL_COST, EPIC_SPEC, makeDeps, makeRepo, REQUIREMENTS, scriptedAgent, stageOf, tempDir, type Script } from './helpers.ts';

const DOC = REQUIREMENTS.replace('## Open questions', '## Decisions\n- Q1: Postgres\n## Open questions');

const setup = async (script: Script, questions: Record<string, unknown> = {}) => {
  const dir = await tempDir();
  const ws = await makeRepo(dir, 'planning');
  const api = await makeRepo(dir, 'api');
  const calls: AgentRequest[] = [];
  const made = await makeDeps({ workspace: ws.repo, worktrees: join(dir, 'wt'), agent: scriptedAgent(calls, script), repos: [{ name: 'api', dir: api.repo, checks: [{ name: 'test', run: 'true' }] }] });
  const deps: Deps = { ...made.deps, config: { ...made.deps.config, questions: { ...made.deps.config.questions, ...questions } } };
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
  assert.ok(r.value.stage === 'requirements' || r.value.stage === 'spec');
  const g = await runGatedStage(deps, r.value.epic, r.value.stage);
  assert.ok(g.ok, JSON.stringify(g));
  return g.value;
};

describe('interactive planning', () => {
  it('pauses with questions, resumes the same session with the answers, then writes the requirements', async () => {
    let turn = 0;
    const { deps, calls, slug } = await setup(async (req) => {
      if (stageOf(req) === 'epic spec') return { text: EPIC_SPEC };
      turn++;
      if (turn === 1) return { questions: [{ question: 'Which database?', why: 'Changes the index design', options: [{ label: 'Postgres', description: 'What prod runs', recommended: true }, { label: 'MySQL' }] }, { question: 'Who searches?', why: 'Scope', options: [] }] };
      return { text: DOC };
    });

    const first = await run(deps, slug);
    assert.equal(first.kind, 'questions');
    assert.ok(calls[0]!.ask, 'requirements agents may ask');
    assert.match(calls[0]!.prompt, /ask_human tool/);
    let e = await epicOf(deps, slug);
    assert.equal(e.status, 'awaiting_answers');
    assert.deepEqual(e.dialog?.questions.map((q) => q.id), ['Q1', 'Q2']);
    assert.equal((await runnable(deps, slug, false)).ok, false, 'no run until answered');
    assert.equal(await deps.artifacts.read(slug, 'requirements.md'), undefined, 'nothing written yet');

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
    assert.doesNotMatch(second.prompt, /# Stage: requirements/, 'a resume sends only what is new');

    e = await epicOf(deps, slug);
    assert.equal(e.status, 'awaiting_approval');
    assert.match((await deps.artifacts.read(slug, 'requirements.md'))!, /## Decisions/);
    assert.equal(e.costUsd.toFixed(4), (calls.length * CALL_COST).toFixed(4), 'resumed session is not double-counted');

    // A revision continues the same conversation, and already-delivered answers are not resent.
    assert.ok((await reviseStage(deps, slug, 'look at the admin panel too')).ok);
    await run(deps, slug);
    const third = calls.at(-1)!;
    assert.equal(third.resume, second.resume);
    assert.match(third.prompt, /look at the admin panel too/);
    assert.doesNotMatch(third.prompt, /Admins only/);

    // Approving moves on: the epic spec agent starts its own conversation, with technical questions.
    assert.ok((await approveStage(deps, slug, undefined)).ok);
    await run(deps, slug);
    const spec = calls.at(-1)!;
    assert.ok(spec.ask, 'epic spec agents may ask too');
    assert.equal(spec.resume, undefined, 'a fresh session');
    assert.match(spec.prompt, /## Approved requirements[\s\S]*R1: The thing works/);
    assert.match(spec.prompt, /Ask technical decisions/);
    assert.doesNotMatch(spec.prompt, /Admins only/, 'requirements answers reach it through the document');
    assert.equal((await epicOf(deps, slug)).dialog?.stage, 'spec');
  });

  it('stops offering the tool after the round limit', async () => {
    let turn = 0;
    const { deps, calls, slug } = await setup(
      async () => {
        turn++;
        return turn <= 2 ? { questions: [{ question: `Q round ${turn}?`, why: 'w', options: [] }] } : { text: DOC };
      },
      { maxRounds: 2 },
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
    const { deps, calls, slug } = await setup(async () => ({ text: DOC }), { requirements: false });
    await run(deps, slug);
    assert.equal(calls[0]!.ask, undefined);
  });

  it('asks technical questions in the epic spec stage and records them in Decisions', async () => {
    let specTurn = 0;
    const { deps, calls, slug } = await setup(async (req) => {
      // A resume has no stage header; the RFC format tells the epic spec stage apart.
      if (!/One subsection per change/.test(req.prompt)) return { text: DOC };
      specTurn++;
      return specTurn === 1
        ? { questions: [{ question: 'REST or events?', why: 'Shapes the contract', options: [{ label: 'REST' }, { label: 'Events' }] }] }
        : { text: EPIC_SPEC.replace('## Changes', '## Decisions\n- Q1: REST\n## Changes') };
    });
    await run(deps, slug);
    assert.ok((await approveStage(deps, slug, undefined)).ok);
    const asked = await run(deps, slug);
    assert.equal(asked.kind, 'questions');
    const paused = await epicOf(deps, slug);
    assert.equal(paused.dialog?.questions[0]?.id, 'Q1', 'ids restart per stage');
    const answered = await answerAction(deps, slug, [{ questionId: 'Q1', text: 'REST' }]);
    assert.ok(answered.ok, answered.text);
    assert.equal(calls.at(-1)!.resume, paused.dialog?.sessionId, 'same session');
    assert.match(calls.at(-1)!.prompt, /## Changes\nOne subsection per change/, 'the resume restates the RFC format');
    assert.ok((await approveStage(deps, slug, undefined)).ok);
  });

  it('can turn off questions for the epic spec alone', async () => {
    const { deps, calls, slug } = await setup(async (req) => ({ text: stageOf(req) === 'epic spec' ? EPIC_SPEC : DOC }), { spec: false });
    await run(deps, slug);
    assert.ok(calls[0]!.ask);
    assert.ok((await approveStage(deps, slug, undefined)).ok);
    await run(deps, slug);
    assert.equal(calls.at(-1)!.ask, undefined);
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
