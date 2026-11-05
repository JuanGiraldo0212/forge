/**
 * End-to-end through every gate with real git (bare repos as remotes), real checks,
 * a scripted agent and fake GitLab projects.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { syncMergeRequests } from '../src/application/build.ts';
import {
  approveAllDrafts,
  approveChange,
  changeIssues,
  dropChange,
  reviseChange,
  revisePlan,
  runChanges,
} from '../src/application/changes.ts';
import { loadEpic, type Deps } from '../src/application/deps.ts';
import { approveStage, createEpic, runGatedStage, runnable, sendBack } from '../src/application/stages.ts';
import { changeFile } from '../src/domain/epic.ts';
import type { AgentRequest } from '../src/ports/index.ts';
import { CALL_COST, epicSpec, makeDeps, makeRepo, REQUIREMENTS, scriptedAgent, sh, stageOf, tempDir, type Script } from './helpers.ts';

const draft = (id: string, repo: string, files: string[], dependsOn: string[] = [], title = `Change ${id}`) => ({
  id,
  title,
  repo,
  kind: 'feature',
  risk: 'low',
  files,
  dependsOn,
  goal: `Do ${id}.`,
  behavior: `${id} behaves.`,
  verification: [`${id} test passes`],
  mustNotBreak: ['existing tests'],
});

const epicOf = async (deps: Deps, slug: string) => {
  const e = await loadEpic(deps, slug);
  assert.ok(e.ok);
  return e.value;
};

const run = async (deps: Deps, slug: string) => {
  const r = await runnable(deps, slug, false);
  assert.ok(r.ok, JSON.stringify(r));
  if (r.value.stage === 'changes') {
    const c = await runChanges(deps, r.value.epic, false);
    assert.ok(c.ok, JSON.stringify(c));
    return c.value;
  }
  const g = await runGatedStage(deps, r.value.epic, r.value.stage);
  assert.ok(g.ok, JSON.stringify(g));
  return undefined;
};

/** Creates an epic and approves the requirements and the epic spec. */
const throughEpicSpec = async (deps: Deps): Promise<string> => {
  const created = await createEpic(deps, 'Due dates', 'Todos get due dates, shown in the web app.');
  assert.ok(created.ok);
  for (const _ of ['requirements', 'spec']) {
    await run(deps, created.value);
    assert.ok((await approveStage(deps, created.value, undefined)).ok);
  }
  return created.value;
};

const API_TEST = `import assert from 'node:assert/strict';\nimport { due } from '../src/due.mjs';\nassert.equal(due(1), 'D1');\n`;
const WEB_TEST = `import assert from 'node:assert/strict';\nimport { label } from '../src/label.mjs';\nassert.equal(label('x'), '[x]');\n`;

