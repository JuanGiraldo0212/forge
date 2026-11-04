/**
 * Command-line driver. With no command in a terminal it opens the TUI.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { syncMergeRequests } from '../application/build.ts';
import { approveAllDrafts, approveChange, changeIssues, dropChange, reviseChange, revisePlan, runChanges } from '../application/changes.ts';
import { SINGLE_REPO_CONFIG_YAML, WORKSPACE_CONFIG_YAML } from '../application/config.ts';
import { loadEpic, type Deps } from '../application/deps.ts';
import { changeText, logText, statusText } from '../application/render.ts';
import {
  abandon,
  approveStage,
  assignOwner,
  createEpic,
  gateIssues,
  IDEA_FILE,
  reviseStage,
  runGatedStage,
  runnable,
  sendBack,
} from '../application/stages.ts';
import { ARTIFACT_FILE, changeFile, STAGE_LABEL } from '../domain/epic.ts';
import type { Result } from '../domain/result.ts';
import { composeDeps, findRepoRoot } from './compose.ts';
import { initWorkspaceFiles } from './init.ts';

const USAGE = `forge — epic to merge requests, with a human gate at every step

  forge                                       open the TUI (same as "forge tui")
  forge desktop                               open the desktop app on this workspace
  forge init [--workspace]                    set up forge in a code repo, or in a planning repo for several repos
  forge new "<title>" [-m <idea> | --file <path>] [--owner <email>]
  forge list [--mine]
  forge status <epic>
  forge show <epic> [--change <id>]           print the current document, or one change spec and its review
  forge run <epic> [--force]                  run the current stage; in change specs: draft, redraft, build
  forge approve <epic> [--change <id>] [-m <note>]   gate, one change (spec or code), or all draft change specs
  forge revise <epic> -m <feedback> [--change <id>]  stage, plan-level, one change spec, or one change's code
  forge drop <epic> <change> -m <why>
  forge back <epic> <explore|spec> -m <why>
  forge assign <epic> <owner>
  forge sync <epic>                           pull MR state from GitLab
  forge log <epic>                            audit trail
  forge abandon <epic> -m <why>

Lifecycle: explore -> [approve] -> epic spec -> [approve] -> change specs, each: draft -> [approve] -> build
           (agent ⇄ checks -> revert test -> review) -> [approve] -> MR -> merge in GitLab`;

const out = (s: string) => process.stdout.write(`${s}\n`);
const fail = (message: string, code = 1): never => {
  process.stderr.write(`forge: ${message}\n`);
  process.exit(code);
};
const unwrap = <T>(r: Result<T, { readonly message: string }>): T => (r.ok ? r.value : fail(r.error.message));
const unwrapString = <T>(r: Result<T, string>): T => (r.ok ? r.value : fail(r.error));

const buildDeps = async (root: string): Promise<Deps> => {
  const composed = unwrapString(
    await composeDeps(root, {
      log: { info: (m) => process.stderr.write(`${m}\n`), warn: (m) => process.stderr.write(`warning: ${m}\n`) },
      onActivity: process.env.FORGE_DEBUG ? (label, text) => process.stderr.write(`  [${label}] ${text}\n`) : undefined,
      onStderr: process.env.FORGE_DEBUG ? (l) => process.stderr.write(l) : undefined,
    }),
  );
  composed.warnings.forEach((w) => process.stderr.write(`warning: ${w}\n`));
  return composed.deps;
};

const init = async (root: string, workspace: boolean) => {
  const wrote = await initWorkspaceFiles(root, workspace ? WORKSPACE_CONFIG_YAML : SINGLE_REPO_CONFIG_YAML);
  out(wrote.length ? `Created or updated ${wrote.join(', ')}.` : 'Already initialised.');
  out(
    workspace
      ? 'Edit .forge/config.yaml (repos: path, project, checks), or use the desktop app (Repositories). Clone the code repos at those paths, or set your own in .forge/local.yaml. Fill in AGENTS.md. Commit, then: forge'
      : 'Edit .forge/config.yaml (project, checks), fill in AGENTS.md, then: forge',
  );
};

/**
 * Recent Ubuntu blocks the unprivileged user namespaces Chromium's sandbox needs, and the fallback
 * setuid helper is not root-owned after npm installs it. Electron then aborts with SIGTRAP.
 * Detect that up front and say how to fix it. Never fall back to --no-sandbox.
 */
