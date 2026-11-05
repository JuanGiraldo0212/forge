import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { applyLocal, parseConfig } from '../src/application/config.ts';
import { parseChangeSpec, readyChanges, renderChangeSpec, selectBatch, transitiveDependencies, validateChange, validateDraftSet } from '../src/domain/changes.ts';
import { needsHuman, replay, type ApprovedChange, type ChangeState, type EpicEvent } from '../src/domain/epic.ts';
import { approvalTarget, canDropChange, canSendBack, openGate, revisionTarget, runnableStage } from '../src/domain/lifecycle.ts';
import { escalationReason, failureSignature, reviewGateRequired, runCost } from '../src/domain/policy.ts';
import { lintRequirements, lintSpec } from '../src/domain/spec.ts';

let n = 0;
const ev = (e: Record<string, unknown>): EpicEvent => ({ at: `2026-11-04T00:00:00.${String(n++).padStart(3, '0')}Z`, by: 'me', ...e }) as EpicEvent;
const created = () => ev({ type: 'EpicCreated', slug: 'x', title: 'X', owner: 'ana@example.com' });

const spec = (id: string, repo = 'api', files = [`${id}.ts`], dependsOn: string[] = []): ApprovedChange => ({
  id,
  title: id,
  repo,
  kind: 'feature',
  risk: 'low',
  files,
  dependsOn,
  verification: ['v'],
  markdown: '',
});

const toChanges = (events: EpicEvent[]) => replay([created(), ...events])!;

const drafted = (...ids: string[]) => ev({ type: 'ChangesDrafted', drafts: ids.map((id) => ({ id, title: id })), removed: [], full: true, costUsd: 0 });
const approvedSpec = (s: ApprovedChange) => ev({ type: 'ChangeSpecApproved', changeId: s.id, spec: s });
const throughSpec = () => [ev({ type: 'ArtifactProduced', stage: 'requirements', costUsd: 0 }), ev({ type: 'GateApproved', stage: 'requirements' }), ev({ type: 'ArtifactProduced', stage: 'spec', costUsd: 0 }), ev({ type: 'GateApproved', stage: 'spec' })];

describe('epic lifecycle', () => {
  it('rejects a log that does not start with EpicCreated', () => {
    assert.equal(replay([ev({ type: 'StageStarted', stage: 'requirements' })]), undefined);
  });

  it('walks requirements -> spec -> changes through two gates', () => {
    const e = toChanges([ev({ type: 'ArtifactProduced', stage: 'requirements', costUsd: 0.5 })]);
    assert.equal(e.owner, 'ana@example.com');
    assert.equal(runnableStage(e).ok, false, 'cannot run while the gate is open');
    assert.deepEqual(openGate(e), { ok: true, value: 'requirements' });
    assert.equal(toChanges(throughSpec()).stage, 'changes');
    assert.equal(toChanges([ev({ type: 'OwnerChanged', owner: 'bo@example.com' })]).owner, 'bo@example.com');
  });

  it('approves change specs one at a time and redrafts only the one with feedback', () => {
    const e = toChanges([
      ...throughSpec(),
      drafted('C1', 'C2'),
      approvedSpec(spec('C1')),
      ev({ type: 'ChangeSpecRevisionRequested', changeId: 'C2', note: 'smaller' }),
    ]);
    assert.deepEqual(e.changes.map((c) => c.status), ['ready', 'revising']);
    assert.deepEqual(e.changes[1]!.specFeedback, ['smaller']);
    assert.ok(needsHuman(toChanges([...throughSpec(), drafted('C1')])), 'drafts need a human');

    const redrafted = toChanges([...throughSpec(), drafted('C1', 'C2'), approvedSpec(spec('C1')), ev({ type: 'ChangesDrafted', drafts: [{ id: 'C2', title: 'C2 v2' }], removed: [], full: false, costUsd: 0 })]);
    assert.equal(redrafted.changes[0]!.status, 'ready', 'an approved change is untouched by a redraft');
    assert.equal(redrafted.changes[1]!.title, 'C2 v2');
  });

  it('routes approve and revise to the spec or the code by change status', () => {
    const e = toChanges([...throughSpec(), drafted('C1', 'C2'), approvedSpec(spec('C1')), ev({ type: 'ChangeStarted', changeId: 'C1', branch: 'b' }), ev({ type: 'ChangeReviewed', changeId: 'C1', findings: [], gateRequired: true, costUsd: 0 })]);
    const kind = (r: ReturnType<typeof approvalTarget>) => (r.ok ? r.value.kind : r.error.message);
    assert.equal(kind(approvalTarget(e, 'C1')), 'code');
    assert.equal(kind(approvalTarget(e, 'C2')), 'spec');
    assert.equal(kind(revisionTarget(e, 'C1')), 'code');
    assert.equal(kind(revisionTarget(e, 'C2')), 'spec');
    assert.equal(canSendBack(e, 'spec').ok, false, 'code exists');
  });

  it('is done when every live change is merged; dropped ones do not count', () => {
    const base = [...throughSpec(), drafted('C1', 'C2'), approvedSpec(spec('C1'))];
    assert.equal(toChanges([...base, ev({ type: 'ChangeMerged', changeId: 'C1' })]).stage, 'changes');
    assert.equal(toChanges([...base, ev({ type: 'ChangeDropped', changeId: 'C2', note: 'n' }), ev({ type: 'ChangeMerged', changeId: 'C1' })]).stage, 'done');
  });

  it('cannot drop a change that live changes depend on', () => {
    const e = toChanges([...throughSpec(), drafted('C1', 'C2'), approvedSpec(spec('C1')), approvedSpec(spec('C2', 'web', ['x'], ['C1']))]);
    const drop = canDropChange(e, 'C1');
    assert.match(drop.ok ? '' : drop.error.message, /C2 depend on C1/);
    assert.equal(canDropChange(e, 'C2').ok, true);
  });
});

