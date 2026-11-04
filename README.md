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
idea ─► explore ─[approve]─► epic spec ─[approve]─► change specs
                                                      │  one per merge request, each in exactly one repo
                                                      ▼
              each change:  draft ─[approve]─► build ──────────────────────────────[approve]─► MR ─► merge
                                               agent ⇄ repo checks (≤20 rounds / 3 identical failures)
                                               → commit → revert test → review agent
```

- **Epic**: has an **owner** (whoever creates it; `forge assign` changes it). The owner drives it through
  the gates.
- **Epic spec** (`epic-spec.md`): the whole outcome across repos. It can't be approved without Goal,
  Non-goals, Behavior, Verification, Must not break and Risk.
- **Change specs** (`changes/C1.md`, …): one per MR, each naming its repo, files, dependencies and
  risk, with Goal, Behavior, Verification and Must not break. An agent drafts the set; you edit,
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
- **Send back** to explore or the epic spec.
- **Drop** a single change.

## Where to run forge

**Several repos** (for example a frontend and a backend): create a small **planning repo** for the
team and run forge there. It holds the epics, the team-wide `AGENTS.md` (how the repos fit together)
and `.forge/config.yaml`, which lists the code repos.

```
~/code/
  templo-epics/          ← forge runs here (forge init --workspace), committed to GitLab
    .forge/config.yaml   repos: backend (../templo-backend), frontend (../templo)
    .forge/rules/        learned rules, read by every agent
    AGENTS.md            product and architecture across repos
    epics/<slug>/        idea.md, exploration.md, epic-spec.md, changes/C1.md…, events.jsonl
  templo-backend/        has its own AGENTS.md; changes for it are built in worktrees of this clone
  templo/
```

Repo paths are relative to the planning repo. A developer whose clones live elsewhere sets them in
`.forge/local.yaml`, which is not committed:

```yaml
repos:
  backend: { path: ~/work/templo-backend }
```

**One repo**: run `forge init` inside it; the config lists that repo with `path: .`.

**From the desktop app:** use *Set up a new workspace…* on the welcome screen, or *Edit* next to the
repo chips (also in ⚙ Settings). You can add, edit and remove repos there. Picking a folder fills in:
- the GitLab project, from the git remote;
- the base branch;
- setup and check commands, from `package.json`/lockfiles, `go.mod`, `Cargo.toml` and similar.

It also warns when the remote isn't on your GitLab host. Shared values are saved to
`.forge/config.yaml`, keeping your comments, and per-machine paths to `.forge/local.yaml`. A repo
can't be removed while unfinished changes still build in it.

**Commit `epics/`** so the whole team sees every epic, its specs and its history. `forge init` adds
`epics/**/events.jsonl merge=union` to `.gitattributes`. If two people act on the same epic, git
keeps both sides' events, and forge orders them by time.

## How agents see the repos

- **Planning agents** (explore, epic spec, change specs) run from the planning repo and only read.
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
npm install && npm link          # puts `forge` on PATH (Node >= 24; runs the TypeScript sources via tsx)
npm run demo -- ~/forge-demo     # throwaway planning + api + web repos
cd ~/forge-demo/planning && forge
```

For real repos:

```bash
cd ~/code/templo-epics && forge init --workspace   # then edit .forge/config.yaml: repos, projects, checks
export GITLAB_TOKEN=...                            # api scope; only the forge process sees it
forge
```

## Desktop app

An Electron app with the same flow. You get an epic list, the stage stepper, a change list with
repo chips, rendered and editable documents, review findings, a colored diff, history, and live
agent activity with a **Stop** button.

```bash
npm run desktop:build                 # once, and after pulling changes
forge desktop                         # from a workspace: opens the app on it
npm run desktop:dev                   # hot-reloading development
npm run desktop:package               # unpacked build in dist-desktop/ (drop --dir in the script for AppImage/deb/dmg/nsis)
```

- **One core:** the main process runs the same domain, use cases and adapters as the CLI and TUI. The
  renderer only calls a typed, validated IPC API (`src/desktop/shared/api.ts`). User actions are shared
  with the TUI (`src/ui/actions.ts`).
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
  Electron aborts with a `chrome-sandbox ... mode 4755` error. `forge desktop` detects this and prints
  the fix: an AppArmor profile for forge's Electron binary (recommended), or a setuid-root
  `chrome-sandbox`. Don't use `--no-sandbox`. The renderer shows agent-written content, and the
  sandbox is part of its protection. The `.deb` package should set up the helper when it's installed.
- **Agents stop when the app quits.** It asks first while agents are running. Only one action runs per
  epic at a time.

