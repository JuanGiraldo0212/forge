# forge

An opinionated harness that takes an **epic** from idea to merged merge requests, across one or
more repos. Agents (Claude Agent SDK) do the work. A deterministic state machine, not the LLM,
decides when work moves on, and the epic's owner approves every step.

Based on the practices in Microsoft's
[Copilot Cowork write-up](https://commandline.microsoft.com/how-we-built-copilot-cowork-python-to-rust-migration/):
no code without a spec, one narrow change per agent, rules kept in the repo, checks that must be
able to fail, independent review, and humans deciding what merges.

## The flow

```
idea ─► requirements ─[approve]─► epic spec (RFC) ─[approve]─► change specs
                                                      │  one per merge request, each in exactly one repo
                                                      ▼
              each change:  draft ─[approve]─► build ──────────────────────────────[approve]─► MR ─► merge
                                               agent ⇄ repo checks (≤20 rounds / 3 identical failures)
                                               → commit → revert test → review agent
```

- **Epic**: has an **owner** (whoever creates it; `forge assign` changes it). The owner drives it through
  the gates.
- **Requirements** (`requirements.md`): what the idea requires, not how to build it. The agent reads the
  repos only to learn how the product behaves today. Functional and non-functional requirements are
  numbered **R1, R2…**, each with acceptance criteria. It can't be approved without Problem, Functional
  requirements and Out of scope, or while an open question has an empty `Answer:` line: product
  questions are settled here, not left to the epic spec. Fill in the answers, or request a revision.
- **Epic spec** (`epic-spec.md`): an RFC whose main job is to **slice the epic into changes**. It goes only as
  deep into the code as slicing and the contracts between repos need, and leaves each change's internals
  (files, signatures, tests) to its change spec: Summary, Approach, Alternatives
  considered, **Changes**, Verification, Must not break and Risk. Each planned change is a `### C1: Title`
  subsection naming its repo, its dependencies and the requirements it delivers. It can't be approved
  while a requirement is left uncovered, a change names an unknown repo or requirement, or the
  dependencies are unknown or form a cycle.
- **Change specs** (`changes/C1.md`, …): one per MR, drafted from the epic spec's planned changes (same
  ids, repos and dependencies) and carrying the low-level detail: files, precise behavior, tests. Each
  names its repo, files, dependencies and risk, with Goal, Behavior, Verification and Must not break.
  An agent drafts the set; you edit,
  approve, redraft or drop **each one separately**. Approved changes start building while you're
  still working on others.
- **Dependencies** can cross repos. For example, the API change merges first, then the web change
  that uses it builds.
- **Approval freezes a change spec.** Forge builds from a snapshot taken when you approved it, so
  later edits to the file don't silently change what gets built.

At every step you can do one of the following:
- **Approve.** Your optional note is passed to later agents.
- **Revise with feedback.** It's regenerated to address the feedback. Feedback on a draft redrafts its
  spec, feedback on code reworks the code, and feedback on the whole change set redrafts every
  unapproved change.
- **Send back** to the requirements or the epic spec.
- **Drop** a single change.

## Questions while planning

The requirements and epic spec agents don't save their questions for the end. When an answer would
change where they look or what they write, they ask the epic's owner mid-run (`ask_human`, up to 3
questions per round, each with why it matters and suggested answers) and the run **pauses** with its
session saved. The requirements agent asks about the product (scope, behavior, priorities); the epic
spec agent asks technical decisions (contracts, patterns, how to slice). Answer whenever you like:
forge resumes the *same* agent session with your answers, and it carries on, asking again if needed
(`questions.maxRounds` per stage, default 4). The document records them under **Decisions**. In the
requirements, "Open questions" keeps only what's still unresolved.

- **Answering:** the *Questions* tab shows one question at a time: option cards with descriptions and
  the agent's recommendation, *Something else* for your own words, and *Let the agent decide*. Use
  `1`–`9` to pick and Enter to go on; *Send answers & continue* resumes the agent.
- **Revisions** continue the same conversation, so the agent keeps everything it learned.
- **Turning it off:** set `questions.requirements: false` or `questions.spec: false` in `.forge/config.yaml`.

## Where workspaces live

**Several repos** (for example a frontend and a backend): create a small **planning repo** for the
team and open it in the app as the workspace. It holds the epics, the team-wide `AGENTS.md` (how the repos fit together)
and `.forge/config.yaml`, which lists the code repos.

```
~/code/
  templo-epics/          ← open this in forge (Set up a new workspace…), committed to GitLab
    .forge/config.yaml   repos: backend (../templo-backend), frontend (../templo)
    .forge/rules/        learned rules, read by every agent
    AGENTS.md            product and architecture across repos
    epics/<slug>/        idea.md, requirements.md, epic-spec.md, changes/C1.md…, events.jsonl
  templo-backend/        has its own AGENTS.md; changes for it are built in worktrees of this clone
  templo/
```

