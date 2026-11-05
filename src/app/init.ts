/**
 * Files a new forge workspace needs, written by the desktop app's workspace setup.
 * Never overwrites anything that exists.
 */
import { join } from 'node:path';
import { ensureLine, forgeDir, writeIfMissing } from '../adapters/fs.ts';

const RULES_README = `# Rules

One topic per file. Every agent reads all of them at the start of every session.
Add a rule when an agent makes the same mistake twice; say what to do, and why.
`;

const AGENTS_STUB = `# Agent instructions

<!-- Read by every Forge agent. Describe the product, the architecture, conventions, and what never to touch.
     In a planning repo, describe how the repos fit together (who calls whom, shared contracts). -->
`;

/** Returns the files it created or updated, relative to the workspace. */
export const initWorkspaceFiles = async (root: string, configYaml: string, epicsDir = 'epics'): Promise<readonly string[]> =>
  [
    (await writeIfMissing(join(forgeDir(root), 'config.yaml'), configYaml)) && '.forge/config.yaml',
    (await writeIfMissing(join(forgeDir(root), 'rules', 'README.md'), RULES_README)) && '.forge/rules/README.md',
    (await writeIfMissing(join(root, 'AGENTS.md'), AGENTS_STUB)) && 'AGENTS.md',
    (await ensureLine(join(root, '.gitignore'), '.forge/local.yaml')) && '.gitignore',
    // Two people acting on the same epic append to the same log; union-merge keeps both sides' events.
    (await ensureLine(join(root, '.gitattributes'), `${epicsDir}/**/events.jsonl merge=union`)) && '.gitattributes',
  ].filter((x): x is string => Boolean(x));
