/**
 * Remote workspaces: the RPC protocol, the forge server, the connection manager, and a full round trip
 * through a real SSH server (ssh2's, in-process, running commands in a temp HOME).
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ssh2, { type Connection } from 'ssh2';
import { writeConfigFiles } from '../src/adapters/fs.ts';
import { err, ok } from '../src/domain/result.ts';
import type { Backend } from '../src/desktop/main/backend.ts';
import { connectionManager, type ConnectionDeps } from '../src/desktop/main/connection.ts';
import { SERVER_DEPENDENCIES } from '../src/desktop/main/serverBundle.ts';
import { fileSettings, hostId, type Keychain, type WorkspaceSettings } from '../src/desktop/main/settings.ts';
import { missingTools, parseProbe, startRemote, type RemoteHooks, type RemoteServer, type ServerBundle } from '../src/desktop/remote/client.ts';
import { rpcPeer } from '../src/desktop/remote/rpc.ts';
import { PROTOCOL, serveForge } from '../src/desktop/remote/server.ts';
import { fingerprintOf, inLoginShell } from '../src/desktop/remote/ssh.ts';
import type { ConnectionChange, ConnectRequest, ConnectResult, DirListing, FolderRequest, Outcome, WorkspaceInfo } from '../src/desktop/shared/api.ts';
import { makeRepo, tempDir } from './helpers.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Two connected peers, like the app and the server on either end of an SSH channel. */
const pipePair = () => {
  const aToB = new PassThrough();
  const bToA = new PassThrough();
  return { a: { input: bToA, output: aToB }, b: { input: aToB, output: bToA } };
};

const keychain: Keychain = {
  available: () => true,
  encrypt: (plain) => Buffer.from(`enc:${plain}`),
  decrypt: (cipher) => cipher.toString().replace(/^enc:/, ''),
};

const memorySettings = (): WorkspaceSettings & { tokens: Map<string, string>; recents: string[]; asked: string[] } => {
  const tokens = new Map<string, string>();
  const recents: string[] = [];
  const asked: string[] = [];
  return {
    tokens,
    recents,
    asked,
    recent: async () => recents,
    addRecent: async (root) => void recents.unshift(root),
    token: async (env) => (asked.push(env), tokens.get(env)),
    setToken: async (env, token) => (token ? tokens.set(env, token) : tokens.delete(env), ok(undefined)),
    canStoreToken: () => true,
  };
};

/** A planning repo with one code repo, set up as a forge workspace. */
const workspace = async () => {
  const dir = await tempDir();
  const ws = await makeRepo(dir, 'planning');
  await makeRepo(dir, 'api');
  await writeConfigFiles(ws.repo, {
    config: `worktreeRoot: ${join(dir, 'wt')}\nrepos:\n  api:\n    path: ../api\n    project: g/api\n    checks:\n      - { name: test, run: "true" }\n`,
    local: '',
  });
  return { dir, root: ws.repo };
};

describe('rpc', () => {
  it('carries requests both ways, events, and errors, and skips non-protocol lines', async () => {
    const { a, b } = pipePair();
    const events: unknown[] = [];
    const noise: string[] = [];
    const left = rpcPeer(a.input, a.output, { request: async (m, p) => ({ left: m, p }), event: (e, p) => events.push([e, p]), noise: (l) => noise.push(l) });
    const right = rpcPeer(b.input, b.output, {
      request: async (m) => {
        if (m === 'boom') throw new Error('it broke');
        return left === undefined ? null : `right:${m}`;
      },
    });
    a.input.write('Welcome to the server!\n');
    assert.equal(await left.request('ping'), 'right:ping');
    assert.deepEqual(await right.request('hey', { n: 1 }), { left: 'hey', p: { n: 1 } });
    await assert.rejects(left.request('boom'), /it broke/);
    right.notify('busy', ['e1']);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(events, [['busy', ['e1']]]);
    assert.deepEqual(noise, ['Welcome to the server!']);
  });

  it('rejects pending requests when the other side goes away', async () => {
    const { a, b } = pipePair();
    const left = rpcPeer(a.input, a.output, { request: async () => null });
    rpcPeer(b.input, b.output, { request: () => new Promise(() => {}) });
    const pending = left.request('never');
    a.input.end();
    await assert.rejects(pending, /closed/);
    await left.closed;
  });
});

