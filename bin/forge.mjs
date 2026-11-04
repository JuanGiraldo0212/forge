#!/usr/bin/env node
// Runs the TypeScript sources directly; tsx handles the TUI's JSX. No build step.
// Point tsx at forge's own tsconfig: forge runs inside other repos, whose tsconfig (if any) does not apply.
import { fileURLToPath } from 'node:url';
import { register } from 'tsx/esm/api';

register({ tsconfig: fileURLToPath(new URL('../tsconfig.json', import.meta.url)) });
await import('../src/cli/main.ts');