const linuxSandboxProblem = (electron: string): string | undefined => {
  if (process.platform !== 'linux') return undefined;
  const read = (path: string) => {
    try {
      return readFileSync(path, 'utf8').trim();
    } catch {
      return undefined;
    }
  };
  if (read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns') !== '1') return undefined;
  const helper = join(dirname(electron), 'chrome-sandbox');
  const st = existsSync(helper) ? statSync(helper) : undefined;
  if (st && st.uid === 0 && (st.mode & 0o4000) !== 0) return undefined;
  // A profile file is world-readable even when the loaded-profiles list is not.
  const allowed = read('/etc/apparmor.d/forge-electron')?.includes(electron) ?? false;
  if (allowed) return undefined;
  return `Electron's sandbox can't start: this system restricts unprivileged user namespaces (AppArmor), and ${helper} is not setuid root.
Fix it once with an AppArmor profile (recommended):

  sudo tee /etc/apparmor.d/forge-electron >/dev/null <<'EOF'
  abi <abi/4.0>,
  include <tunables/global>
  profile forge-electron ${electron} flags=(unconfined) {
    userns,
    include if exists <local/forge-electron>
  }
  EOF
  sudo apparmor_parser -r /etc/apparmor.d/forge-electron

or make the helper setuid root (undone by the next npm install):

  sudo chown root:root ${helper} && sudo chmod 4755 ${helper}`;
};

/** Starts the Electron app from this checkout of forge, on the current workspace. */
const launchDesktop = (root: string) => {
  const forgeRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  if (!existsSync(join(forgeRoot, 'out', 'main', 'index.js')))
    return fail(`the desktop app is not built. Run "npm run desktop:build" in ${forgeRoot}.`);
  const electron = createRequire(import.meta.url)('electron') as unknown as string;
  const problem = linuxSandboxProblem(electron);
  if (problem) return fail(problem);
  const child = spawn(electron, [forgeRoot], { cwd: root, env: { ...process.env, FORGE_WORKSPACE: root }, detached: true, stdio: 'ignore' });
  child.unref();
  out(`Opening forge desktop on ${root}`);
};

const main = async () => {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      message: { type: 'string', short: 'm' },
      file: { type: 'string' },
      change: { type: 'string', short: 'c' },
      owner: { type: 'string' },
      mine: { type: 'boolean' },
      force: { type: 'boolean' },
      workspace: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, slug, extra] = positionals;
  if (values.help) return out(USAGE);
  if (!command && !process.stdout.isTTY) return out(USAGE);

  const root = unwrapString(await findRepoRoot(process.cwd()));
  if (command === 'init') return init(root, Boolean(values.workspace));
  if (command === 'desktop') return launchDesktop(root);
  if (!command || command === 'tui') {
    const { startTui } = await import('../tui/start.tsx');
    return startTui(root);
  }

  const deps = await buildDeps(root);
  const need = (v: string | undefined, what: string): string => v ?? fail(`missing ${what}\n\n${USAGE}`, 2);
  const epicOf = async (s: string) => unwrap(await loadEpic(deps, s));

  switch (command) {
    case 'new': {
      const title = need(slug, '<title>');
      const idea = values.file ? await readFile(values.file, 'utf8') : (values.message ?? title);
      const created = unwrap(await createEpic(deps, title, idea, values.owner ?? deps.actor));
      return out(`Created "${created}". Edit ${deps.artifacts.pathOf(created, IDEA_FILE)} if needed, then: forge run ${created}`);
    }
    case 'list': {
      for (const s of await deps.epics.list()) {
        const e = await loadEpic(deps, s);
        if (!e.ok || (values.mine && e.value.owner !== deps.actor)) continue;
        const waiting = e.value.changes.filter((c) => c.status === 'draft' || c.status === 'awaiting_review').length;
        out(`${s.padEnd(36)} ${STAGE_LABEL[e.value.stage].padEnd(13)} ${e.value.owner.padEnd(28)} ${waiting ? `${waiting} to review` : ''}`);
      }
      return;
    }
    case 'status':
      return out(statusText(await epicOf(need(slug, '<epic>'))));
    case 'show': {
      const e = await epicOf(need(slug, '<epic>'));
      if (values.change) {
        const c = e.changes.find((x) => x.id === values.change) ?? fail(`no change ${values.change}`);
        out(`${changeText(c)}\n\n# ${deps.artifacts.pathOf(e.slug, changeFile(c.id))}\n`);
        out(c.spec?.markdown ?? (await deps.artifacts.read(e.slug, changeFile(c.id))) ?? '(no file)');
        const issues = c.status === 'draft' ? await changeIssues(deps, e, c.id) : [];
        return issues.length ? out(`\nCannot approve yet:\n${issues.map((i) => `  - ${i}`).join('\n')}`) : undefined;
      }
      if (e.stage === 'explore' || e.stage === 'spec') {
        const path = deps.artifacts.pathOf(e.slug, ARTIFACT_FILE[e.stage]);
        out(`# ${path}\n`);
        out((await deps.artifacts.read(e.slug, ARTIFACT_FILE[e.stage])) ?? '(not produced yet)');
        const issues = await gateIssues(deps, e.slug, e.stage);
        return issues.length ? out(`\nGate issues:\n${issues.map((i) => `  - ${i}`).join('\n')}`) : undefined;
      }
      return out(statusText(e));
    }
    case 'run': {
      const { epic, stage } = unwrap(await runnable(deps, need(slug, '<epic>'), Boolean(values.force)));
      if (stage === 'changes') {
        const r = unwrap(await runChanges(deps, epic, Boolean(values.force)));
        if (r.drafted.length) out(`Drafted change specs: ${r.drafted.join(', ')}`);
        if (r.revised.length) out(`Redrafted: ${r.revised.join(', ')}`);
        r.errors.forEach((e) => out(`error: ${e}`));
        r.build.outcomes.forEach((o) => out(`${o.changeId}: ${o.result} — ${o.detail}`));
        if (r.build.idle) out(r.build.idle);
      } else {
        const run = unwrap(await runGatedStage(deps, epic, stage));
        out(`${STAGE_LABEL[run.stage]} ready for review: ${run.artifact}`);
        if (run.issues.length) out(`Gate issues (fix before approving):\n${run.issues.map((i) => `  - ${i}`).join('\n')}`);
      }
      return out(`\n${statusText(await epicOf(epic.slug))}`);
    }
    case 'approve': {
      const s = need(slug, '<epic>');
      if (values.change) {
        const r = unwrap(await approveChange(deps, s, values.change, values.message));
        return out(r.kind === 'spec' ? `Approved change spec ${r.changeId}. It builds on the next "forge run ${s}".` : `${r.outcome.changeId}: ${r.outcome.result} — ${r.outcome.detail}`);
      }
      const e = await epicOf(s);
      if (e.stage === 'changes') {
        const r = unwrap(await approveAllDrafts(deps, s, values.message));
        if (r.approved.length) out(`Approved change specs: ${r.approved.join(', ')}`);
        r.blocked.forEach((b) => out(b));
        return;
      }
      return out(`Approved ${STAGE_LABEL[unwrap(await approveStage(deps, s, values.message))]}. Next: forge run ${s}`);
    }
    case 'revise': {
      const s = need(slug, '<epic>');
      const note = need(values.message, '-m <feedback>');
      if (values.change) {
        const kind = unwrap(await reviseChange(deps, s, values.change, note));
        return out(`${values.change}: the ${kind === 'spec' ? 'change spec will be redrafted' : 'code will be reworked'} on the next "forge run ${s}".`);
      }
      const e = await epicOf(s);
      if (e.stage === 'changes') {
        unwrap(await revisePlan(deps, s, note));
        return out(`Unapproved change specs will be redrafted on the next "forge run ${s}".`);
      }
      return out(`${STAGE_LABEL[unwrap(await reviseStage(deps, s, note))]} will be regenerated on the next "forge run ${s}".`);
    }
    case 'drop':
      unwrap(await dropChange(deps, need(slug, '<epic>'), need(extra, '<change>'), need(values.message, '-m <why>')));
      return out(`Dropped ${extra}.`);
    case 'back':
      return out(`Back to ${STAGE_LABEL[unwrap(await sendBack(deps, need(slug, '<epic>'), need(extra, '<stage>'), need(values.message, '-m <why>')))]}.`);
    case 'assign':
      return out(`Owner is now ${unwrap(await assignOwner(deps, need(slug, '<epic>'), need(extra, '<owner>')))}.`);
    case 'sync': {
      const rows = unwrap(await syncMergeRequests(deps, need(slug, '<epic>')));
      rows.forEach((r) => out('error' in r ? `${r.changeId} [${r.repo}]: ${r.error}` : `${r.changeId} [${r.repo}]: ${r.state}${r.pipeline ? ` (pipeline ${r.pipeline})` : ''} ${r.url}`));
      return out(rows.length ? '' : 'No open MRs.');
    }
    case 'log':
      return out(logText(await deps.epics.load(need(slug, '<epic>'))));
    case 'abandon':
      unwrap(await abandon(deps, need(slug, '<epic>'), need(values.message, '-m <why>')));
      return out('Abandoned.');
    default:
      return fail(`unknown command "${command}"\n\n${USAGE}`, 2);
  }
};

main().catch((e) => fail((e as Error).stack ?? String(e)));
