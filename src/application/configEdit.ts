/**
 * Editing the repos section of .forge/config.yaml (shared, committed) and .forge/local.yaml
 * (this machine only). Pure: text in, text out. Comments and key order in the files are kept.
 */
import { isMap, parse, parseDocument, type Document } from 'yaml';
import { err, ok, type Result } from '../domain/result.ts';
import { applyLocal, parseConfig } from './config.ts';

export type CheckEdit = { readonly name: string; readonly run: string };

export type RepoEdit = {
  readonly name: string;
  /** Path saved in the shared config, relative to the workspace (the team's convention, e.g. ../api). */
  readonly path: string;
  /** Path on this machine only, saved in local.yaml. Empty = use the shared path. */
  readonly localPath: string;
  readonly project: string;
  readonly baseBranch: string;
  readonly remote: string;
  readonly setup: readonly string[];
  readonly checks: readonly CheckEdit[];
  readonly revertCheck: string;
};

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const asStrings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);

/** The repos as the files describe them (shared values plus this machine's path overrides). */
export const readRepoEdits = (configText: string | undefined, localText: string | undefined): readonly RepoEdit[] => {
  const shared = asRecord(asRecord(configText ? parse(configText) : {}).repos);
  const local = asRecord(asRecord(localText ? parse(localText) : {}).repos);
  return Object.entries(shared).map(([name, raw]) => {
    const r = asRecord(raw);
    const checks = (Array.isArray(r.checks) ? r.checks : []).map((c) => ({ name: String(asRecord(c).name ?? ''), run: String(asRecord(c).run ?? '') }));
    return {
      name,
      path: String(r.path ?? ''),
      localPath: String(asRecord(local[name]).path ?? ''),
      project: String(r.project ?? ''),
      baseBranch: String(r.baseBranch ?? 'main'),
      remote: String(r.remote ?? 'origin'),
      setup: asStrings(r.setup),
      checks,
      revertCheck: String(asRecord(r.revertTest).check ?? 'test'),
    };
  });
};

const isEmptyMap = (node: unknown): boolean => isMap(node) && node.items.length === 0;

/** deleteIn throws when a parent is missing; deleting something absent is a no-op here. */
const del = (doc: Document, path: readonly (string | number)[]) => {
  if (doc.hasIn(path)) doc.deleteIn(path);
};

const setOrDelete = (doc: Document, path: readonly (string | number)[], value: unknown, fallback?: unknown) => {
  if (value === undefined || value === fallback) del(doc, path);
  else doc.setIn(path, value);
};

/** Header for a workspace created from the desktop app. */
export const NEW_WORKSPACE_CONFIG = `# Forge workspace. Commit this file. Open this repo in the forge app.
# Repo paths are relative to this repo; set your own in .forge/local.yaml (not committed).
epicsDir: epics

review:
  gate: always   # or risk-based

repos: {}
`;

export type EditedFiles = { readonly config: string; readonly local: string };

const DEFAULT_GITLAB_URL = 'https://gitlab.com';

/** The GitLab instance's URL (gitlab.baseUrl) as the shared config sets it, else forge's default. */
export const readGitlabBaseUrl = (configText: string | undefined): string => {
  const url = asRecord(asRecord(configText ? parse(configText) : {}).gitlab).baseUrl;
  return typeof url === 'string' && url.trim() ? url.trim() : DEFAULT_GITLAB_URL;
};

/**
 * Applies the full list of repos (adds, edits, removals) to both files and validates the result the
 * same way forge does on startup. Nothing is returned unless the merged config is valid.
 * With `gitlabBaseUrl`, also sets the GitLab instance (left out of the file when it's the default).
 */
export const applyRepoEdits = (
  configText: string | undefined,
  localText: string | undefined,
  edits: readonly RepoEdit[],
  gitlabBaseUrl?: string,
): Result<EditedFiles, readonly string[]> => {
  const names = edits.map((e) => e.name);
  const dupes = names.filter((n, i) => names.indexOf(n) !== i);
  if (dupes.length) return err([`repo names must be unique: ${[...new Set(dupes)].join(', ')}`]);
  if (edits.length === 0) return err(['configure at least one repo']);

  const config = parseDocument(configText ?? NEW_WORKSPACE_CONFIG);
  const local = parseDocument(localText ?? '');
  if (config.errors.length) return err([`.forge/config.yaml: ${config.errors[0]!.message}`]);
  if (local.errors.length) return err([`.forge/local.yaml: ${local.errors[0]!.message}`]);

  // Removals first, in both files.
  const existing = isMap(config.getIn(['repos'])) ? Object.keys(asRecord(asRecord(config.toJS()).repos)) : [];
  if (!isMap(config.getIn(['repos']))) config.setIn(['repos'], config.createNode({}));
  for (const gone of existing.filter((n) => !names.includes(n))) {
    del(config, ['repos', gone]);
    del(local, ['repos', gone]);
  }

  for (const e of edits) {
    const at = (key: string) => ['repos', e.name, key];
    if (!isMap(config.getIn(['repos', e.name]))) config.setIn(['repos', e.name], config.createNode({}));
    config.setIn(at('path'), e.path.trim());
    config.setIn(at('project'), e.project.trim());
    setOrDelete(config, at('baseBranch'), e.baseBranch.trim() || undefined, 'main');
    setOrDelete(config, at('remote'), e.remote.trim() || undefined, 'origin');
    const setup = e.setup.map((s) => s.trim()).filter(Boolean);
    if (setup.length) config.setIn(at('setup'), config.createNode(setup, { flow: true }));
    else del(config, at('setup'));
    config.setIn(
      at('checks'),
      config.createNode(e.checks.map((c) => ({ name: c.name.trim(), run: c.run.trim() })).filter((c) => c.name || c.run)),
    );
    setOrDelete(config, [...at('revertTest'), 'check'], e.revertCheck.trim() || undefined, 'test');
    if (isEmptyMap(config.getIn(at('revertTest')))) del(config, at('revertTest'));

    if (e.localPath.trim()) local.setIn(['repos', e.name, 'path'], e.localPath.trim());
    else del(local, ['repos', e.name]);
  }
  if (isEmptyMap(local.getIn(['repos']))) del(local, ['repos']);

  if (gitlabBaseUrl !== undefined) {
    const url = gitlabBaseUrl.trim().replace(/\/+$/, '');
    if (url && !/^https?:\/\//i.test(url)) return err([`GitLab URL must start with https:// or http:// (got "${url}")`]);
    setOrDelete(config, ['gitlab', 'baseUrl'], url || undefined, DEFAULT_GITLAB_URL);
    if (isEmptyMap(config.getIn(['gitlab']))) del(config, ['gitlab']);
  }

  const configOut = config.toString();
  const localJs = local.toJS();
  const localOut = localJs && Object.keys(asRecord(localJs)).length ? local.toString() : '';

  const merged = applyLocal(parse(configOut), localOut ? parse(localOut) : undefined);
  if (!merged.ok) return merged;
  const valid = parseConfig(merged.value);
  return valid.ok ? ok({ config: configOut, local: localOut }) : err(valid.error);
};
