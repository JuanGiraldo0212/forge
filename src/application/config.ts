import { z } from 'zod';
import { err, ok, type Result } from '../domain/result.ts';

export const GITLAB_AUTH_MODES = ['token', 'glab'] as const;

/** How forge authenticates GitLab API calls. */
export type GitlabAuth = (typeof GITLAB_AUTH_MODES)[number];

const CheckSchema = z.object({ name: z.string().min(1), run: z.string().min(1) });

const RepoSchema = z
  .object({
    /** Path to the clone, relative to the workspace root. Override per developer in .forge/local.yaml. */
    path: z.string().min(1),
    /** GitLab project: numeric id or "group/subgroup/project". */
    project: z.string().min(1),
    baseBranch: z.string().default('main'),
    remote: z.string().default('origin'),
    /** Run once in a fresh worktree, before the agent starts (e.g. "npm ci"). */
    setup: z.array(z.string()).default([]),
    /** Must all pass before a change counts as implemented. Same commands CI runs. */
    checks: z.array(CheckSchema).min(1, 'configure at least one check (e.g. tests)'),
    revertTest: z
      .object({
        /** Name of the check to re-run with the source change reverted. It must fail. */
        check: z.string().default('test'),
        testGlobs: z
          .array(z.string())
          .default(['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**']),
      })
      .prefault({}),
  })
  .refine((r) => r.checks.some((c) => c.name === r.revertTest.check), {
    message: 'revertTest.check must name one of this repo\'s checks',
    path: ['revertTest', 'check'],
  });

export type RepoConfig = z.infer<typeof RepoSchema>;

export const ConfigSchema = z.object({
  /** Where epics live, relative to the workspace root. Commit it so the team sees every epic. */
  epicsDir: z.string().default('epics'),
  branchPrefix: z.string().default('forge'),
  /** Where change worktrees live. Kept outside the repos so repo-wide tools never scan them. */
  worktreeRoot: z.string().optional(),
  models: z
    .object({
      author: z.string().default('claude-opus-5-5'),
      reviewer: z.string().default('claude-opus-5-5'),
      effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']).default('high'),
    })
    .prefault({}),
  loop: z
    .object({
      maxRounds: z.number().int().positive().default(20),
      maxIdenticalFailures: z.number().int().positive().default(3),
      maxTurnsPerRound: z.number().int().positive().default(80),
    })
    .prefault({}),
  changes: z.object({ maxFilesPerChange: z.number().int().positive().default(8) }).prefault({}),
  /** Planning agents may pause to ask the epic's owner questions as they go. */
  questions: z
    .object({
      /** The requirements agent asks about the product: scope, behavior, priorities. */
      requirements: z.boolean().default(true),
      /** The epic spec agent asks technical decisions: contracts, patterns, how to slice the work. */
      spec: z.boolean().default(true),
      /** After this many rounds of questions in a stage the agent must finish with what it has. */
      maxRounds: z.number().int().min(0).default(4),
      maxPerRound: z.number().int().min(1).max(10).default(3),
    })
    .prefault({}),
  build: z
    .object({
      maxParallel: z.number().int().positive().default(3),
      /** Hosts the build sandbox may reach (package registries, etc.). */
      allowedDomains: z.array(z.string()).default([]),
    })
    .prefault({}),
  review: z
    .object({
      gate: z.enum(['always', 'risk-based']).default('always'),
      /** Post the automated review's findings on the MR as comments, inline on the diff where possible. */
      postToMergeRequest: z.boolean().default(true),
    })
    .prefault({}),
  gitlab: z
    .object({
      baseUrl: z.string().url().default('https://gitlab.com'),
      /** Name of the env var holding the token. The token never reaches agents. */
      tokenEnv: z.string().default('GITLAB_TOKEN'),
      /**
       * How forge signs its GitLab API calls (opening and reading MRs): a token from tokenEnv, or the GitLab
       * CLI (glab) login of the machine forge runs on. Overridable per developer in .forge/local.yaml.
       */
      auth: z.enum(GITLAB_AUTH_MODES).default('token'),
    })
    .prefault({}),
  /** The workspace (planning) repo itself: where the epics are committed and their specs are reviewed. */
  workspace: z
    .object({
      /**
       * Open an MR on the workspace repo with the epic spec, and another with the change specs, each time an
       * agent writes them (a revision adds a commit to the open MR). Uses the same GitLab sign-in as code MRs.
       */
      specMergeRequests: z.boolean().default(true),
      /** GitLab project of the workspace repo. Detected from the git remote when left out. */
      project: z.string().min(1).optional(),
      /** Branch the spec MRs target. Detected from the remote's HEAD when left out, else "main". */
      baseBranch: z.string().min(1).optional(),
      remote: z.string().default('origin'),
    })
    .prefault({}),
  /** Code repos an epic can change. Each change spec names exactly one. */
  repos: z
    .record(z.string().regex(/^[a-z0-9][a-z0-9_-]*$/, 'repo names are lowercase, digits, "-" or "_"'), RepoSchema)
    .refine((r) => Object.keys(r).length > 0, 'configure at least one repo'),
});

export type Config = z.infer<typeof ConfigSchema>;

const LocalSchema = z.object({
  worktreeRoot: z.string().optional(),
  repos: z.record(z.string(), z.object({ path: z.string() })).optional(),
  gitlab: z.object({ auth: z.enum(GITLAB_AUTH_MODES).optional() }).optional(),
});

/**
 * Applies a developer's .forge/local.yaml (not committed) over the shared config.
 * Only machine-specific values are overridable: repo paths, the worktree root and how forge signs in to GitLab.
 */
export const applyLocal = (shared: unknown, local: unknown): Result<unknown, readonly string[]> => {
  if (local === undefined || local === null) return ok(shared);
  const parsed = LocalSchema.safeParse(local);
  if (!parsed.success) return err(parsed.error.issues.map((i) => `local.yaml ${i.path.join('.')}: ${i.message}`));
  const base = (shared ?? {}) as { repos?: Record<string, Record<string, unknown>>; worktreeRoot?: string; gitlab?: Record<string, unknown> };
  const unknown = Object.keys(parsed.data.repos ?? {}).filter((name) => !base.repos?.[name]);
  if (unknown.length) return err([`local.yaml overrides unknown repos: ${unknown.join(', ')}`]);
  const repos = Object.fromEntries(
    Object.entries(base.repos ?? {}).map(([name, repo]) => [name, { ...repo, ...parsed.data.repos?.[name] }]),
  );
  const auth = parsed.data.gitlab?.auth;
  return ok({ ...base, repos, worktreeRoot: parsed.data.worktreeRoot ?? base.worktreeRoot, ...(auth ? { gitlab: { ...base.gitlab, auth } } : {}) });
};

export const parseConfig = (raw: unknown): Result<Config, readonly string[]> => {
  const parsed = ConfigSchema.safeParse(raw);
  return parsed.success
    ? ok(parsed.data)
    : err(parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`));
};
