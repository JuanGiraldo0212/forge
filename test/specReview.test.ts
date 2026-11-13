/**
 * Spec MRs on the workspace repo: the epic spec and each change spec are pushed to their own branches of the
 * planning repo (a real bare remote here) and opened as MRs on a fake GitLab project.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { gitVcs } from '../src/adapters/git.ts';
import { approveChange, dropChange, reviseChange, revisePlan, runChanges } from '../src/application/changes.ts';
import { loadEpic, type Deps } from '../src/application/deps.ts';
import { specBranch } from '../src/application/specReview.ts';
import { approveStage, createEpic, reviseStage, runGatedStage, runnable } from '../src/application/stages.ts';
import { err } from '../src/domain/result.ts';
import { epicSpec, fakeGitLab, makeDeps, makeRepo, REQUIREMENTS, scriptedAgent, sh, tempDir } from './helpers.ts';

const draft = (id: string, repo: string, files: string[], goal = `Do ${id}.`) => ({
  id,
  title: `Change ${id}`,
  repo,
  kind: 'feature',
  risk: 'low',
  files,
  dependsOn: [],
  goal,
  behavior: `${id} behaves.`,
  verification: [`${id} test passes`],
  mustNotBreak: ['existing tests'],
});

const setup = async (opts: { readonly failOpen?: boolean } = {}) => {
  const dir = await tempDir();
  const planning = await makeRepo(dir, 'planning');
  const api = await makeRepo(dir, 'api');
  const worktrees = join(dir, 'worktrees');
  let specVersion = 1;
  let changeSets = 0;
  const agent = scriptedAgent([], async (req) => {
    switch (req.label) {
      case 'requirements':
        return { text: REQUIREMENTS };
      case 'spec':
        return { text: epicSpec([['C1', 'api'], ['C2', 'api']]).replace('Ship the thing.', `Ship the thing, v${specVersion++}.`) };
      case 'changes':
        // The first plan has two changes; plan feedback then merges C2 into C1.
        return changeSets++ === 0
          ? { structured: { changes: [draft('C1', 'api', ['src/a.mjs']), draft('C2', 'api', ['src/b.mjs'])] } }
          : { structured: { changes: [draft('C1', 'api', ['src/a.mjs', 'src/b.mjs'], 'Do C1 and C2.')] } };
      case 'C1':
        return { structured: { changes: [draft('C1', 'api', ['src/a.mjs'], 'Do C1, in more detail.')] } };
    }
    return undefined;
  });
  const made = await makeDeps({
    workspace: planning.repo,
    worktrees,
    agent,
    repos: [{ name: 'api', dir: api.repo, checks: [{ name: 'test', run: 'node -e 0' }] }],
  });
  const gitlab = fakeGitLab('group/planning');
  const host = opts.failOpen ? { ...gitlab, openMergeRequest: async () => err({ port: 'gitlab', message: 'HTTP 403' }) } : gitlab;
  const warnings: string[] = [];
  const deps: Deps = {
    ...made.deps,
    log: { info: () => {}, warn: (m) => warnings.push(m) },
    workspaceRepo: {
      project: 'group/planning',
      remote: 'origin',
      baseBranch: 'main',
      epicsPath: 'epics',
      vcs: gitVcs({ repoRoot: planning.repo, worktreeRoot: join(worktrees, '_workspace'), remote: 'origin', baseBranch: 'main' }),
      host,
    },
  };
  return { deps, gitlab, remote: planning.remote, warnings };
};

const epicOf = async (deps: Deps, slug: string) => {
  const e = await loadEpic(deps, slug);
  assert.ok(e.ok);
  return e.value;
};

const run = async (deps: Deps, slug: string) => {
  const r = await runnable(deps, slug, false);
  assert.ok(r.ok, JSON.stringify(r));
  if (r.value.stage === 'changes') assert.ok((await runChanges(deps, r.value.epic)).ok);
  else if (r.value.stage !== 'development') assert.ok((await runGatedStage(deps, r.value.epic, r.value.stage)).ok);
};

/** Creates an epic and runs it through the requirements and the epic spec. */
const throughEpicSpec = async (deps: Deps) => {
  const created = await createEpic(deps, 'Due dates', 'Todos get due dates.');
  assert.ok(created.ok);
  for (const _ of ['requirements', 'spec']) {
    await run(deps, created.value);
    assert.ok((await approveStage(deps, created.value, undefined)).ok);
  }
  return created.value;
};