Repo paths are relative to the planning repo. A developer whose clones live elsewhere sets them in
`.forge/local.yaml`, which is not committed:

```yaml
repos:
  backend: { path: ~/work/templo-backend }
```

**One repo**: set it up as the workspace itself, and add it as a repo with path `.`.

**From the desktop app:** use *Set up a new workspace…* on the welcome screen, or *Edit* next to the
repo chips (also in ⚙ Settings). You can add, edit and remove repos there. Picking a folder fills in:
- the GitLab project, from the git remote;
- the base branch;
- setup and check commands, from `package.json`/lockfiles, `go.mod`, `Cargo.toml` and similar.

It also warns when the remote isn't on your GitLab host. Shared values are saved to
`.forge/config.yaml`, keeping your comments, and per-machine paths to `.forge/local.yaml`. A repo
can't be removed while unfinished changes still build in it.

**Commit `epics/`** so the whole team sees every epic, its specs and its history. Workspace setup adds
`epics/**/events.jsonl merge=union` to `.gitattributes`. If two people act on the same epic, git
keeps both sides' events, and forge orders them by time.

## How agents see the repos

- **Planning agents** (requirements, epic spec, change specs) run from the planning repo and only read.
  Before each planning run, forge fetches every repo and refreshes a read-only **snapshot at
  `origin/<base>`** (a detached worktree under `~/.forge/worktrees/<workspace>/<repo>/_planning`).
  Agents read those snapshots, never your working copy, so local branches, uncommitted edits and
  stale pulls don't leak into specs. The event log records which commit of each repo a plan read.
- **When fetching fails** (offline, auth), forge falls back to the last snapshot, then to the working
  copy. It warns, and the prompt tells the agent how fresh each repo is.
- **Instructions:** agents get the workspace `AGENTS.md` and rules, plus each repo's `AGENTS.md` and
  `CLAUDE.md` (root and `.claude/`), read from the snapshot. Identical files are included once.
- **Forge's own event logs (`epics/**/events.jsonl`) are off limits** to every agent (Read and Grep are
  denied).
- Build and review agents run in a worktree of their change's repo. They get the epic spec, their
  change spec, the workspace and repo instructions, and that repo's checks.
- Each change's MR opens in its own repo's GitLab project. The MR description includes the change spec.

## Quick start

```bash
npm install
npm run demo -- ~/forge-demo          # throwaway planning + api + web repos
npm start -- ~/forge-demo/planning    # builds and opens the app on that workspace
```

For your own repos, run `npm start`, choose **Set up a new workspace…**, pick your planning repo (an
empty git repo is fine), and add your code repos. Export `GITLAB_TOKEN` (api scope) before starting,
or save it under ⚙ Settings; only forge sees it, never the agents.

## Desktop app

An Electron app with the same flow. You get an epic list, the stage stepper, a change list with
repo chips, rendered and editable documents, review findings, a colored diff, history, and live
agent activity with a **Stop** button.

```bash
npm start                             # build and open (last workspace, or the welcome screen)
npm start -- <workspace path>         # open on a specific workspace
npm run dev                           # hot-reloading development
npm run package                       # unpacked build in dist-desktop/ (drop --dir in the script for AppImage/deb/dmg/nsis)
```

- **One core:** the main process runs the domain, use cases and adapters; the renderer only calls a
  typed, validated IPC API (`src/desktop/shared/api.ts`). The actions behind the buttons are in
  `src/ui/actions.ts`.
- **Renderer locked down:** context isolation, sandbox, no Node integration, a strict CSP in packaged
  builds, no navigation or new windows, and only http(s) links (opened in the browser). Agent-written
  markdown is sanitized (DOMPurify). Every IPC argument is checked against a schema.
- **GitLab token:** the settings screen stores it encrypted in the OS keychain (Electron safeStorage).
  If no keychain is available, set the env var instead. Agents never see it.
- **PATH:** when launched from the Dock or a launcher, the app reads PATH from your login shell, so
  git, node and npm resolve.
- **Packaged builds:** the Agent SDK's native binary is unpacked from the asar archive, and the app
  points the SDK at it. A Linux build is about 680 MB, half of which is that binary.
- **Recent Ubuntu (24.04+):** AppArmor blocks the user namespaces that Chromium's sandbox needs, and
  Electron aborts with a `chrome-sandbox ... mode 4755` error. `npm start` detects this and prints
  the fix: an AppArmor profile for forge's Electron binary (recommended), or a setuid-root
  `chrome-sandbox`. Don't use `--no-sandbox`. The renderer shows agent-written content, and the
  sandbox is part of its protection. The `.deb` package should set up the helper when it's installed.
- **Agents stop when the app quits.** It asks first while agents are running. Only one action runs per
  epic at a time.

## Architecture