describe('multi-repo epic', () => {
  it('drafts change specs across repos, approves them one by one, and opens an MR per repo', async () => {
    const dir = await tempDir();
    const planning = await makeRepo(dir, 'planning');
    const api = await makeRepo(dir, 'api');
    const web = await makeRepo(dir, 'web');
    // Committed and pushed: planning must see it. Then local, unpushed edits: planning must not.
    await writeFile(join(api.repo, 'AGENTS.md'), 'API repo: ESM, node:test.\n');
    sh(api.repo, 'add', '.');
    sh(api.repo, 'commit', '-q', '-m', 'agents');
    sh(api.repo, 'push', '-q', 'origin', 'main');
    await writeFile(join(api.repo, 'AGENTS.md'), 'LOCAL ONLY: half-finished notes\n');
    await writeFile(join(api.repo, 'scratch.js'), 'uncommitted\n');

    const calls: AgentRequest[] = [];
    let redrafts = 0;
    const script: Script = async (req) => {
      switch (stageOf(req)) {
        case 'requirements':
          return { text: REQUIREMENTS };
        case 'epic spec':
          return { text: epicSpec([['C1', 'api'], ['C2', 'web', 'C1']]) };
        case 'change specs':
          return {
            structured: {
              changes: [
                draft('C1', 'api', ['src/due.mjs', 'test/due.test.mjs']),
                draft('C2', 'web', ['src/label.mjs', 'test/label.test.mjs'], ['C1']),
                draft('C3', 'web', ['src/extra.mjs'], [], 'Optional extra'),
              ],
            },
          };
        case 'change spec revision':
          redrafts++;
          return { structured: { changes: [draft('C2', 'web', ['src/label.mjs', 'test/label.test.mjs'], ['C1'], 'Show due label')] } };
        case 'review':
          return { structured: { findings: [] } };
      }
      // Build: write the change into whichever repo's worktree the agent was started in.
      const inApi = req.prompt.includes('repository "api"');
      await mkdir(join(req.cwd, 'src'), { recursive: true });
      await mkdir(join(req.cwd, 'test'), { recursive: true });
      if (inApi) {
        await writeFile(join(req.cwd, 'src/due.mjs'), `export const due = (n) => 'D' + n;\n`);
        await writeFile(join(req.cwd, 'test/due.test.mjs'), API_TEST);
      } else {
        await writeFile(join(req.cwd, 'src/label.mjs'), `export const label = (s) => '[' + s + ']';\n`);
        await writeFile(join(req.cwd, 'test/label.test.mjs'), WEB_TEST);
      }
      return { text: 'done' };
    };
    const { deps, hosts } = await makeDeps({
      workspace: planning.repo,
      worktrees: join(dir, 'worktrees'),
      agent: scriptedAgent(calls, script),
      repos: [
        { name: 'api', dir: api.repo, checks: [{ name: 'test', run: 'node test/due.test.mjs' }] },
        { name: 'web', dir: web.repo, checks: [{ name: 'test', run: 'node test/label.test.mjs' }] },
      ],
    });

    const slug = await throughEpicSpec(deps);
    const planningCall = calls.find((c) => stageOf(c) === 'requirements')!;
    const apiSnap = join(dir, 'worktrees', 'api', '_planning');
    assert.equal(planningCall.cwd, planning.repo, 'planning agents run from the workspace');
    assert.deepEqual(planningCall.additionalDirectories, [apiSnap, join(dir, 'worktrees', 'web', '_planning')], 'and read snapshots of every repo');
    assert.match(planningCall.systemPrompt, /API repo: ESM/, 'pushed AGENTS.md reaches planning agents');
    assert.doesNotMatch(planningCall.systemPrompt, /LOCAL ONLY/, 'the working copy does not');
    assert.ok(!existsSync(join(apiSnap, 'scratch.js')), 'uncommitted files are not in the snapshot');
    assert.match(planningCall.prompt, /snapshot of origin\/main at [0-9a-f]{8}/);
    assert.match(planningCall.denyRead!.join(), /events\.jsonl/, 'forge event logs are off limits');
    const started = (await deps.epics.load(slug)).find((e) => e.type === 'StageStarted');
    assert.ok(started?.type === 'StageStarted' && started.snapshots?.every((s) => s.source === 'snapshot' && s.commit), 'the log records which commits were read');

    // Draft the set: one file per change, nothing builds yet.
    const first = await run(deps, slug);
    assert.deepEqual(first?.drafted, ['C1', 'C2', 'C3']);
    assert.equal(first?.build.outcomes.length, 0);
    let e = await epicOf(deps, slug);
    assert.equal(e.owner, 'owner@example.com');
    assert.deepEqual(e.changes.map((c) => c.status), ['draft', 'draft', 'draft']);
    assert.match((await deps.artifacts.read(slug, changeFile('C1')))!, /^---\nid: C1\ntitle: "Change C1"\nrepo: api/);

    // A human edit that breaks a change spec blocks its approval, and only its approval.
    const c3 = (await deps.artifacts.read(slug, changeFile('C3')))!;
    await deps.artifacts.write(slug, changeFile('C3'), c3.replace('repo: web', 'repo: mobile'));
    assert.match((await changeIssues(deps, e, 'C3')).join(), /repo "mobile" is not configured/);
    assert.ok((await dropChange(deps, slug, 'C3', 'not needed now')).ok);

    // Approve C1 alone; ask for a redraft of C2.
    assert.ok((await approveChange(deps, slug, 'C1', undefined)).ok);
    assert.ok((await reviseChange(deps, slug, 'C2', 'call it a due label')).ok);

    // One run: C2 is redrafted, C1 (approved) builds in the api repo. C2 is not built: still a draft.
    const second = await run(deps, slug);
    assert.deepEqual(second?.revised, ['C2']);
    assert.equal(redrafts, 1);
    assert.deepEqual(second?.build.outcomes.map((o) => [o.changeId, o.result]), [['C1', 'awaiting_review']]);
    assert.match(calls.find((c) => stageOf(c) === 'change spec revision')!.prompt, /call it a due label/);
    const buildC1 = calls.find((c) => c.mode === 'build')!;
    assert.match(buildC1.cwd, /worktrees\/api\//, 'C1 builds in an api worktree');
    assert.match(buildC1.systemPrompt, /API repo: ESM/, 'and sees the api AGENTS.md');
    e = await epicOf(deps, slug);
    assert.equal(e.changes.find((c) => c.id === 'C2')!.title, 'Show due label');

    // C2 depends on C1, so once approved it waits for C1 to merge.
    assert.ok((await approveChange(deps, slug, 'C2', undefined)).ok);
    const waiting = await run(deps, slug);
    assert.equal(waiting?.build.outcomes.length, 0);
    assert.match(waiting!.build.idle!, /code to review: C1.*waiting on unmerged dependencies: C2/);

    // Approve C1's code: pushed to the api remote, MR opened in the api project only.
    const c1 = await approveChange(deps, slug, 'C1', 'lgtm');
    assert.ok(c1.ok && c1.value.kind === 'code' && c1.value.outcome.result === 'mr_open', JSON.stringify(c1));
    assert.ok(sh(api.remote, 'rev-parse', `forge/${slug}/C1`));
    assert.equal(hosts.api!.opened.length, 1);
    assert.equal(hosts.web!.opened.length, 0);
    assert.match(hosts.api!.opened[0]!.description, /## Goal\n\nDo C1\./, 'the MR carries the change spec');

    hosts.api!.merged.add(1);
    assert.ok((await syncMergeRequests(deps, slug)).ok);

    // Now C2 builds in the web repo.
    const third = await run(deps, slug);
    assert.deepEqual(third?.build.outcomes.map((o) => [o.changeId, o.result]), [['C2', 'awaiting_review']]);
    assert.match(calls.filter((c) => c.mode === 'build').at(-1)!.cwd, /worktrees\/web\//);
    assert.ok((await approveChange(deps, slug, 'C2', undefined)).ok);
    assert.ok(sh(web.remote, 'rev-parse', `forge/${slug}/C2`));
    assert.equal(hosts.web!.opened.length, 1);

    hosts.web!.merged.add(1);
    assert.ok((await syncMergeRequests(deps, slug)).ok);
    e = await epicOf(deps, slug);
    assert.equal(e.stage, 'done', 'done once every live change is merged (C3 was dropped)');
    assert.equal(e.costUsd.toFixed(4), (calls.length * CALL_COST).toFixed(4));
  });
});

describe('change specs stage', () => {
  const setup = async (script: Script) => {
    const dir = await tempDir();
    const app = await makeRepo(dir, 'app');
    const calls: AgentRequest[] = [];
    const wrapped: Script = async (req) => {
      const handled = await script(req);
      if (handled) return handled;
      if (stageOf(req) === 'requirements') return { text: REQUIREMENTS };
      if (stageOf(req) === 'epic spec') return { text: epicSpec([['C1', 'app']]) };
      if (stageOf(req) === 'review') return { structured: { findings: [] } };
      return undefined;
    };
    const { deps } = await makeDeps({
      workspace: app.repo,
      worktrees: join(dir, 'worktrees'),
      agent: scriptedAgent(calls, wrapped),
      repos: [{ name: 'app', dir: app.repo, checks: [{ name: 'test', run: 'node test/add.test.mjs' }] }],
    });
    return { deps, calls };
  };

  const ADD_TEST = `import assert from 'node:assert/strict';\nimport { add } from '../src/add.mjs';\nassert.equal(add(2, 3), 5);\n`;
  const oneChange = { structured: { changes: [draft('C1', 'app', ['src/add.mjs', 'test/add.test.mjs'])] } };

  const writeAdd = async (cwd: string, impl: string, test: string) => {
    await mkdir(join(cwd, 'src'), { recursive: true });
    await mkdir(join(cwd, 'test'), { recursive: true });
    await writeFile(join(cwd, 'src/add.mjs'), `export const add = (a, b) => ${impl};\n`);
    await writeFile(join(cwd, 'test/add.test.mjs'), test);
  };

  it('plan-level feedback redrafts the drafts but keeps approved changes fixed', async () => {
    let round = 0;
    const { deps, calls } = await setup(async (req) => {
      if (stageOf(req) !== 'change specs') return undefined;
      round++;
      return round === 1
        ? { structured: { changes: [draft('C1', 'app', ['a.mjs']), draft('C2', 'app', ['b.mjs'])] } }
        : { structured: { changes: [draft('C3', 'app', ['c.mjs']), draft('C4', 'app', ['d.mjs'])] } };
    });
    const slug = await throughEpicSpec(deps);
    await run(deps, slug);
    assert.ok((await approveChange(deps, slug, 'C1', undefined)).ok);
    assert.ok((await revisePlan(deps, slug, 'split C2 in two')).ok);

    const before = calls.length;
    const r = await run(deps, slug);
    const prompt = calls.slice(before).find((c) => stageOf(c) === 'change specs')!.prompt;
    assert.match(prompt, /Already approved change specs[\s\S]*id: C1/);
    assert.match(prompt, /never reuse: C1/);
    assert.match(prompt, /split C2 in two/);
    assert.deepEqual(r?.drafted, ['C3', 'C4']);
    const e = await epicOf(deps, slug);
    const status = Object.fromEntries(e.changes.map((c) => [c.id, c.status]));
    assert.equal(status.C2, undefined, 'the old draft is gone');
    assert.equal(status.C3, 'draft');
    assert.equal(status.C4, 'draft');
    assert.notEqual(status.C1, 'draft', 'the approved change was not redrafted');
    assert.equal(e.changes.find((c) => c.id === 'C1')!.spec?.files[0], 'a.mjs');
    assert.equal(await deps.artifacts.read(slug, changeFile('C2')), undefined, 'removed draft file is deleted');
    assert.equal(e.pendingFeedback.length, 0);
  });

  it('refuses a draft set that reuses an approved id', async () => {
    let round = 0;
    const { deps } = await setup(async (req) => {
      if (stageOf(req) !== 'change specs') return undefined;
      round++;
      return { structured: { changes: [draft('C1', 'app', ['a.mjs'])] } };
    });
    const slug = await throughEpicSpec(deps);
    await run(deps, slug);
    assert.ok((await approveAllDrafts(deps, slug, undefined)).ok);
    assert.ok((await revisePlan(deps, slug, 'more')).ok);
    const r = await run(deps, slug);
    assert.match(r!.errors.join(), /C1 is already approved/);
    assert.equal(round, 2);
  });

  it('cannot drop a change others depend on, or send back once code exists', async () => {
    const { deps } = await setup(async (req) => {
      if (stageOf(req) === 'change specs')
        return { structured: { changes: [draft('C1', 'app', ['src/add.mjs', 'test/add.test.mjs']), draft('C2', 'app', ['b.mjs'], ['C1'])] } };
      if (req.mode === 'build') {
        await writeAdd(req.cwd, 'a + b', ADD_TEST);
        return { text: 'ok' };
      }
      return undefined;
    });
    const slug = await throughEpicSpec(deps);
    await run(deps, slug);
    assert.ok((await approveAllDrafts(deps, slug, undefined)).ok);
    const drop = await dropChange(deps, slug, 'C1', 'no');
    assert.ok(!drop.ok && /C2 depend on C1/.test(drop.error.message));
    await run(deps, slug);
    const back = await sendBack(deps, slug, 'spec', 'rethink');
    assert.ok(!back.ok && /already have code: C1/.test(back.error.message));
  });

  it('escalates repeated identical failures, then reworks in the same session without double-counting cost', async () => {
    const { deps, calls } = await setup(async (req) => {
      if (stageOf(req) === 'change specs') return oneChange;
      if (req.mode === 'build') {
        await writeAdd(req.cwd, 'a - b', ADD_TEST);
        return { text: 'ok' };
      }
      return undefined;
    });
    const slug = await throughEpicSpec(deps);
    await run(deps, slug);
    assert.ok((await approveAllDrafts(deps, slug, undefined)).ok);
    await run(deps, slug);
    let c1 = (await epicOf(deps, slug)).changes[0]!;
    assert.equal(c1.status, 'escalated');
    assert.match(c1.escalation!, /same failure 3 times/);

    assert.ok((await reviseChange(deps, slug, 'C1', 'add, not subtract')).ok);
    c1 = (await epicOf(deps, slug)).changes[0]!;
    assert.equal(c1.status, 'ready', 'code feedback sends the change back to build, not to drafting');
    const before = calls.length;
    await run(deps, slug);
    assert.equal(calls.at(-1)!.resume, c1.sessionId, 'resumed the same agent session');
    assert.match(calls[before]!.prompt, /add, not subtract/);
    assert.equal((await epicOf(deps, slug)).costUsd.toFixed(4), (calls.length * CALL_COST).toFixed(4));
  });

  it('rejects tests that pass without the change (revert test)', async () => {
    const { deps, calls } = await setup(async (req) => {
      if (stageOf(req) === 'change specs') return oneChange;
      if (req.mode === 'build') {
        await writeAdd(req.cwd, 'a + b', `console.log('ok');\n`);
        return { text: 'ok' };
      }
      return undefined;
    });
    const slug = await throughEpicSpec(deps);
    await run(deps, slug);
    assert.ok((await approveAllDrafts(deps, slug, undefined)).ok);
    await run(deps, slug);
    const c1 = (await epicOf(deps, slug)).changes[0]!;
    assert.equal(c1.status, 'escalated');
    assert.match(c1.failures[0]!, /revert-test/);
    assert.equal(calls.filter((c) => stageOf(c) === 'review').length, 0, 'never reviewed');
  });

  it('records the cost of an agent run that crashed', async () => {
    const { deps, calls } = await setup(async (req) => {
      if (stageOf(req) === 'change specs') return oneChange;
      if (req.mode === 'build') return { error: 'boom' };
      return undefined;
    });
    const slug = await throughEpicSpec(deps);
    await run(deps, slug);
    assert.ok((await approveAllDrafts(deps, slug, undefined)).ok);
    await run(deps, slug);
    const e = await epicOf(deps, slug);
    assert.match(e.changes[0]!.escalation!, /agent error: boom/);
    assert.equal(e.costUsd.toFixed(4), (calls.length * CALL_COST).toFixed(4));
  });
});
