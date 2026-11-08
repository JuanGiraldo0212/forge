/**
 * Entry point of the forge server on an SSH host (built to out/main/server.js and uploaded by the app).
 * stdin/stdout carry the RPC protocol; everything else goes to stderr, which the app logs.
 */
import { serveForge } from './server.ts';

// Libraries that log with console.log must not corrupt the protocol on stdout.
console.log = console.info = console.debug = (...args: unknown[]) => console.error(...args);

const { done } = serveForge(process.stdin, process.stdout);
void done.then(() => process.exit(0));
