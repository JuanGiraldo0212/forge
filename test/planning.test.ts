/**
 * What planning agents see of the code repos: fresh snapshots of the base, never the working copy.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { optionsFor } from '../src/adapters/claudeAgent.ts';
import { fsRepoContext } from '../src/adapters/fs.ts';
import { preparePlanning } from '../src/application/planning.ts';
import { makeDeps, makeRepo, scriptedAgent, sh, tempDir } from './helpers.ts';
import { readFile } from 'node:fs/promises';

const setup = async () => {
  const dir = await tempDir();
  const ws = await makeRepo(dir, 'planning');
  const api = await makeRepo(dir, 'api', { 'todos.js': 'v1\n' });
  const warnings: string[] = [];
  const made = await makeDeps({ workspace: ws.repo, worktrees: join(dir, 'wt'), agent: scriptedAgent([], async () => undefined), repos: [{ name: 'api', dir: api.repo, checks: [{ name: 'test', run: 'true' }] }] });
  const deps = { ...made.deps, log: { info: () => {}, warn: (m: string) => void warnings.push(m) } };
  return { dir, api, deps, warnings };
};

/** A teammate pushes from their own clone. */
const pushFromElsewhere = async (dir: string, remote: string, file: string, content: string) => {
  const other = join(dir, `other-${Date.now()}`);
  sh(dir, 'clone', '-q', remote, other);
  sh(other, 'config', 'user.email', 'mate@example.com');
  sh(other, 'config', 'user.name', 'Mate');
  await writeFile(join(other, file), content);
  sh(other, 'add', '.');
  sh(other, 'commit', '-q', '-m', 'teammate change');
  sh(other, 'push', '-q', 'origin', 'main');
};

describe('planning snapshots', () => {
  it('refreshes to the latest origin/main before every planning run', async () => {
    const { dir, api, deps } = await setup();
    const first = await preparePlanning(deps);
    const snap = first.repos[0]!;
    assert.equal(snap.source, 'snapshot');
    assert.equal(await readFile(join(snap.root, 'todos.js'), 'utf8'), 'v1\n');

    await pushFromElsewhere(dir, api.remote, 'todos.js', 'v2\n');
    await writeFile(join(api.repo, 'todos.js'), 'my local edit\n');
    const second = await preparePlanning(deps);
    assert.equal(await readFile(join(second.repos[0]!.root, 'todos.js'), 'utf8'), 'v2\n', 'sees the push, not the local edit');
    assert.notEqual(second.repos[0]!.commit, snap.commit);
  });

  it('falls back to the last snapshot, then the working copy, and says so', async () => {
    const { api, deps, warnings } = await setup();
    await preparePlanning(deps);
    sh(api.repo, 'remote', 'set-url', 'origin', '/nonexistent/remote.git');
    const stale = await preparePlanning(deps);
    assert.equal(stale.repos[0]!.source, 'stale-snapshot');
    assert.match(warnings.join(), /planning from the last snapshot/);

    const fresh = await setup();
    sh(fresh.api.repo, 'remote', 'set-url', 'origin', '/nonexistent/remote.git');
    const working = await preparePlanning(fresh.deps);
    assert.equal(working.repos[0]!.source, 'working-copy');
    assert.equal(working.repos[0]!.root, fresh.api.repo);
    assert.match(fresh.warnings.join(), /planning from the working copy/);
  });
});

describe('repo instructions', () => {
  it('reads AGENTS.md and CLAUDE.md (root and .claude/), each once', async () => {
    const dir = await tempDir();
    await writeFile(join(dir, 'AGENTS.md'), 'agents rules');
    await writeFile(join(dir, 'CLAUDE.md'), 'agents rules');
    await mkdir(join(dir, '.claude'));
    await writeFile(join(dir, '.claude', 'CLAUDE.md'), 'claude-only rules');
    const all = await fsRepoContext(dir).instructions();
    assert.equal(all.match(/agents rules/g)?.length, 1, 'identical files appear once');
    assert.match(all, /claude-only rules/);
    assert.doesNotMatch(await fsRepoContext(dir, { claudeMd: false }).instructions(), /claude-only/);
  });

  it('turns denied paths into Read deny rules for both agent modes', () => {
    const base = { epic: 'e', label: 'x', cwd: '/w', model: 'm', systemPrompt: '', prompt: '', maxTurns: 1, denyRead: ['/w/epics/**/events.jsonl'] };
    const read = optionsFor({ ...base, mode: 'read' }, { effort: 'high', allowedDomains: [], withheldEnv: [] }, new AbortController());
    assert.deepEqual(read.disallowedTools, ['Read(//w/epics/**/events.jsonl)']);
    const build = optionsFor({ ...base, mode: 'build' }, { effort: 'high', allowedDomains: [], withheldEnv: [] }, new AbortController());
    assert.ok(build.disallowedTools?.includes('Read(//w/epics/**/events.jsonl)'));
    assert.ok(build.disallowedTools?.includes('Bash(git push:*)'));
  });
});
