/**
 * Composition root: the only place that knows which adapter backs which port.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { claudeAgentRunner } from '../adapters/claudeAgent.ts';
import { fsArtifactStore, fsEpicStore, fsRepoContext, readConfigFile, readLocalConfigFile } from '../adapters/fs.ts';
import { gitVcs, parseRemote } from '../adapters/git.ts';
import { glabAccess, glabCodeHost, glabRunner, type GlabRun } from '../adapters/glab.ts';
import { gitlabCodeHost, instanceHost, tokenAccess } from '../adapters/gitlab.ts';
import { exec, shellCheckRunner } from '../adapters/process.ts';
import { applyLocal, parseConfig, type Config, type GitlabAuth } from '../application/config.ts';
import type { Deps, RepoDeps, WorkspaceRepoDeps } from '../application/deps.ts';
import { err, ok, type Result } from '../domain/result.ts';
import type { CodeHost, GitlabAccess, Logger } from '../ports/index.ts';

export type Sinks = {
  readonly log: Logger;
  readonly onActivity?: (label: string, text: string, epic: string) => void;
  readonly onStderr?: (line: string) => void;
};

export type Composed = {
  readonly deps: Deps;
  readonly warnings: readonly string[];
  readonly epicsRoot: string;
  /** Checks the workspace's GitLab sign-in on this machine; for the settings screen, never for the use cases. */
  readonly gitlabAccess: () => Promise<GitlabAccess>;
};

type GitlabAdapters = { readonly host: (project: string) => CodeHost; readonly access: () => Promise<GitlabAccess> };

export const findRepoRoot = async (cwd: string): Promise<Result<string, string>> => {
  const r = await exec('git', ['rev-parse', '--show-toplevel'], cwd);
  return r.code === 0 ? ok(r.stdout.trim()) : err('not inside a git repository');
};

const actor = async (root: string): Promise<string> => {
  const r = await exec('git', ['config', 'user.email'], root);
  return r.stdout.trim() || process.env.USER || 'unknown';
};

export const expand = (root: string, path: string): string => {
  const home = path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path;
  return isAbsolute(home) ? home : resolve(root, home);
};

const parseYamlFile = (raw: string | undefined, name: string): Result<unknown, string> => {
  try {
    return ok(raw === undefined ? undefined : parseYaml(raw));
  } catch (e) {
    return err(`${name} is not valid YAML: ${(e as Error).message}`);
  }
};

/**
 * The workspace repo for spec MRs: its GitLab project and base branch come from the config, or else from its
 * git remote. Turned off (with a warning) when the workspace is not a clone with a remote.
 */
const resolveWorkspaceRepo = async (
  root: string,
  epicsRoot: string,
  worktreeBase: string,
  ws: Config['workspace'],
  host: (project: string) => CodeHost,
): Promise<{ readonly deps?: WorkspaceRepoDeps; readonly warning?: string }> => {
  if (!ws.specMergeRequests) return {};
  const off = (why: string) => ({ warning: `Spec MRs are off: ${why} (set workspace.specMergeRequests: false to silence this).` });
  const top = await findRepoRoot(root);
  if (!top.ok) return off('the workspace is not a git repository');
  const epicsPath = relative(top.value, epicsRoot).split(sep).join('/');
  if (!epicsPath || epicsPath.startsWith('..') || isAbsolute(epicsPath)) return off(`the epics folder (${epicsRoot}) is not inside the workspace repo`);
  const url = (await exec('git', ['remote', 'get-url', ws.remote], top.value)).stdout.trim();
  const project = ws.project ?? (url ? parseRemote(url)?.project : undefined);
  if (!project) return off(`no GitLab project for the workspace (no "${ws.remote}" remote; set workspace.project)`);
  const head = ws.baseBranch ? '' : (await exec('git', ['symbolic-ref', '--short', `refs/remotes/${ws.remote}/HEAD`], top.value)).stdout.trim();
  const baseBranch = ws.baseBranch ?? (head ? head.replace(`${ws.remote}/`, '') : 'main');
  return {
    deps: {
      project,
      remote: ws.remote,
      baseBranch,
      epicsPath,
      vcs: gitVcs({ repoRoot: top.value, worktreeRoot: join(worktreeBase, '_workspace'), remote: ws.remote, baseBranch }),
      host: host(project),
    },
  };
};

