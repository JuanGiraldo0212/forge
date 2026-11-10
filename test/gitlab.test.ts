/**
 * The GitLab adapter against a scripted fetch: how review comments land on an MR.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { gitlabCodeHost } from '../src/adapters/gitlab.ts';

type Call = { method: string; path: string; body?: any };

const HEAD = 'h'.repeat(40);
const REFS = { base_sha: 'b'.repeat(40), start_sha: 's'.repeat(40), head_sha: HEAD };

/** A GitLab project whose MR !7 gets its diff after `diffReadyAfter` reads, and refuses inline comments on `badLines`. */
const fakeApi = (opts: { diffReadyAfter?: number; badLines?: number[] } = {}) => {
  const calls: Call[] = [];
  let reads = 0;
  const fetch = (async (url: string, init: RequestInit) => {
    const path = url.replace('https://gitlab.example/api/v4/projects/group%2Fapp', '');
    const body = init.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method: init.method!, path, body });
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status });
    if (init.method === 'GET' && path === '/merge_requests/7') {
      reads++;
      const ready = reads > (opts.diffReadyAfter ?? 0);
      return json(200, { iid: 7, web_url: 'u', diff_refs: ready ? REFS : { ...REFS, head_sha: 'old' } });
    }
    if (path === '/merge_requests/7/discussions')
      return opts.badLines?.includes(body.position.new_line) ? json(400, { message: 'line_code can not be blank' }) : json(201, {});
    if (path === '/merge_requests/7/notes') return json(201, {});
    return json(404, {});
  }) as typeof globalThis.fetch;
  const host = gitlabCodeHost({ baseUrl: 'https://gitlab.example', project: 'group/app', token: 't', fetch, diffWait: { attempts: 3, delayMs: 0 } });
  return { host, calls };
};

describe('gitlab review comments', () => {
  it('waits for the pushed commit\'s diff, then comments inline, falling back to a note off the diff', async () => {
    const { host, calls } = fakeApi({ diffReadyAfter: 1, badLines: [99] });
    const posted = await host.commentOnMergeRequest(7, HEAD, [
      { body: 'on the diff', file: 'src/a.ts', line: 3 },
      { body: 'off the diff', file: 'src/a.ts', line: 99 },
      { body: 'no location' },
    ]);
    assert.deepEqual(posted, { inline: 1, general: 2, failed: [] });
    assert.equal(calls.filter((c) => c.method === 'GET').length, 2, 'read the MR until its diff matched the pushed commit');
    const inline = calls.find((c) => c.path.endsWith('/discussions'))!;
    assert.deepEqual(inline.body, {
      body: 'on the diff',
      position: { position_type: 'text', ...REFS, old_path: 'src/a.ts', new_path: 'src/a.ts', new_line: 3 },
    });
    const notes = calls.filter((c) => c.path.endsWith('/notes')).map((c) => c.body.body);
    assert.deepEqual(notes, ['`src/a.ts:99`\n\noff the diff', 'no location']);
  });

  it('posts everything as notes when the diff never catches up', async () => {
    const { host, calls } = fakeApi({ diffReadyAfter: 10 });
    const posted = await host.commentOnMergeRequest(7, HEAD, [{ body: 'x', file: 'src/a.ts', line: 3 }]);
    assert.deepEqual(posted, { inline: 0, general: 1, failed: [] });
    assert.equal(calls.filter((c) => c.path.endsWith('/discussions')).length, 0);
    assert.equal(calls.find((c) => c.path.endsWith('/notes'))!.body.body, '`src/a.ts:3`\n\nx');
  });

  it('does not read the MR when no comment points at a line', async () => {
    const { host, calls } = fakeApi();
    assert.deepEqual(await host.commentOnMergeRequest(7, HEAD, [{ body: 'x' }]), { inline: 0, general: 1, failed: [] });
    assert.equal(calls.filter((c) => c.method === 'GET').length, 0);
  });

  it('reports comments it could not post instead of failing', async () => {
    const host = gitlabCodeHost({ baseUrl: 'https://gitlab.example', project: 'group/app', token: undefined });
    const posted = await host.commentOnMergeRequest(7, HEAD, [{ body: 'x' }]);
    assert.equal(posted.general, 0);
    assert.match(posted.failed[0]!, /token is not set/);
  });
});