describe('forge server', () => {
  const connect = () => {
    const { a, b } = pipePair();
    const settings = memorySettings();
    const folders: string[] = [];
    const events: string[] = [];
    let pick: string | null = null;
    const server = serveForge(b.input, b.output);
    const app = rpcPeer(a.input, a.output, {
      request: async (method, params) => {
        if (method === 'chooseFolder') return (folders.push((params as { title: string }).title), pick);
        if (method === 'settings') {
          const { op, args } = params as { op: keyof WorkspaceSettings; args: unknown[] };
          return (settings[op] as (...a: unknown[]) => unknown)(...args) ?? null;
        }
        throw new Error(method);
      },
      event: (e) => events.push(e),
    });
    const call = (method: string, ...args: unknown[]) => app.request('call', { method, args });
    return { app, server, settings, folders, events, call, end: () => a.output.end(), setPick: (p: string | null) => (pick = p) };
  };

  it('needs hello first, then runs workspace methods on its own machine', async () => {
    const { app, call, end, server } = connect();
    await assert.rejects(call('workspace'), /hello/);
    await assert.rejects(app.request('hello', { protocol: PROTOCOL + 1, env: {}, canStoreToken: true }), /protocol/);
    const hello = (await app.request('hello', { protocol: PROTOCOL, env: { FORGE_TEST_REMOTE_ENV: 'yes' }, canStoreToken: true })) as { home: string };
    assert.ok(hello.home);
    assert.equal(process.env.FORGE_TEST_REMOTE_ENV, 'yes');
    delete process.env.FORGE_TEST_REMOTE_ENV;
    assert.equal(await call('workspace'), null);
    await assert.rejects(call('readDoc', 'Not A Slug', 'idea.md'), /Invalid arguments/);
    end();
    await server.done;
  });

  it('opens a workspace picked in the app, records it as recent there, and reads the token from the app', async () => {
    const ws = await workspace();
    const { app, call, end, server, settings, folders, events, setPick } = connect();
    settings.tokens.set('GITLAB_TOKEN', 'glpat-from-app');
    await app.request('hello', { protocol: PROTOCOL, env: {}, canStoreToken: true });

    const listing = (await call('listDirectory', ws.dir)) as DirListing;
    assert.deepEqual(
      listing.entries.filter((e) => e.git).map((e) => [e.name, e.forge]),
      [['api', false], ['planning', true]],
    );

    setPick(ws.root);
    const opened = (await call('chooseWorkspace')) as { workspace: WorkspaceInfo };
    assert.deepEqual(folders, ['Open a forge workspace']);
    assert.equal(opened.workspace.root, ws.root);
    assert.equal(opened.workspace.gitlabTokenSet, true);
    assert.deepEqual(settings.recents, [ws.root]);
    assert.ok(events.includes('opened') && events.includes('epicsChanged'));

    const created = (await call('createEpic', 'Due dates', 'Todos get due dates')) as Outcome;
    assert.ok(created.ok, created.text);
    assert.ok(existsSync(join(ws.root, 'epics', 'due-dates', 'idea.md')));
    end();
    await server.done;
    delete process.env.GITLAB_TOKEN;
  });

  it('with the glab login, never asks the app for the token', async () => {
    const ws = await workspace();
    const { app, call, end, server, settings } = connect();
    const { asked } = settings;
    settings.tokens.set('GITLAB_TOKEN', 'glpat-from-app');
    await app.request('hello', { protocol: PROTOCOL, env: {}, canStoreToken: true });

    await writeFile(join(ws.root, '.forge', 'local.yaml'), 'gitlab:\n  auth: glab\n');
    const opened = (await call('openWorkspace', ws.root)) as { workspace: WorkspaceInfo };
    assert.equal(opened.workspace.gitlabAuth, 'glab');
    assert.deepEqual(asked, []);
    end();
    await server.done;
  });

  it('imports only the packages it declares, so the uploaded package.json is complete', async () => {
    const seen = new Set<string>();
    const bare = new Set<string>();
    const visit = async (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = await readFile(file, 'utf8');
      for (const m of src.matchAll(/^\s*(?:import|export)\s(?!type\b)[^'"]*?from\s+'([^']+)'|^\s*import\s+'([^']+)'/gm)) {
        const spec = (m[1] ?? m[2])!;
        if (spec.startsWith('.')) await visit(resolve(dirname(file), spec));
        else if (!spec.startsWith('node:') && !builtinModules.includes(spec)) bare.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!);
      }
    };
    await visit(join(ROOT, 'src/desktop/remote/serverMain.ts'));
    assert.deepEqual([...bare].sort(), [...SERVER_DEPENDENCIES].sort());
  });
});

describe('remote helpers', () => {
  it('reads the probe between markers despite shell noise, and says what is missing', () => {
    const p = parseProbe('bash: no job control\n__FORGE_PROBE__/home/dev|v22.1.0||git version 2.43__FORGE_PROBE__\n');
    assert.deepEqual(p, { home: '/home/dev', node: 'v22.1.0', npm: '', git: 'git version 2.43' });
    assert.deepEqual(missingTools(p!, 'box'), ['box has Node.js v22.1.0; forge needs 24 or newer.', "npm isn't installed on box."]);
    assert.match(missingTools({ ...p!, node: '', npm: '10' }, 'box')[0] ?? '', /isn't installed on box/);
  });

  it('runs commands through a login shell with their quoting intact', async () => {
    const out = await new Promise<string>((done) => {
      const child = spawn('sh', ['-c', inLoginShell(`printf '%s' "it's $((1+1))"`)], { env: { ...process.env, SHELL: '/bin/sh' } });
      let text = '';
      child.stdout.on('data', (d) => (text += d));
      child.on('close', () => done(text));
    });
    assert.equal(out, "it's 2");
  });

  it('stores SSH hosts with encrypted passwords, trusted keys and recent workspaces', async () => {
    const dir = await tempDir();
    const settings = fileSettings(join(dir, 's.json'), keychain);
    const fields = { host: 'box', port: 22, username: 'dev', auth: 'password' as const, keyPath: '', forwardClaude: true };
    const saved = await settings.saveHost(fields, 's3cret');
    assert.ok(saved.ok);
    assert.equal(saved.value.id, 'dev@box');
    assert.doesNotMatch(await readFile(join(dir, 's.json'), 'utf8'), /"s3cret"/);
    assert.equal(await settings.hostPassword('dev@box'), 's3cret');
    await settings.trustHost('dev@box', 'SHA256:abc');
    await settings.addHostRecent('dev@box', '/srv/planning');
    await settings.saveHost(fields); // keeps the password, key and recents
    const [entry] = await settings.hosts();
    assert.deepEqual([entry?.savedPassword, entry?.fingerprint, entry?.recent], [true, 'SHA256:abc', ['/srv/planning']]);
    await settings.saveHost(fields, null);
    assert.equal(await settings.hostPassword('dev@box'), undefined);
    await settings.forgetHost('dev@box');
    assert.deepEqual(await settings.hosts(), []);
    assert.equal(hostId({ host: 'box', port: 2222, username: 'dev' }), 'dev@box:2222');

    const noKeychain = fileSettings(join(dir, 'n.json'), { ...keychain, available: () => false });
    assert.equal((await noKeychain.saveHost(fields, 'pw')).ok, false);
  });
});

describe('connection manager', () => {
  const request = (patch: Partial<ConnectRequest> = {}): ConnectRequest => ({
    host: 'box',
    port: 22,
    username: 'dev',
    auth: 'password',
    password: 'pw',
    rememberPassword: true,
    keyPath: '',
    passphrase: '',
    forwardClaude: true,
    trustFingerprint: null,
    ...patch,
  });

  const setup = async (start: ConnectionDeps['start']) => {
    const dir = await tempDir();
    const settings = fileSettings(join(dir, 's.json'), keychain);
    const sent: [string, unknown][] = [];
    const titles: string[] = [];
    const localCalls: string[] = [];
    const local: Backend = {
      dispatch: async (method) => (localCalls.push(method), method === 'workspace' ? null : `local:${method}`),
      busy: () => [],
      close: () => {},
    };
    const bundle: ServerBundle = { id: 'b1', files: [], install: false, args: ['server.js'] };
    const m = connectionManager({
      settings,
      local,
      bundle: async () => ok(bundle),
      start,
      readFile: async (p) => (p.endsWith('id_test') ? Buffer.from('KEY') : Promise.reject(new Error('nope'))),
      env: { ANTHROPIC_API_KEY: 'sk-local', HOME: '/home/me' },
      send: (e, p) => sent.push([e, p]),
      shown: (w, c) => titles.push(`${w?.name ?? '-'}@${c.kind === 'remote' ? c.label : 'local'}`),
    });
    return { m, settings, sent, titles, localCalls };
  };

  /** A fake host: trusts one key, records what forge was started with, and answers calls itself. */
  const fakeHost = (key = 'SHA256:host') => {
    const starts: { trusted?: string; env: Readonly<Record<string, string>>; password?: string }[] = [];
    let hooks: RemoteHooks | undefined;
    const calls: string[] = [];
    let closed = 0;
    const start: ConnectionDeps['start'] = async (target, opts) => {
      starts.push({ trusted: opts.trustedFingerprint, env: opts.env, password: target.auth.kind === 'password' ? target.auth.password : undefined });
      if (opts.trustedFingerprint !== key) return err({ kind: 'host-key', fingerprint: key });
      hooks = opts.hooks;
      const server: RemoteServer = {
        home: '/home/dev',
        call: async (method) => (calls.push(method), method === 'workspace' ? null : `remote:${method}`),
        close: () => void closed++,
      };
      return ok(server);
    };
    return { start, starts, calls, hooks: () => hooks!, closed: () => closed };
  };

  it('asks to trust an unknown host key, then connects, remembers the host, and routes calls to it', async () => {
    const host = fakeHost();
    const { m, settings, sent } = await setup(host.start);
    const first = (await m.dispatch('connectRemote', [request()])) as ConnectResult;
    assert.equal(first.ok, false);
    assert.deepEqual(!first.ok && first.hostKey, { fingerprint: 'SHA256:host', changed: false });
    assert.deepEqual(await m.dispatch('connection', []), { kind: 'local' });

    const second = (await m.dispatch('connectRemote', [request({ trustFingerprint: 'SHA256:host' })])) as ConnectResult;
    assert.ok(second.ok);
    assert.deepEqual(host.starts[1]?.env, { ANTHROPIC_API_KEY: 'sk-local' });
    assert.equal(await m.dispatch('listEpics', []), 'remote:listEpics');
    assert.equal(await m.dispatch('openExternal', ['https://x']), 'local:openExternal');
    const [saved] = await settings.hosts();
    assert.deepEqual([saved?.id, saved?.fingerprint, saved?.savedPassword], ['dev@box', 'SHA256:host', true]);
    assert.ok(sent.some(([e, p]) => e === 'connectionChanged' && (p as ConnectionChange).connection.kind === 'remote'));

    // Next time: the saved key and password are used without asking.
    await m.dispatch('disconnectRemote', []);
    assert.equal(host.closed(), 1);
    const third = (await m.dispatch('connectRemote', [request({ password: '', forwardClaude: false })])) as ConnectResult;
    assert.ok(third.ok);
    assert.deepEqual([host.starts[2]?.trusted, host.starts[2]?.password, host.starts[2]?.env], ['SHA256:host', 'pw', {}]);
  });

  it('warns loudly when a trusted host key changes', async () => {
    const host = fakeHost('SHA256:new');
    const { m, settings } = await setup(host.start);
    await settings.saveHost({ host: 'box', port: 22, username: 'dev', auth: 'password', keyPath: '', forwardClaude: true }, 'pw');
    await settings.trustHost('dev@box', 'SHA256:old');
    const r = (await m.dispatch('connectRemote', [request()])) as ConnectResult;
    assert.equal(r.ok, false);
    assert.deepEqual(!r.ok && r.hostKey, { fingerprint: 'SHA256:new', changed: true });
    assert.match(!r.ok ? r.error : '', /has changed/);
    assert.equal(host.starts[0]?.trusted, 'SHA256:old');
  });

  it('reports missing credentials before connecting', async () => {
    const host = fakeHost();
    const { m } = await setup(host.start);
    assert.match(((await m.dispatch('connectRemote', [request({ password: '' })])) as { error: string }).error, /Enter the password/);
    assert.match(((await m.dispatch('connectRemote', [request({ auth: 'agent' })])) as { error: string }).error, /No SSH agent/);
    assert.match(((await m.dispatch('connectRemote', [request({ auth: 'key', keyPath: '/nope' })])) as { error: string }).error, /Can't read the private key/);
    assert.ok(((await m.dispatch('connectRemote', [request({ auth: 'key', keyPath: '/k/id_test', trustFingerprint: 'SHA256:host' })])) as ConnectResult).ok);
    assert.equal(host.starts.length, 1);
    await assert.rejects(m.dispatch('connectRemote', [request({ host: 'has space' })]), /Invalid arguments/);
  });

  it('passes folder requests to the UI, keeps host recents apart, and falls back to local when the link drops', async () => {
    const host = fakeHost();
    const { m, sent, settings } = await setup(host.start);
    await m.dispatch('connectRemote', [request({ trustFingerprint: 'SHA256:host' })]);
    const hooks = host.hooks();

    const picked = hooks.chooseFolder('Open a forge workspace');
    const ask = sent.find(([e]) => e === 'pickFolder')?.[1] as FolderRequest;
    assert.equal(ask.title, 'Open a forge workspace');
    await m.dispatch('folderPicked', [ask.id, '/srv/planning']);
    assert.equal(await picked, '/srv/planning');

    await hooks.settings.addRecent('/srv/planning');
    assert.deepEqual(await settings.hostRecent('dev@box'), ['/srv/planning']);
    assert.deepEqual(await settings.recent(), []);

    hooks.event('busy', ['ep']);
    assert.deepEqual(m.busy(), ['ep']);
    const refused = (await m.dispatch('disconnectRemote', [])) as Outcome;
    assert.match(refused.text, /Agents are running on ep/);
    assert.match(((await m.dispatch('connectRemote', [request()])) as { error: string }).error, /Stop them/);

    const pending = hooks.chooseFolder('Choose a code repository');
    hooks.lost('Lost the connection to dev@box.');
    assert.equal(await pending, null);
    assert.deepEqual(m.connection(), { kind: 'local' });
    await new Promise((r) => setImmediate(r));
    const change = sent.filter(([e]) => e === 'connectionChanged').at(-1)?.[1] as ConnectionChange;
    assert.deepEqual(change, { connection: { kind: 'local' }, error: 'Lost the connection to dev@box.' });
    assert.equal(await m.dispatch('listEpics', []), 'local:listEpics');
  });
});

describe('ssh round trip', () => {
  /** An SSH server that accepts one password and runs each exec request with `sh` in a temp HOME. */
  const sshServer = async (home: string, password: string) => {
    const { Server, utils } = ssh2;
    const hostKey = utils.generateKeyPairSync('ed25519');
    const parsed = utils.parseKey(hostKey.private);
    if (parsed instanceof Error) throw parsed;
    const fingerprint = fingerprintOf((Array.isArray(parsed) ? parsed[0]! : parsed).getPublicSSH());
    const server = new Server({ hostKeys: [hostKey.private] }, (client: Connection) => {
      client.on('authentication', (ctx) => (ctx.method === 'password' && ctx.username === 'dev' && ctx.password === password ? ctx.accept() : ctx.reject(['password'])));
      client.on('session', (accept) => {
        accept().on('exec', (acceptExec, _reject, info) => {
          const stream = acceptExec();
          const child = spawn('sh', ['-c', info.command], { env: { ...process.env, HOME: home, SHELL: '/bin/sh', ENV: '' }, cwd: home });
          stream.pipe(child.stdin);
          child.stdout.pipe(stream, { end: false });
          child.stderr.pipe(stream.stderr, { end: false });
          child.on('close', (code) => {
            stream.exit(code ?? 1);
            stream.end();
          });
          stream.on('close', () => child.kill());
        });
      });
      client.on('error', () => {});
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    return { port: (server.address() as AddressInfo).port, fingerprint, close: () => server.close() };
  };

  it('connects with a password, installs the server, opens a workspace on the host, and talks to it', { timeout: 60_000 }, async () => {
    const ws = await workspace();
    const home = join(ws.dir, 'home');
    await mkdir(home, { recursive: true });
    const ssh = await sshServer(home, 'hunter2');
    const tsx = pathToFileURL(join(ROOT, 'node_modules/tsx/dist/loader.mjs')).href;
    const bundle: ServerBundle = {
      id: 'test',
      files: [{ path: 'notes/hello.txt', content: Buffer.from('uploaded') }],
      install: false,
      args: ['--import', tsx, join(ROOT, 'src/desktop/remote/serverMain.ts')],
    };
    const settings = memorySettings();
    const statuses: string[] = [];
    const events: string[] = [];
    const lost: string[] = [];
    const hooks: RemoteHooks = {
      status: (t) => statuses.push(t),
      chooseFolder: async () => ws.root,
      settings,
      event: (e) => events.push(e),
      lost: (r) => lost.push(r),
    };
    const target = (pw: string) => ({ host: '127.0.0.1', port: ssh.port, username: 'dev', auth: { kind: 'password' as const, password: pw } });
    const opts = { bundle, env: {}, canStoreToken: true, hooks };

    try {
      const unknown = await startRemote(target('hunter2'), opts);
      assert.deepEqual(!unknown.ok && unknown.error, { kind: 'host-key', fingerprint: ssh.fingerprint });

      const wrong = await startRemote(target('nope'), { ...opts, trustedFingerprint: ssh.fingerprint });
      assert.match(!wrong.ok && wrong.error.kind === 'failed' ? wrong.error.message : '', /Authentication failed/);

      const started = await startRemote(target('hunter2'), { ...opts, trustedFingerprint: ssh.fingerprint });
      assert.ok(started.ok, JSON.stringify(!started.ok && started.error));
      const remote = started.value;
      assert.equal(remote.home, home);
      assert.equal(await readFile(join(home, '.forge/server/test/notes/hello.txt'), 'utf8'), 'uploaded');
      assert.ok(existsSync(join(home, '.forge/server/test/.ready')));
      assert.ok(statuses.some((s) => s.startsWith('Copying forge')));

      const opened = (await remote.call('chooseWorkspace', [])) as { workspace: WorkspaceInfo; error?: string };
      assert.equal(opened.error, undefined);
      assert.equal(opened.workspace.root, ws.root);
      assert.deepEqual(settings.recents, [ws.root]);
      const created = (await remote.call('createEpic', ['Remote epic', 'Built over SSH'])) as Outcome;
      assert.ok(created.ok, created.text);
      assert.deepEqual(
        ((await remote.call('listEpics', [])) as { slug: string }[]).map((e) => e.slug),
        ['remote-epic'],
      );
      assert.ok(events.includes('opened'));

      remote.close();
      await new Promise((r) => setTimeout(r, 100));
      assert.deepEqual(lost, []);

      // Already installed: the second start skips the upload.
      statuses.length = 0;
      await writeFile(join(home, '.forge/server/test/notes/hello.txt'), 'kept');
      const again = await startRemote(target('hunter2'), { ...opts, trustedFingerprint: ssh.fingerprint });
      assert.ok(again.ok);
      assert.ok(!statuses.some((s) => s.startsWith('Copying forge')));
      assert.equal(await readFile(join(home, '.forge/server/test/notes/hello.txt'), 'utf8'), 'kept');
      again.value.close();
    } finally {
      ssh.close();
    }
  });
});