export type ComposeOptions = {
  /** Claude Code binary for the Agent SDK; only needed when the SDK cannot find its own (packaged desktop app). */
  readonly agentExecutable?: string;
  /** Runs glab for gitlab.auth: glab. Defaults to the glab on PATH. */
  readonly glab?: GlabRun;
};

export const composeDeps = async (root: string, sinks: Sinks, options: ComposeOptions = {}): Promise<Result<Composed, string>> => {
  const raw = await readConfigFile(root);
  if (raw === undefined) return err(`${root} has no .forge/config.yaml. Use "Set up a new workspace…" to create one.`);
  const shared = parseYamlFile(raw, '.forge/config.yaml');
  if (!shared.ok) return shared;
  const local = parseYamlFile(await readLocalConfigFile(root), '.forge/local.yaml');
  if (!local.ok) return local;
  const merged = applyLocal(shared.value, local.value);
  if (!merged.ok) return err(merged.error.join('\n'));
  const parsed = parseConfig(merged.value);
  if (!parsed.ok) return err(`invalid .forge/config.yaml:\n  ${parsed.error.join('\n  ')}`);
  const config = parsed.value;

  const worktreeBase = config.worktreeRoot ? expand(root, config.worktreeRoot) : join(homedir(), '.forge', 'worktrees', basename(root));
  const { baseUrl, tokenEnv } = config.gitlab;
  const token = process.env[tokenEnv];
  const glab = options.glab ?? glabRunner({ withheldEnv: [tokenEnv] });
  const gitlabBy: Readonly<Record<GitlabAuth, GitlabAdapters>> = {
    token: {
      host: (project) => gitlabCodeHost({ baseUrl, project, token }),
      access: async () => tokenAccess({ host: instanceHost(baseUrl), tokenEnv, token }),
    },
    glab: {
      host: (project) => glabCodeHost({ baseUrl, project, run: glab }),
      access: () => glabAccess({ baseUrl, run: glab }),
    },
  };
  const gitlab = gitlabBy[config.gitlab.auth];
  const warnings: string[] = [];
  const repos: Record<string, RepoDeps> = {};
  for (const [name, repo] of Object.entries(config.repos)) {
    const path = expand(root, repo.path);
    if (!existsSync(join(path, '.git')))
      warnings.push(`repo "${name}": no git clone at ${path}. Clone it there, or set repos.${name}.path in .forge/local.yaml.`);
    repos[name] = {
      name,
      root: path,
      config: repo,
      vcs: gitVcs({ repoRoot: path, worktreeRoot: join(worktreeBase, name), remote: repo.remote, baseBranch: repo.baseBranch }),
      host: gitlab.host(repo.project),
    };
  }

  const epicsRoot = expand(root, config.epicsDir);
  const workspaceRepo = await resolveWorkspaceRepo(root, epicsRoot, worktreeBase, config.workspace, gitlab.host);
  if (workspaceRepo.warning) warnings.push(workspaceRepo.warning);
  return ok({
    warnings,
    epicsRoot,
    gitlabAccess: gitlab.access,
    deps: {
      config,
      actor: await actor(root),
      workspaceRoot: root,
      epics: fsEpicStore(epicsRoot),
      artifacts: fsArtifactStore(epicsRoot),
      epicsRoot,
      context: fsRepoContext(root),
      contextFor: (dir, opts) => fsRepoContext(dir, opts),
      repos,
      workspaceRepo: workspaceRepo.deps,
      agent: claudeAgentRunner({
        effort: config.models.effort,
        allowedDomains: config.build.allowedDomains,
        withheldEnv: [config.gitlab.tokenEnv],
        onStderr: sinks.onStderr,
        onActivity: sinks.onActivity,
        executable: options.agentExecutable,
      }),
      checks: shellCheckRunner(),
      clock: () => new Date().toISOString(),
      log: sinks.log,
    },
  });
};
