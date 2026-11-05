/**
 * Composition root: the only place that knows which adapter backs which port.
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { claudeAgentRunner } from '../adapters/claudeAgent.ts';
import { fsArtifactStore, fsEpicStore, fsRepoContext, readConfigFile, readLocalConfigFile } from '../adapters/fs.ts';
import { gitVcs } from '../adapters/git.ts';
import { gitlabCodeHost } from '../adapters/gitlab.ts';
import { exec, shellCheckRunner } from '../adapters/process.ts';
import { applyLocal, parseConfig } from '../application/config.ts';
import type { Deps, RepoDeps } from '../application/deps.ts';
import { err, ok, type Result } from '../domain/result.ts';
import type { Logger } from '../ports/index.ts';

export type Sinks = {
  readonly log: Logger;
  readonly onActivity?: (label: string, text: string, epic: string) => void;
  readonly onStderr?: (line: string) => void;
};

export type Composed = { readonly deps: Deps; readonly warnings: readonly string[]; readonly epicsRoot: string };

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

export type ComposeOptions = {
  /** Claude Code binary for the Agent SDK; only needed when the SDK cannot find its own (packaged desktop app). */
  readonly agentExecutable?: string;
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
  const token = process.env[config.gitlab.tokenEnv];
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
      host: gitlabCodeHost({ baseUrl: config.gitlab.baseUrl, project: repo.project, token }),
    };
  }

  const epicsRoot = expand(root, config.epicsDir);
  return ok({
    warnings,
    epicsRoot,
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
