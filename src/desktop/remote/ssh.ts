/**
 * SSH transport for remote workspaces (ssh2: pure JavaScript, so password login works without an
 * askpass helper). Host keys are trusted on first use: an unknown or changed key fails the connection
 * with its fingerprint, and the app asks the user before connecting with it.
 */
import { createHash } from 'node:crypto';
// ssh2 is CommonJS without detectable named exports; take them off the default export.
import ssh2, { type ClientChannel, type ConnectConfig } from 'ssh2';
import { err, ok, type Result } from '../../domain/result.ts';
import type { Exec } from '../../adapters/process.ts';

export type SshAuth =
  | { readonly kind: 'password'; readonly password: string }
  | { readonly kind: 'key'; readonly privateKey: Buffer; readonly passphrase?: string }
  | { readonly kind: 'agent'; readonly socket: string };

export type SshTarget = { readonly host: string; readonly port: number; readonly username: string; readonly auth: SshAuth };

export type SshError =
  /** The host key is not the trusted one (or nothing is trusted yet). */
  | { readonly kind: 'host-key'; readonly fingerprint: string }
  | { readonly kind: 'failed'; readonly message: string };

export type SshSession = {
  /** Runs a command to completion, optionally feeding `stdin`. Never rejects; inspect `code`. */
  readonly run: (command: string, stdin?: string | Buffer) => Promise<Exec>;
  /** Starts a long-running command and hands back its channel (stdout/stdin; stderr on `.stderr`). */
  readonly spawn: (command: string) => Promise<ClientChannel>;
  readonly close: () => void;
  /** Resolves when the connection ends, with the reason if it failed. */
  readonly closed: Promise<string | undefined>;
};

/** OpenSSH-style fingerprint of a raw host key: "SHA256:" + unpadded base64. */
export const fingerprintOf = (key: Buffer): string => `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;

/** POSIX single-quoting (also understood by bash, zsh and fish). */
export const shq = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/**
 * Wraps a command so it runs in the user's interactive login shell: non-interactive SSH commands skip
 * ~/.bashrc and friends, which is where nvm, asdf and the like put node on PATH.
 */
export const inLoginShell = (command: string): string => `sh -c ${shq('exec "${SHELL:-/bin/sh}" -ilc "$0"')} ${shq(command)}`;

const describe = (e: Error & { level?: string }): string =>
  e.level === 'client-authentication'
    ? 'Authentication failed. Check the username and password (or key).'
    : e.level === 'client-timeout'
      ? 'Timed out connecting. Check the host and port, and that the server is reachable.'
      : /ENOTFOUND|EAI_AGAIN/.test(e.message)
        ? `Unknown host: ${e.message.split(' ').pop()}`
        : /ECONNREFUSED/.test(e.message)
          ? 'Connection refused. Is SSH running on that port?'
          : e.message;

export const openSsh = (target: SshTarget, opts: { readonly trustedFingerprint?: string; readonly readyTimeoutMs?: number } = {}): Promise<Result<SshSession, SshError>> =>
  new Promise((resolve) => {
    const client = new ssh2.Client();
    let seen: string | undefined;
    let ready = false;
    let failure: string | undefined;
    let closedBy: 'us' | undefined;

    const config: ConnectConfig = {
      host: target.host,
      port: target.port,
      username: target.username,
      readyTimeout: opts.readyTimeoutMs ?? 20_000,
      keepaliveInterval: 15_000,
      keepaliveCountMax: 4,
      hostVerifier: (key: Buffer) => {
        seen = fingerprintOf(key);
        return seen === opts.trustedFingerprint;
      },
      ...(target.auth.kind === 'password'
        ? // Many servers only offer password login as keyboard-interactive.
          { password: target.auth.password, tryKeyboard: true }
        : target.auth.kind === 'key'
          ? { privateKey: target.auth.privateKey, passphrase: target.auth.passphrase }
          : { agent: target.auth.socket }),
    };

    if (target.auth.kind === 'password') {
      const password = target.auth.password;
      client.on('keyboard-interactive', (_name, _instructions, _lang, prompts, finish) => finish(prompts.map(() => password)));
    }

    const closed = new Promise<string | undefined>((done) => client.on('close', () => done(closedBy === 'us' ? undefined : failure ?? 'The SSH connection closed.')));

    client.on('error', (e: Error & { level?: string }) => {
      failure = describe(e);
      if (ready) return;
      if (seen && seen !== opts.trustedFingerprint) resolve(err({ kind: 'host-key', fingerprint: seen }));
      else resolve(err({ kind: 'failed', message: failure }));
    });

    client.on('ready', () => {
      ready = true;
      const exec = (command: string) =>
        new Promise<ClientChannel>((done, fail) => client.exec(command, (e, channel) => (e ? fail(e) : done(channel))));
      resolve(
        ok({
          closed,
          close: () => {
            closedBy = 'us';
            client.end();
          },
          spawn: exec,
          run: async (command, stdin) => {
            try {
              const channel = await exec(command);
              return await new Promise<Exec>((done) => {
                let stdout = '';
                let stderr = '';
                channel.on('data', (d: Buffer) => (stdout += d.toString()));
                channel.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
                channel.on('close', (code: number | null) => done({ code: code ?? 1, stdout, stderr }));
                channel.end(stdin);
              });
            } catch (e) {
              return { code: 1, stdout: '', stderr: (e as Error).message };
            }
          },
        }),
      );
    });

    try {
      client.connect(config);
    } catch (e) {
      resolve(err({ kind: 'failed', message: (e as Error).message }));
    }
  });
