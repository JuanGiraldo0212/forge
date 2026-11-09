/**
 * GitLab sign-in: the glab adapter, the gitlab.auth setting, and how the desktop app shows it.
 * glab is replaced by a scripted runner, so no real glab or GitLab is needed.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { parse } from 'yaml';
import { writeConfigFiles } from '../src/adapters/fs.ts';
import { glabAccess, glabCodeHost, type GlabResult, type GlabRun } from '../src/adapters/glab.ts';
import { gitlabCodeHost } from '../src/adapters/gitlab.ts';
import { composeDeps } from '../src/app/compose.ts';
import { applyLocal, parseConfig } from '../src/application/config.ts';
import { applyGitlabAuth } from '../src/application/configEdit.ts';
import { createHandlers } from '../src/desktop/main/handlers.ts';
import type { Session } from '../src/desktop/main/session.ts';
import { fileSettings } from '../src/desktop/main/settings.ts';
import { gitlabAccessView } from '../src/desktop/renderer/model.ts';
import type { GitlabAccess } from '../src/ports/index.ts';
import type { Outcome } from '../src/ui/actions.ts';
import { makeRepo, tempDir } from './helpers.ts';

type GlabCall = { readonly args: readonly string[]; readonly stdin?: string };

const exited = (code: number, stdout: string, stderr = ''): GlabResult => ({ kind: 'exited', code, stdout, stderr });

const scriptedGlab = (answer: (call: GlabCall) => GlabResult): GlabRun & { readonly calls: GlabCall[] } => {
  const calls: GlabCall[] = [];
  const run: GlabRun = async (args, options = {}) => {
    const call = { args, stdin: options.stdin };
    calls.push(call);
    return answer(call);
  };
  return Object.assign(run, { calls });
};

const MR = { sourceBranch: 'forge/e/C1', targetBranch: 'main', title: 'C1: Thing', description: '# Spec\n\n"quotes" & newlines\n' };
const MR_JSON = JSON.stringify({ iid: 7, web_url: 'https://gitlab.example.com/g/api/-/merge_requests/7', state: 'opened', head_pipeline: { status: 'running' } });

describe('glab code host', () => {
  it('sends the same JSON body as the REST adapter, on stdin, to the instance glab knows', async () => {
    const glab = scriptedGlab(() => exited(0, MR_JSON));
    const host = glabCodeHost({ baseUrl: 'https://gitlab.example.com:8443/', project: 'g/sub/api', run: glab });
    assert.deepEqual(await host.openMergeRequest(MR), { ok: true, value: { iid: 7, url: 'https://gitlab.example.com/g/api/-/merge_requests/7' } });
    assert.deepEqual(await host.getMergeRequest(7), { ok: true, value: { state: 'opened', pipeline: 'running', url: 'https://gitlab.example.com/g/api/-/merge_requests/7' } });

    const [post] = glab.calls;
    assert.ok(post?.args.includes('gitlab.example.com:8443'), 'the host keeps its port');
    assert.equal(post?.args.at(-1), 'projects/g%2Fsub%2Fapi/merge_requests');
    assert.ok(!post?.args.some((arg) => arg.includes('Spec')), 'the description never reaches the command line');

    let restBody: unknown;
    const rest = gitlabCodeHost({
      baseUrl: 'https://gitlab.example.com:8443',
      project: 'g/sub/api',
      token: 't',
      fetch: (async (_url: string, init: RequestInit) => {
        restBody = JSON.parse(String(init.body));
        return new Response(MR_JSON);
      }) as typeof fetch,
    });
    await rest.openMergeRequest(MR);
    assert.deepEqual(JSON.parse(post?.stdin ?? ''), restBody);
  });

  it('says what to do when glab is missing, signed out, or the API refuses', async () => {
    const failing = async (result: GlabResult): Promise<string> => {
      const r = await glabCodeHost({ baseUrl: 'https://gitlab.example.com', project: 'g/api', run: async () => result }).getMergeRequest(1);
      assert.ok(!r.ok);
      return r.error.message;
    };
    assert.match(await failing({ kind: 'missing' }), /glab \(the GitLab CLI\) was not found on PATH where forge runs/);
    assert.match(await failing(exited(1, '', 'glab: 401 Unauthorized (HTTP 401)')), /not signed in to gitlab\.example\.com.*glab auth login --hostname gitlab\.example\.com/);
    assert.match(await failing(exited(1, '', 'x gitlab.example.com has not been authenticated with glab; run `glab auth login`')), /not signed in/);
    assert.match(await failing(exited(1, '', 'error refreshing token: oauth2: "invalid_grant"')), /not signed in/, 'an expired OAuth login');
    assert.equal(await failing(exited(1, '{"message":"404 Project Not Found"}', 'glab: 404 Project Not Found (HTTP 404)')), 'GET /merge_requests/1 -> glab: 404 Project Not Found (HTTP 404) {"message":"404 Project Not Found"}');
    assert.match(await failing(exited(0, 'not json')), /unexpected answer from glab/);
  });
});

describe('glab access check', () => {
  const access = (result: GlabResult): Promise<GitlabAccess> => glabAccess({ baseUrl: 'https://gitlab.example.com', run: async () => result });

  it('tells a missing glab from a check that could not reach GitLab', async () => {
    assert.deepEqual(await access({ kind: 'missing' }), { kind: 'glab_missing', host: 'gitlab.example.com' });
    assert.deepEqual(
      await access(exited(1, '', '          \n   ERROR  \n          \n  Get "https://gitlab.example.com/api/v4/user": dial tcp: no such \n  host.\n')),
      { kind: 'unreachable', host: 'gitlab.example.com', detail: 'Get "https://gitlab.example.com/api/v4/user": dial tcp: no such host.' },
      "offline is not signed out, and glab's ERROR banner is dropped",
    );
  });
});

const CONFIG = `# Team config. Keep this comment.
gitlab:
  baseUrl: https://gitlab.example.com
repos:
  api:
    path: ../api
    project: g/api
    checks:
      - { name: test, run: "true" }
`;

describe('gitlab.auth setting', () => {
  it('defaults to the token, so existing configs behave as before', () => {
    const config = parseConfig(parse(CONFIG));
    assert.ok(config.ok);
    assert.equal(config.value.gitlab.auth, 'token');
  });

  it("lets this machine's local.yaml override the team's choice", () => {
    const merged = applyLocal(parse(CONFIG), { gitlab: { auth: 'glab' } });
    assert.ok(merged.ok);
    const config = parseConfig(merged.value);
    assert.ok(config.ok);
    assert.equal(config.value.gitlab.auth, 'glab');
    assert.equal(config.value.gitlab.baseUrl, 'https://gitlab.example.com', 'the rest of the section is kept');
  });

  it('saves the choice in local.yaml only, and drops it when it matches the team', () => {
    const local = '# mine\nrepos:\n  api:\n    path: ~/work/api\n';
    const glab = applyGitlabAuth(CONFIG, local, 'glab');
    assert.ok(glab.ok);
    assert.equal(glab.value.config, CONFIG, 'the shared config is untouched');
    assert.match(glab.value.local, /^# mine/);
    assert.deepEqual(parse(glab.value.local), { repos: { api: { path: '~/work/api' } }, gitlab: { auth: 'glab' } });

    const back = applyGitlabAuth(CONFIG, glab.value.local, 'token');
    assert.ok(back.ok);
    assert.deepEqual(parse(back.value.local), { repos: { api: { path: '~/work/api' } } });
  });
});

describe('composition', () => {
  it('opens and reads MRs through glab with no token, and checks the glab login', async () => {
    const dir = await tempDir();
    const ws = await makeRepo(dir, 'planning');
    await makeRepo(dir, 'api');
    await writeConfigFiles(ws.repo, { config: CONFIG, local: 'gitlab:\n  auth: glab\n' });
    const glab = scriptedGlab((call) => exited(0, call.args.at(-1) === 'user' ? '{"username":"jose"}' : MR_JSON));
    const composed = await composeDeps(ws.repo, { log: { info() {}, warn() {} } }, { glab });
    assert.ok(composed.ok);
    const { deps, gitlabAccess } = composed.value;
    assert.ok((await deps.repos.api!.host.getMergeRequest(7)).ok);
    assert.deepEqual(await gitlabAccess(), { kind: 'ready', host: 'gitlab.example.com', user: 'jose' });
    assert.deepEqual(glab.calls.map((c) => c.args.at(-1)), ['projects/g%2Fapi/merge_requests/7', 'user']);
  });
});

describe('desktop GitLab sign-in', () => {
  const withWorkspace = async (busy: readonly string[] = []) => {
    const dir = await tempDir();
    const ws = await makeRepo(dir, 'planning');
    await makeRepo(dir, 'api');
    await writeConfigFiles(ws.repo, { config: CONFIG, local: '' });
    const opened: string[] = [];
    const session = { info: { root: ws.repo }, busy: () => busy } as unknown as Session;
    const { dispatch } = createHandlers({
      session: () => session,
      open: async (root) => {
        opened.push(root);
        return { workspace: null };
      },
      chooseFolder: async () => undefined,
      openExternal: async () => {},
      settings: fileSettings(join(dir, 's.json'), { available: () => false, encrypt: () => Buffer.alloc(0), decrypt: () => '' }),
    });
    return { root: ws.repo, dispatch, opened };
  };

  it('switches to glab for this machine and reopens the workspace', async () => {
    const { root, dispatch, opened } = await withWorkspace();
    const saved = (await dispatch('setGitlabAuth', ['glab'])) as Outcome;
    assert.ok(saved.ok, saved.text);
    assert.deepEqual(opened, [root]);
    assert.deepEqual(parse(await readFile(join(root, '.forge', 'local.yaml'), 'utf8')), { gitlab: { auth: 'glab' } });
  });

  it('refuses to switch while agents run, before writing anything', async () => {
    const { root, dispatch, opened } = await withWorkspace(['ep']);
    const refused = (await dispatch('setGitlabAuth', ['glab'])) as Outcome;
    assert.ok(!refused.ok);
    assert.deepEqual(opened, []);
    await assert.rejects(readFile(join(root, '.forge', 'local.yaml'), 'utf8'));
  });

  it('names the machine glab runs on: this computer, or the SSH server', () => {
    const signedOut: GitlabAccess = { kind: 'glab_signed_out', host: 'gitlab.example.com', detail: '401' };
    const local = gitlabAccessView(signedOut, { kind: 'local' });
    assert.match(local.text, /glab on this computer isn't signed in to gitlab\.example\.com/);
    assert.equal(local.command, 'glab auth login --hostname gitlab.example.com');
    assert.match(gitlabAccessView(signedOut, { kind: 'remote', id: 'h', label: 'jose@build-box', home: '/home/jose' }).text, /glab on the server \(jose@build-box\)/);
  });
});
