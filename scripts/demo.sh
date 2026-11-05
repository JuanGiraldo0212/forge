#!/usr/bin/env bash
# Creates a throwaway multi-repo setup to try forge on:
#   <dir>/planning   the forge workspace (epics, team AGENTS.md, config) — open this in the app
#   <dir>/api        a tiny todo module with tests
#   <dir>/web        a tiny renderer that formats todos for display
# Each repo has a local bare repo as "origin". Nothing talks to GitLab until you approve a change's code.
set -euo pipefail

dir="${1:-$HOME/forge-demo}"
if [ -e "$dir" ]; then
  echo "$dir already exists; pass another path or remove it first." >&2
  exit 1
fi
mkdir -p "$dir"

init_repo() {
  git init -q --bare -b main "$dir/$1.git"
  git clone -q "$dir/$1.git" "$dir/$1" 2>/dev/null
  git -C "$dir/$1" checkout -q -b main
}

commit_repo() {
  git -C "$dir/$1" add -A
  git -C "$dir/$1" commit -qm "$2"
  git -C "$dir/$1" push -q origin main
}

# --- api ---------------------------------------------------------------------------------------
init_repo api
cat > "$dir/api/package.json" <<'EOF'
{ "name": "todo-api", "type": "module", "private": true, "scripts": { "test": "node --test" } }
EOF
cat > "$dir/api/todos.js" <<'EOF'
// In-memory todos. Pure functions: never mutate a list, return a new one.
export const createList = () => [];

export const add = (list, title) => [...list, { id: list.length + 1, title, done: false }];

export const complete = (list, id) => list.map((t) => (t.id === id ? { ...t, done: true } : t));

export const pending = (list) => list.filter((t) => !t.done);
EOF
cat > "$dir/api/todos.test.js" <<'EOF'
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { add, complete, createList, pending } from './todos.js';

test('add appends a pending todo', () => {
  assert.deepEqual(add(createList(), 'write spec'), [{ id: 1, title: 'write spec', done: false }]);
});

test('complete marks one todo done', () => {
  const list = complete(add(add(createList(), 'a'), 'b'), 1);
  assert.deepEqual(pending(list).map((t) => t.title), ['b']);
});
EOF
cat > "$dir/api/AGENTS.md" <<'EOF'
# api

Plain ESM JavaScript, no dependencies. Todos are plain objects: { id, title, done }.
Tests use node:test next to the source file (<name>.test.js). Run with `npm test`.
EOF
commit_repo api "Initial todo module"

# --- web ---------------------------------------------------------------------------------------
init_repo web
cat > "$dir/web/package.json" <<'EOF'
{ "name": "todo-web", "type": "module", "private": true, "scripts": { "test": "node --test" } }
EOF
cat > "$dir/web/render.js" <<'EOF'
// Renders todos (as returned by the api) to plain text lines for the UI.
export const renderTodo = (todo) => `${todo.done ? '[x]' : '[ ]'} ${todo.title}`;

export const renderList = (todos) => (todos.length ? todos.map(renderTodo).join('\n') : 'Nothing to do');
EOF
cat > "$dir/web/render.test.js" <<'EOF'
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderList, renderTodo } from './render.js';

test('renders done and pending todos', () => {
  assert.equal(renderTodo({ id: 1, title: 'a', done: true }), '[x] a');
  assert.equal(renderTodo({ id: 2, title: 'b', done: false }), '[ ] b');
});

test('empty list', () => assert.equal(renderList([]), 'Nothing to do'));
EOF
cat > "$dir/web/AGENTS.md" <<'EOF'
# web

Plain ESM JavaScript. Consumes todo objects produced by the api repo; never import from it directly.
Tests use node:test next to the source file (<name>.test.js). Run with `npm test`.
EOF
commit_repo web "Initial renderer"

# --- planning (the forge workspace) ------------------------------------------------------------
init_repo planning
mkdir -p "$dir/planning/.forge/rules"
cat > "$dir/planning/AGENTS.md" <<'EOF'
# Todo product

Two repos:
- api: the todo domain (todos.js). Source of truth for the todo shape.
- web: renders todos for users (render.js). Depends on the shape api produces.

When the todo shape changes, change api first, then web.
EOF
cat > "$dir/planning/.forge/config.yaml" <<EOF
epicsDir: epics
worktreeRoot: $dir/worktrees

changes:
  maxFilesPerChange: 4

build:
  maxParallel: 2

review:
  gate: always

repos:
  api:
    path: ../api
    project: demo/api      # placeholder: opening an MR fails until this is a real GitLab project
    checks:
      - { name: test, run: npm test }
  web:
    path: ../web
    project: demo/web
    checks:
      - { name: test, run: npm test }
EOF
printf '.forge/local.yaml\n' > "$dir/planning/.gitignore"
printf 'epics/**/events.jsonl merge=union\n' > "$dir/planning/.gitattributes"
commit_repo planning "Forge workspace"

echo "Demo ready in $dir"
echo "Open it: npm start -- $dir/planning   (from the forge folder)"