/** A file on a branch of the bare remote, or undefined if it isn't there. */
const onRemote = (remote: string, branch: string, path: string): string | undefined => {
  try {
    return sh(remote, 'show', `${branch}:${path}`);
  } catch {
    return undefined;
  }
};

const commitsAhead = (remote: string, branch: string): number => Number(sh(remote, 'rev-list', '--count', `main..${branch}`));

const EPIC = { kind: 'epic' } as const;
const change = (changeId: string) => ({ kind: 'change', changeId }) as const;
const mrUrl = (iid: number) => `https://gitlab.example/group/planning/-/merge_requests/${iid}`;

describe('spec MRs on the workspace repo', () => {
  it('opens an MR for the epic spec, and adds a commit per new version', async () => {
    const { deps, gitlab, remote, warnings } = await setup();
    const created = await createEpic(deps, 'Due dates', 'Todos get due dates.');
    assert.ok(created.ok);
    const slug = created.value;

    await run(deps, slug);
    assert.ok((await approveStage(deps, slug, undefined)).ok);
    assert.equal(gitlab.opened.length, 0, 'requirements are not published');

    // The epic spec: a branch with the spec and what it builds on, and an MR.
    await run(deps, slug);
    const specs = specBranch(deps, slug, EPIC);
    assert.equal(specs, `forge/${slug}/epic-spec`);
    assert.deepEqual(gitlab.opened.map((m) => m.sourceBranch), [specs]);
    assert.equal(gitlab.opened[0]!.title, 'Epic spec: Due dates');
    assert.match(onRemote(remote, specs, `epics/${slug}/epic-spec.md`) ?? '', /v1\./);
    assert.ok(onRemote(remote, specs, `epics/${slug}/requirements.md`));
    assert.ok(onRemote(remote, specs, `epics/${slug}/idea.md`));
    assert.equal(onRemote(remote, specs, `epics/${slug}/events.jsonl`), undefined, 'the event log stays out of the MR');
    assert.deepEqual((await epicOf(deps, slug)).specMergeRequest, { iid: 1, url: mrUrl(1) });

    // A revision is a new commit on the same MR.
    assert.ok((await reviseStage(deps, slug, 'tighten it')).ok);
    await run(deps, slug);
    assert.equal(gitlab.opened.length, 1);
    assert.match(onRemote(remote, specs, `epics/${slug}/epic-spec.md`) ?? '', /v2\./);
    assert.equal(commitsAhead(remote, specs), 2);

    // Approving publishes the owner's own edits.
    const specPath = deps.artifacts.pathOf(slug, 'epic-spec.md');
    await writeFile(specPath, (onRemote(remote, specs, `epics/${slug}/epic-spec.md`) ?? '').replace('v2.', 'v2, edited by the owner.') + '\n');
    assert.ok((await approveStage(deps, slug, undefined)).ok);
    assert.match(onRemote(remote, specs, `epics/${slug}/epic-spec.md`) ?? '', /edited by the owner/);
    assert.equal(commitsAhead(remote, specs), 3);
    assert.deepEqual(warnings, []);
  });

  it('opens one MR per change spec, updates it per version, and closes those that leave the plan', async () => {
    const { deps, gitlab, remote, warnings } = await setup();
    const slug = await throughEpicSpec(deps);
    const c1 = specBranch(deps, slug, change('C1'));
    const c2 = specBranch(deps, slug, change('C2'));
    assert.equal(c1, `forge/${slug}/C1-spec`);

    // Each change spec gets its own branch, holding only that spec, and its own MR.
    await run(deps, slug);
    assert.deepEqual(gitlab.opened.map((m) => m.sourceBranch).slice(1), [c1, c2]);
    const [mr1] = gitlab.opened.slice(1);
    assert.equal(mr1!.title, 'Change spec C1: Change C1 (Due dates)');
    assert.match(mr1!.description, /Repo: `api` · Depends on: nothing/);
    assert.ok(mr1!.description.includes(`Epic spec: ${mrUrl(1)}`));
    assert.ok(onRemote(remote, c1, `epics/${slug}/changes/C1.md`));
    assert.equal(onRemote(remote, c1, `epics/${slug}/changes/C2.md`), undefined);
    assert.equal(onRemote(remote, c1, `epics/${slug}/epic-spec.md`), undefined);
    assert.ok(onRemote(remote, c2, `epics/${slug}/changes/C2.md`));
    assert.deepEqual((await epicOf(deps, slug)).changeSpecMergeRequests, { C1: { iid: 2, url: mrUrl(2) }, C2: { iid: 3, url: mrUrl(3) } });

    // Redrafting one change is a commit on its MR only.
    assert.ok((await reviseChange(deps, slug, 'C1', 'more detail')).ok);
    await run(deps, slug);
    assert.equal(gitlab.opened.length, 3);
    assert.match(onRemote(remote, c1, `epics/${slug}/changes/C1.md`) ?? '', /in more detail/);
    assert.equal(commitsAhead(remote, c1), 2);
    assert.equal(commitsAhead(remote, c2), 1);

    // Plan feedback merges C2 into C1: C1's MR gets the new version, C2's MR is closed.
    assert.ok((await revisePlan(deps, slug, 'merge C2 into C1')).ok);
    await run(deps, slug);
    assert.equal(gitlab.opened.length, 3);
    assert.match(onRemote(remote, c1, `epics/${slug}/changes/C1.md`) ?? '', /Do C1 and C2/);
    assert.deepEqual([...gitlab.closed], [3]);
    assert.deepEqual(Object.keys((await epicOf(deps, slug)).changeSpecMergeRequests), ['C1']);

    // Approving a change spec publishes the owner's own edits.
    const c1Path = deps.artifacts.pathOf(slug, 'changes/C1.md');
    await writeFile(c1Path, (onRemote(remote, c1, `epics/${slug}/changes/C1.md`) ?? '').replace('Do C1 and C2.', 'Do C1 and C2, as the owner says.') + '\n');
    assert.ok((await approveChange(deps, slug, 'C1', undefined)).ok);
    assert.match(onRemote(remote, c1, `epics/${slug}/changes/C1.md`) ?? '', /as the owner says/);
    assert.equal(commitsAhead(remote, c1), 4);
    assert.deepEqual(warnings, []);
  });

  it('closes the MR of a dropped change spec', async () => {
    const { deps, gitlab } = await setup();
    const slug = await throughEpicSpec(deps);
    await run(deps, slug);
    assert.ok((await dropChange(deps, slug, 'C2', 'not needed')).ok);
    assert.deepEqual([...gitlab.closed], [3]);
    assert.deepEqual(Object.keys((await epicOf(deps, slug)).changeSpecMergeRequests), ['C1']);
  });

  it('starts a new MR from the base once the last one was merged', async () => {
    const { deps, gitlab, remote } = await setup();
    const created = await createEpic(deps, 'Due dates', 'Todos get due dates.');
    assert.ok(created.ok);
    const slug = created.value;
    await run(deps, slug);
    assert.ok((await approveStage(deps, slug, undefined)).ok);
    await run(deps, slug);
    gitlab.merged.add(1);

    assert.ok((await reviseStage(deps, slug, 'again')).ok);
    await run(deps, slug);
    assert.equal(gitlab.opened.length, 2);
    assert.equal((await epicOf(deps, slug)).specMergeRequest?.iid, 2);
    assert.equal(commitsAhead(remote, specBranch(deps, slug, EPIC)), 1, 'the new MR starts over from main');
  });

  it('never fails the stage when the MR cannot be opened', async () => {
    const { deps, warnings } = await setup({ failOpen: true });
    const created = await createEpic(deps, 'Due dates', 'Todos get due dates.');
    assert.ok(created.ok);
    await run(deps, created.value);
    assert.ok((await approveStage(deps, created.value, undefined)).ok);
    await run(deps, created.value);
    const epic = await epicOf(deps, created.value);
    assert.equal(epic.status, 'awaiting_approval');
    assert.equal(epic.specMergeRequest, undefined);
    assert.match(warnings.join('\n'), /Could not publish the epic spec MR on group\/planning: could not open MR: HTTP 403/);
  });
});