## TUI

`forge` (or `forge tui`) opens a full-screen dashboard.

- **Left:** epics, with a marker (`●` needs you, a spinner while running, `✓` done) and the owner.
  `m` toggles between your epics and all epics.
- **Right, top:** the selected epic's stages, a hint for what to do next, and its changes with
  status, repo and dependencies.
- **Right, bottom:** the document that needs a decision: the exploration, the epic spec, the
  selected change spec (with anything blocking its approval listed at the bottom), or the change's
  review findings.
- **Bottom strip:** live agent activity, tagged per change.

| Key | Does |
|---|---|
| `r` / `R` | run: next stage, or draft/redraft change specs and build approved changes / force-run after a crash |
| `a` | approve the open gate, or the selected change (draft → spec approved; reviewed → code approved, MR opened) |
| `A` | approve every draft change spec that passes its checks |
| `v` | revise: the stage, the selected change (spec or code), or the whole change set |
| `x` / `X` | drop the selected change / abandon the epic |
| `e` | edit the document or draft change spec in `$EDITOR` |
| `1` `2` `3` `4` | idea, exploration, epic spec, selected change spec |
| `t` `d` `l` | change review, change diff, event log |
| `n` `o` `s` | new epic, change owner, sync MR state from GitLab |
| `Tab` `↑↓` `?` `q` | focus epics → changes → viewer, move, help, quit |

Agents run inside the TUI process. Quitting stops them (forge asks first). Afterwards, `R`
force-restarts, and interrupted changes are handed back to you. The TUI also picks up changes made
by `forge` commands in other terminals.

## CLI

```
forge init [--workspace]
forge new "<title>" [-m <idea> | --file <path>] [--owner <email>]
forge list [--mine]
forge status <epic>
forge show <epic> [--change <id>]
forge run <epic> [--force]
forge approve <epic> [--change <id>] [-m <note>]     no --change in change specs = approve all drafts
forge revise <epic> -m <feedback> [--change <id>]    no --change in change specs = feedback on the whole set
forge drop <epic> <change> -m <why>
forge back <epic> <explore|spec> -m <why>
forge assign <epic> <owner>
forge sync <epic>
forge log <epic>
forge abandon <epic> -m <why>
```

## Architecture

Hexagonal, functional TypeScript. There are no classes. Ports are records of functions, adapters
are factories that return them, and the only place they are wired together is `src/cli/compose.ts`.

```
src/domain/        pure: event-sourced Epic aggregate (epic.ts), change spec parsing/validation and
                   scheduling (changes.ts), epic spec lint, guards, loop/gate/cost policy. No I/O.
src/ports/         interfaces: EpicStore, ArtifactStore, RepoContext, AgentRunner, Vcs, CodeHost, CheckRunner
src/application/   use cases: stages (explore, epic spec), changes (draft/approve/drop), build, prompts, renderers
src/adapters/      fs, git (worktrees), gitlab (REST v4), claudeAgent (Agent SDK), process (checks)
src/cli/           CLI and the composition root (one Vcs + CodeHost + RepoContext per configured repo)
src/tui/           Ink TUI: pure state + key map (state.ts), effects (commands.ts), components (App.tsx)
src/ui/            user actions shared by the TUI and the desktop app
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

- `npm run check`: typecheck plus 60 tests, covering:
  - the domain rules: lifecycle, change specs, cross-repo dependencies, cost;
  - end-to-end runs with real git and bare remotes:
    - a two-repo epic: per-change approval, a single redraft, a dropped change, a cross-repo
      dependency, and an MR per repo;
    - plan-level feedback;
    - escalation then rework;
    - the revert test;
    - an agent crash;
  - the TUI's state and key map, plus a rendered TUI driven by keystrokes from idea to approved
    change specs;
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
- Live run on the demo workspace: explore, epic spec and change specs (C1 api, C2 web depending on
  C1) with real agents. C1 was built in a sandboxed api worktree, passed its checks and the revert
  test, was reviewed, and stopped for code review, for about $0.95.

## Not yet

- A second approver for high-risk epic specs; for now, review the epic spec in an MR on the planning repo.
- A GitHub code host adapter (only GitLab today).
- Reviewers from a different model family, and several specialized reviewers.
- A retro stage that turns escalations and findings into proposed rule files.
- Stacked branches for dependent changes (today a dependent waits for its dependency to merge).
- A lock against two `forge run` processes on the same epic (the desktop app already allows only one action per epic).
- Desktop: macOS signing and notarization, Windows signing, auto-update, an app icon. The build sandbox on Windows is untested.
