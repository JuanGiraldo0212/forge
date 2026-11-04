/**
 * GitLab REST adapter (v4). Needs a token with `api` scope in the env var named by config.gitlab.tokenEnv.
 */
import { err, ok, type Result } from '../domain/result.ts';
import type { CodeHost, MergeRequestState, PortError } from '../ports/index.ts';

type Fetch = typeof fetch;

const fail = (message: string): Result<never, PortError> => err({ port: 'gitlab', message });

export const gitlabCodeHost = (opts: {
  readonly baseUrl: string;
  readonly project: string;
  readonly token: string | undefined;
  readonly fetch?: Fetch;
}): CodeHost => {
  const doFetch = opts.fetch ?? fetch;
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
  };
};