Hexagonal, functional TypeScript. There are no classes. Ports are records of functions, adapters
are factories that return them, and the only place they are wired together is `src/app/compose.ts`.

```
src/domain/        pure: event-sourced Epic aggregate (epic.ts), change spec parsing/validation and
                   scheduling (changes.ts), requirements and epic spec lint (spec.ts), guards, loop/gate/cost policy. No I/O.
src/ports/         interfaces: EpicStore, ArtifactStore, RepoContext, AgentRunner, Vcs, CodeHost, CheckRunner
src/application/   use cases: stages (requirements, epic spec), changes (draft/approve/drop), build, prompts, renderers
src/adapters/      fs, git (worktrees), gitlab (REST v4), claudeAgent (Agent SDK), process (checks)
src/app/           composition root (one Vcs + CodeHost per configured repo) and workspace setup
src/ui/            the actions behind the app's buttons
src/desktop/       Electron: main (session, validated IPC handlers, settings), preload, renderer (React)
```

State is `replay(events)`, a pure fold over `epics/<slug>/events.jsonl`, and that log is also the
audit trail. Use cases follow the same pattern every time: check a guard, do the side effect, then
append events.

### Build details

- **Batches**: a change is ready when its spec is approved and its dependencies are *merged*. Ready
  changes that declare the same file in the same repo never run together.
- **Checks**: each repo's configured commands (use the same ones as CI). A failure goes back to the
  agent. The loop stops after `maxRounds` rounds or `maxIdenticalFailures` identical failures and
  escalates to you.
- **Revert test** (feature and fix changes): forge reverts the non-test files to the base branch and
  re-runs the `revertTest.check` command, which must fail.
- **Review**: a separate agent session reads the diff, the epic spec and the change spec, and returns
  blocking or advisory findings. A review that failed counts as a blocking finding, and files changed
  outside the spec are always flagged.
- **MRs**: opened only after you approve the code. The forge process pushes; agents cannot.

## Isolation (read before using on anything sensitive)

Build agents get:
- Bash inside the Agent SDK sandbox (bubblewrap on Linux). Writes are limited to the worktree,
  network access to `build.allowedDomains`, and credential directories can't be read.
- An environment with secrets removed.
- No access to git push, commit, remote or config, and no web tools.
- No MCP servers, plugins or skills from the developer's machine.

Worktrees are still not containers. For untrusted input, run forge itself in a container or VM.

## Cost figures

Costs shown are the Agent SDK's estimate (token usage at list prices), not a bill. When agents run
on a Claude subscription login, they count against plan limits instead. Resumed sessions report a
running total, so forge records only what each run added.

## Verified

- `npm run check`: typecheck plus 64 tests, covering:
  - the domain rules: lifecycle, change specs, cross-repo dependencies, cost;
  - end-to-end runs with real git and bare remotes:
    - a two-repo epic: per-change approval, a single redraft, a dropped change, a cross-repo
      dependency, and an MR per repo;
    - plan-level feedback;
    - escalation then rework;
    - the revert test;
    - an agent crash;
  - requirements and epic spec lint: numbered requirements, the planned changes, coverage of every
    requirement, known repos, dependencies;
  - interactive planning in both stages: pause, partial answers, resume in the same session, the round limit,
    revisions continuing the conversation, and cost across resumes;
  - planning snapshots: a teammate's push shows up and local edits don't; the offline fallbacks;
    `CLAUDE.md` loading; the deny rules;
  - repo config editing that keeps comments and validates like startup, and repo detection from a
    folder;
  - the desktop view model and IPC handlers: argument validation, one action per epic, link
    filtering, repo save, the remove guard, and new-workspace setup;
  - keychain-only token storage, and the PATH merge.
- Desktop app, driven in a real Electron window (dev and packaged builds) on the live demo:
  - every view renders;
  - an XSS probe stays inert: no script ran, and the `onerror` and `javascript:` link were stripped;
  - the page has no access to Node or IPC;
  - approving code with no GitLab token fails cleanly;
  - a live agent run streams its tool calls, and Stop ends it.
- Live run on the demo workspace (before the requirements/RFC split): explore, epic spec and change specs (C1 api, C2 web depending on
  C1) with real agents. C1 was built in a sandboxed api worktree, passed its checks and the revert
  test, was reviewed, and stopped for code review, for about $0.95.

## Not yet

- A second approver for high-risk epic specs; for now, review the epic spec in an MR on the planning repo.
- A GitHub code host adapter (only GitLab today).
- Reviewers from a different model family, and several specialized reviewers.
- A retro stage that turns escalations and findings into proposed rule files.
- Stacked branches for dependent changes (today a dependent waits for its dependency to merge).
- A lock against two app windows acting on the same epic (one window already allows only one action per epic).
- Desktop: macOS signing and notarization, Windows signing, auto-update, an app icon. The build sandbox on Windows is untested.
