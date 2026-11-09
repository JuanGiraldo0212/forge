import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { applyRepoEdits, readGitlabBaseUrl, readRepoEdits, type RepoEdit } from '../src/application/configEdit.ts';

const CONFIG = `# Team config. Keep this comment.
epicsDir: epics
repos:
  api:
    path: ../api   # sibling clone
    project: group/api
    checks:
      - { name: test, run: npm test }
`;

const api: RepoEdit = {
  name: 'api',
  path: '../api',
  localPath: '',
  project: 'group/api',
  baseBranch: 'main',
  remote: 'origin',
  setup: [],
  checks: [{ name: 'test', run: 'npm test' }],
  revertCheck: 'test',
};

describe('repo config editing', () => {
  it("reads repos with this machine's path overrides", () => {
    const edits = readRepoEdits(CONFIG, 'repos:\n  api:\n    path: ~/work/api\n');
    assert.deepEqual(edits, [{ ...api, localPath: '~/work/api' }]);
  });

  it('adds a repo, keeps comments and order, and writes only non-default fields', () => {
    const web: RepoEdit = { ...api, name: 'web', path: '../web', project: 'group/web', baseBranch: 'develop', setup: ['npm ci'], checks: [{ name: 'unit', run: 'npm test' }], revertCheck: 'unit' };
    const r = applyRepoEdits(CONFIG, undefined, [api, web]);
    assert.ok(r.ok, JSON.stringify(r));
    assert.match(r.value.config, /# Team config\. Keep this comment\./);
    assert.match(r.value.config, /path: \.\.\/api +# sibling clone/);
    const parsed = parse(r.value.config);
    assert.deepEqual(Object.keys(parsed.repos), ['api', 'web']);
    assert.equal(parsed.repos.api.baseBranch, undefined, 'default branch is not written');
    assert.equal(parsed.repos.web.baseBranch, 'develop');
    assert.deepEqual(parsed.repos.web.setup, ['npm ci']);
    assert.equal(parsed.repos.web.revertTest.check, 'unit');
    assert.equal(r.value.local, '');
  });

  it('sets the GitLab URL, and leaves it out of the file when it is the default', () => {
    assert.equal(readGitlabBaseUrl(CONFIG), 'https://gitlab.com');
    const set = applyRepoEdits(CONFIG, undefined, [api], ' https://gitlab.example.com/ ');
    assert.ok(set.ok, JSON.stringify(set));
    assert.equal(parse(set.value.config).gitlab.baseUrl, 'https://gitlab.example.com');
    assert.equal(readGitlabBaseUrl(set.value.config), 'https://gitlab.example.com');
    assert.match(set.value.config, /# Team config\. Keep this comment\./);

    const withToken = applyRepoEdits(`${CONFIG}gitlab:\n  tokenEnv: MY_TOKEN\n  baseUrl: https://gitlab.example.com\n`, undefined, [api]);
    assert.ok(withToken.ok, JSON.stringify(withToken));
    const back = applyRepoEdits(withToken.value.config, undefined, [api], 'https://gitlab.com');
    assert.ok(back.ok, JSON.stringify(back));
    assert.deepEqual(parse(back.value.config).gitlab, { tokenEnv: 'MY_TOKEN' });

    const cleared = applyRepoEdits(set.value.config, undefined, [api], '');
    assert.ok(cleared.ok);
    assert.equal(parse(cleared.value.config).gitlab, undefined, 'an empty gitlab section is removed');

    const kept = applyRepoEdits(set.value.config, undefined, [api]);
    assert.ok(kept.ok);
    assert.equal(parse(kept.value.config).gitlab.baseUrl, 'https://gitlab.example.com', 'left alone when not given');

    const bad = applyRepoEdits(CONFIG, undefined, [api], 'gitlab.example.com');
    assert.ok(!bad.ok);
    assert.match(bad.error.join(), /must start with https:\/\//);
  });

  it('puts machine-only paths in local.yaml and removes repos from both files', () => {
    const r = applyRepoEdits(CONFIG, 'repos:\n  api:\n    path: /old\n', [{ ...api, localPath: '/home/me/api' }]);
    assert.ok(r.ok);
    assert.equal(parse(r.value.local).repos.api.path, '/home/me/api');
    assert.equal(parse(r.value.config).repos.api.path, '../api', 'the shared path is untouched');

    const web: RepoEdit = { ...api, name: 'web', path: '../web', project: 'group/web' };
    const removed = applyRepoEdits(CONFIG, 'repos:\n  api:\n    path: /x\n', [web]);
    assert.ok(removed.ok);
    assert.equal(parse(removed.value.config).repos.api, undefined);
    assert.equal(removed.value.local, '', 'nothing left to override');
  });

  it('validates like startup does', () => {
    const bad = applyRepoEdits(CONFIG, undefined, [{ ...api, checks: [] }]);
    assert.match(bad.ok ? '' : bad.error.join(), /at least one check/);
    const badRevert = applyRepoEdits(CONFIG, undefined, [{ ...api, revertCheck: 'unit' }]);
    assert.match(badRevert.ok ? '' : badRevert.error.join(), /revertTest/);
    assert.equal(applyRepoEdits(CONFIG, undefined, [{ ...api, name: 'My Repo' }]).ok, false);
    assert.equal(applyRepoEdits(CONFIG, undefined, [api, api]).ok, false, 'duplicate names');
  });

  it('creates a new workspace config from scratch', () => {
    const r = applyRepoEdits(undefined, undefined, [api]);
    assert.ok(r.ok);
    assert.match(r.value.config, /epicsDir: epics/);
    assert.equal(parse(r.value.config).repos.api.project, 'group/api');
  });
});