describe('change specs', () => {
  const draft = {
    id: 'C1',
    title: 'Add "due" field: dates',
    repo: 'api',
    kind: 'feature' as const,
    risk: 'low' as const,
    files: ['src/a.ts', 'src/a.test.ts'],
    dependsOn: [],
    goal: 'Goal.',
    behavior: 'Returns `Promise<void>` on success.',
    verification: ['a.test.ts passes'],
    mustNotBreak: ['the v1 API'],
  };

  it('round-trips render -> parse, including quotes and generics', () => {
    const parsed = parseChangeSpec(renderChangeSpec(draft), 'C1');
    assert.ok(parsed.ok, JSON.stringify(parsed));
    assert.equal(parsed.value.title, draft.title);
    assert.deepEqual(parsed.value.files, draft.files);
    assert.deepEqual(parsed.value.verification, ['a.test.ts passes']);
  });

  it('flags a bad header, a mismatched id and missing sections', () => {
    const md = renderChangeSpec(draft).replace('kind: feature', 'kind: epic').replace(/## Must not break[\s\S]*$/, '');
    const r = parseChangeSpec(md, 'C2');
    const text = r.ok ? '' : r.error.join('\n');
    assert.match(text, /frontmatter kind/);
    assert.match(text, /does not match the file name/);
    assert.match(text, /Must not break/);
    assert.equal(parseChangeSpec('## Goal\nx', 'C1').ok, false);
  });

  it('validates repo, file limit, dependencies and cycles against the live set', () => {
    const limits = { maxFilesPerChange: 2, repos: ['api', 'web'] };
    assert.equal(validateChange(spec('C2', 'web', ['x'], ['C1']), [{ id: 'C1', dependsOn: [] }], limits).ok, true);
    const bad = validateChange(spec('C2', 'mobile', ['a', 'b', 'c'], ['C9']), [], limits);
    assert.match(bad.ok ? '' : bad.error.join(), /mobile.*3 files.*C9/s);
    const cycle = validateChange(spec('C1', 'api', ['a'], ['C2']), [{ id: 'C2', dependsOn: ['C1'] }], limits);
    assert.match(cycle.ok ? '' : cycle.error.join(), /cycle/);
  });

  it('refuses draft sets with duplicate or reserved ids', () => {
    const r = validateDraftSet([draft, draft, { ...draft, id: 'C7' }], ['C7']);
    assert.match(r.ok ? '' : r.error.join(), /duplicate change id C1.*C7 is already approved/s);
  });

  it('builds a change once its dependencies merged; same-repo file overlaps never run together', () => {
    const state = (s: ApprovedChange, status: ChangeState['status']): ChangeState => ({ id: s.id, title: s.id, status, spec: s, specFeedback: [], failures: [], feedback: [], findings: [] });
    const a = state(spec('A', 'api', ['x']), 'mr_open');
    const b = state(spec('B', 'web', ['y'], ['A']), 'ready');
    assert.deepEqual(readyChanges([a, b]), []);
    assert.deepEqual(readyChanges([{ ...a, status: 'merged' }, b]).map((c) => c.id), ['B']);
    const ready = [state(spec('P', 'api', ['f']), 'ready'), state(spec('Q', 'api', ['f']), 'ready'), state(spec('R', 'web', ['f']), 'ready')];
    assert.deepEqual(selectBatch(ready, 3).map((c) => c.id), ['P', 'R'], 'same path in another repo is no conflict');
  });
});

describe('transitive dependencies', () => {
  const spec = (id: string, repo: string, dependsOn: string[] = []): ChangeState => ({
    id,
    title: id,
    status: 'ready',
    spec: { id, title: id, repo, kind: 'feature', risk: 'low', files: ['f'], dependsOn, verification: ['v'], markdown: '' },
    specFeedback: [],
    failures: [],
    feedback: [],
    findings: [],
  });

  it('follows dependencies of dependencies, once each, dependencies first', () => {
    const changes = [spec('C1', 'api'), spec('C2', 'web', ['C1']), spec('C3', 'web', ['C2', 'C1']), spec('C4', 'api')];
    assert.deepEqual(transitiveDependencies(changes, 'C3').map((c) => c.id), ['C1', 'C2']);
    assert.deepEqual(transitiveDependencies(changes, 'C1'), []);
  });
});

describe('requirements lint', () => {
  const good = `## Problem
Users miss deadlines.
## Functional requirements
- R1: A todo can have a due date.
  - Acceptance: a todo created with a due date shows it
- **R2** Overdue todos are listed.
## Non-functional requirements
- R3: No new dependencies.
## Out of scope
Reminders.
## Open questions
None
`;

  it('passes and collects functional and non-functional ids', () => {
    assert.deepEqual(lintRequirements(good), { ok: true, value: { ids: ['R1', 'R2', 'R3'] } });
  });

  it('needs numbered requirements, unique ids and no placeholders', () => {
    const r = lintRequirements(good.replace('- R1: A todo', '- A todo').replace('- **R2**', '- R3:').replace('Reminders.', 'TBD').replace(/## Problem\n.*\n/, ''));
    const text = r.ok ? '' : r.error.join('\n');
    assert.match(text, /missing or empty section "## Problem"/);
    assert.match(text, /R3 is listed twice/);
    assert.match(text, /TODO\/TBD/);
    const open = lintRequirements(good.replace('## Open questions\nNone', '## Open questions\n- Past dates allowed?\n  Answer:\n- Format?\n  Answer: ISO'));
    assert.deepEqual(open.ok ? [] : open.error, ['1 open question has no answer: fill in each "Answer:" line, or request a revision']);
    const none = lintRequirements(good.replace(/- \**R\d.*\n/g, '- something\n'));
    assert.match(none.ok ? '' : none.error.join('\n'), /needs numbered items/);
  });
});

describe('epic spec lint', () => {
  const good = `# Title
## Summary
Due dates across api and web.
## Approach
The api returns Promise<void> for writes; web reads the new field.
## Alternatives considered
Client-only dates: lost on reload.
## Changes
### C1: Store due dates
- Repo: api
- Depends on: none
- Requirements: R1, R3

Adds the field.

### C2 — Show overdue todos
- **Repo:** \`web\`
- Depends on: C1
- Requirements: R2

Lists them.
## Verification
- test "does the thing" passes
## Must not break
- existing API /v1/things
## Risk
medium — touches billing reads
`;
  const ctx = { requirementIds: ['R1', 'R2', 'R3'], repos: ['api', 'web'] };

  it('passes a complete spec and parses the planned changes, including code like Promise<void> and the word "todo"', () => {
    assert.ok(lintSpec(good.replace('Due dates', 'Each todo gets a due date'), ctx).ok);
    const r = lintSpec(good, ctx);
    assert.ok(r.ok, JSON.stringify(r));
    assert.equal(r.value.risk, 'medium');
    assert.deepEqual(r.value.changes, [
      { id: 'C1', title: 'Store due dates', repo: 'api', dependsOn: [], requirements: ['R1', 'R3'] },
      { id: 'C2', title: 'Show overdue todos', repo: 'web', dependsOn: ['C1'], requirements: ['R2'] },
    ]);
  });

  it('flags missing sections, empty lists, bad risk and placeholders', () => {
    const r = lintSpec(good.replace('- existing API /v1/things', 'nothing listed').replace('medium', 'spicy').replace('Lists them.', 'TODO').replace(/## Alternatives considered\n.*\n/, ''), ctx);
    const text = r.ok ? '' : r.error.join('\n');
    assert.match(text, /missing or empty section "## Alternatives considered"/);
    assert.match(text, /Must not break" needs at least one list item/);
    assert.match(text, /Risk" must start with/);
    assert.match(text, /TODO/);
  });

  it('checks the plan: coverage, known repos and requirements, dependencies', () => {
    const r = lintSpec(good.replace('- Requirements: R2', '- Requirements: R9').replace('- Repo: api', '- Repo: mobile').replace('Depends on: C1', 'Depends on: C7'), ctx);
    const text = r.ok ? '' : r.error.join('\n');
    assert.match(text, /C1: repo "mobile" is not configured/);
    assert.match(text, /C2 names R9, which is not in the requirements/);
    assert.match(text, /R2 is not covered by any change/);
    assert.match(text, /C2 depends on C7, which is not a planned change/);
    const cycle = lintSpec(good.replace('- Depends on: none', '- Depends on: C2'), ctx);
    assert.match(cycle.ok ? '' : cycle.error.join('\n'), /dependency cycle among: C1, C2/);
    const empty = lintSpec(good.replace(/### C1[\s\S]*Lists them\.\n/, 'Nothing yet.\n'), ctx);
    assert.match(empty.ok ? '' : empty.error.join('\n'), /needs at least one "### C1: Title"/);
  });
});

describe('config', () => {
  const shared = { repos: { api: { path: '../api', project: 'g/api', checks: [{ name: 'test', run: 'npm test' }] } } };

  it('lets a developer override repo paths only', () => {
    const merged = applyLocal(shared, { repos: { api: { path: '~/code/api' } } });
    assert.ok(merged.ok);
    const config = parseConfig(merged.value);
    assert.ok(config.ok);
    assert.equal(config.value.repos.api!.path, '~/code/api');
    assert.equal(config.value.repos.api!.project, 'g/api');
    assert.equal(applyLocal(shared, { repos: { web: { path: 'x' } } }).ok, false, 'unknown repo');
  });

  it('requires a revert-test check that exists in each repo', () => {
    const r = parseConfig({ repos: { api: { ...shared.repos.api, revertTest: { check: 'unit' } } } });
    assert.match(r.ok ? '' : r.error.join(), /revertTest/);
  });
});

describe('policy', () => {
  const policy = { maxRounds: 5, maxIdenticalFailures: 3 };

  it('escalates after identical failures and at the round limit', () => {
    assert.equal(escalationReason(policy, ['a', 'a']), undefined);
    assert.match(escalationReason(policy, ['b', 'a', 'a', 'a'])!, /same failure 3 times/);
    assert.match(escalationReason(policy, ['1', '2', '3', '4', '5'])!, /5 rounds/);
  });

  it('treats failures differing only in timings and hashes as identical', () => {
    assert.equal(failureSignature('test', 'FAIL add.test (12ms) at 3f2a9c1\n'), failureSignature('test', 'FAIL add.test (97ms) at 0b1c2d3\n'));
  });

  it('turns running session totals into per-run spend', () => {
    assert.equal(runCost(0.4, undefined), 0.4, 'fresh session: the total is the run');
    assert.equal(runCost(0.7, 0.4).toFixed(2), '0.30', 'resumed: only what this run added');
    assert.equal(runCost(0.1, 0.4), 0.1, 'total below baseline: SDK restarted counting');
    assert.equal(runCost(0, 0.4), 0, 'zeroed crash result');
  });

  it('gate policy', () => {
    assert.equal(reviewGateRequired('always', 'low', []), true);
    assert.equal(reviewGateRequired('risk-based', 'low', []), false);
    assert.equal(reviewGateRequired('risk-based', 'high', []), true);
    assert.equal(reviewGateRequired('risk-based', 'low', [{ severity: 'blocking', summary: 'bug' }]), true);
  });
});
