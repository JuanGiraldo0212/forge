/**
 * GitLab REST adapter (v4). Needs a token with `api` scope in the env var named by config.gitlab.tokenEnv.
 */
import { err, ok, type Result } from '../domain/result.ts';
import type { CodeHost, MergeRequestComment, MergeRequestState, PortError } from '../ports/index.ts';

type Fetch = typeof fetch;

const fail = (message: string): Result<never, PortError> => err({ port: 'gitlab', message });

type DiffRefs = { readonly base_sha: string; readonly start_sha: string; readonly head_sha: string };

const location = (c: MergeRequestComment): string => (c.file ? `\`${c.file}${c.line ? `:${c.line}` : ''}\`\n\n` : '');

export const gitlabCodeHost = (opts: {
  readonly baseUrl: string;
  readonly project: string;
  readonly token: string | undefined;
  readonly fetch?: Fetch;
  /** GitLab computes an MR's diff asynchronously after a push; how long to wait for it. */
  readonly diffWait?: { readonly attempts: number; readonly delayMs: number };
}): CodeHost => {
  const doFetch = opts.fetch ?? fetch;
  const diffWait = opts.diffWait ?? { attempts: 10, delayMs: 1000 };
  const api = `${opts.baseUrl.replace(/\/$/, '')}/api/v4/projects/${encodeURIComponent(opts.project)}`;

  const request = async (method: string, path: string, body?: unknown): Promise<Result<any, PortError>> => {
    if (!opts.token) return fail('GitLab token is not set (see gitlab.tokenEnv in .forge/config.yaml)');
    try {
      const res = await doFetch(`${api}${path}`, {
        method,
        headers: { 'PRIVATE-TOKEN': opts.token, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await res.text();
      if (!res.ok) return fail(`${method} ${path} -> ${res.status}: ${text.slice(0, 500)}`);
      return ok(text ? JSON.parse(text) : undefined);
    } catch (e) {
      return fail(`${method} ${path}: ${(e as Error).message}`);
    }
  };

  return {
    openMergeRequest: async (mr) => {
      const r = await request('POST', '/merge_requests', {
        source_branch: mr.sourceBranch,
        target_branch: mr.targetBranch,
        title: mr.title,
        description: mr.description,
        remove_source_branch: true,
        squash: true,
      });
      return r.ok ? ok({ iid: Number(r.value.iid), url: String(r.value.web_url) }) : r;
    },

    getMergeRequest: async (iid) => {
      const r = await request('GET', `/merge_requests/${iid}`);
      if (!r.ok) return r;
      const state: MergeRequestState = {
        state: r.value.state,
        pipeline: r.value.head_pipeline?.status ?? undefined,
        url: r.value.web_url,
      };
      return ok(state);
    },

    commentOnMergeRequest: async (iid, headSha, comments) => {
      // Inline comments need the diff of the pushed commit; until GitLab has it, they go in as general notes.
      const diffRefs = async (): Promise<DiffRefs | undefined> => {
        for (let i = 0; i < diffWait.attempts; i++) {
          const r = await request('GET', `/merge_requests/${iid}`);
          const refs = r.ok ? (r.value.diff_refs as DiffRefs | null | undefined) : undefined;
          if (refs?.head_sha === headSha) return refs;
          if (i < diffWait.attempts - 1) await new Promise((res) => setTimeout(res, diffWait.delayMs));
        }
        return undefined;
      };
      const refs = comments.some((c) => c.file && c.line) ? await diffRefs() : undefined;

      let inline = 0;
      let general = 0;
      const failed: string[] = [];
      for (const c of comments) {
        if (refs && c.file && c.line) {
          const r = await request('POST', `/merge_requests/${iid}/discussions`, {
            body: c.body,
            position: { position_type: 'text', ...refs, old_path: c.file, new_path: c.file, new_line: c.line },
          });
          if (r.ok) {
            inline++;
            continue;
          }
          // Usually the line is not part of the diff. The comment still belongs on the MR.
        }
        const r = await request('POST', `/merge_requests/${iid}/notes`, { body: `${location(c)}${c.body}` });
        if (r.ok) general++;
        else failed.push(r.error.message);
      }
      return { inline, general, failed };
    },
  };
};
