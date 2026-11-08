/**
 * A small two-way RPC over a pair of byte streams: one JSON object per line. Either side can make
 * requests and send events. Used between the desktop app and a forge server running on an SSH host.
 *
 * Only lines tagged `"forge":1` are protocol; anything else (a login shell's banner, a stray log line)
 * is handed to `onNoise` and otherwise ignored, so chatty shells can't break the connection.
 */
import { createInterface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';

type Message =
  | { readonly forge: 1; readonly id: number; readonly method: string; readonly params?: unknown }
  | { readonly forge: 1; readonly id: number; readonly result?: unknown; readonly error?: string }
  | { readonly forge: 1; readonly event: string; readonly payload?: unknown };

export type RpcHandlers = {
  readonly request: (method: string, params: unknown) => Promise<unknown>;
  readonly event?: (event: string, payload: unknown) => void;
  readonly noise?: (line: string) => void;
};

export type Peer = {
  readonly request: (method: string, params?: unknown, timeoutMs?: number) => Promise<unknown>;
  readonly notify: (event: string, payload?: unknown) => void;
  /** Resolves once the input ends; pending requests are rejected then. */
  readonly closed: Promise<void>;
};

const parse = (line: string): Message | undefined => {
  try {
    const msg = JSON.parse(line) as unknown;
    return msg && typeof msg === 'object' && (msg as { forge?: unknown }).forge === 1 ? (msg as Message) : undefined;
  } catch {
    return undefined;
  }
};

export const rpcPeer = (input: Readable, output: Writable, handlers: RpcHandlers): Peer => {
  let nextId = 1;
  let ended = false;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const send = (msg: Message) => {
    if (ended || output.destroyed || output.writableEnded) return;
    output.write(`${JSON.stringify(msg)}\n`);
  };

  const respond = async (id: number, method: string, params: unknown) => {
    try {
      send({ forge: 1, id, result: await handlers.request(method, params) });
    } catch (e) {
      send({ forge: 1, id, error: (e as Error).message || String(e) });
    }
  };

  const lines = createInterface({ input, crlfDelay: Infinity });
  lines.on('line', (line) => {
    const msg = parse(line);
    if (!msg) {
      if (line.trim()) handlers.noise?.(line);
      return;
    }
    if ('event' in msg) handlers.event?.(msg.event, msg.payload);
    else if ('method' in msg) void respond(msg.id, msg.method, msg.params);
    else {
      const waiting = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error !== undefined) waiting?.reject(new Error(msg.error));
      else waiting?.resolve(msg.result);
    }
  });

  const closed = new Promise<void>((resolve) => {
    lines.on('close', () => {
      ended = true;
      for (const p of pending.values()) p.reject(new Error('The connection closed.'));
      pending.clear();
      resolve();
    });
  });

  return {
    closed,
    notify: (event, payload) => send({ forge: 1, event, payload }),
    request: (method, params, timeoutMs) =>
      new Promise((resolve, reject) => {
        if (ended) return reject(new Error('The connection closed.'));
        const id = nextId++;
        const timer = timeoutMs
          ? setTimeout(() => {
              pending.delete(id);
              reject(new Error(`No answer to ${method} after ${Math.round(timeoutMs / 1000)}s.`));
            }, timeoutMs)
          : undefined;
        pending.set(id, {
          resolve: (v) => (clearTimeout(timer), resolve(v)),
          reject: (e) => (clearTimeout(timer), reject(e)),
        });
        send({ forge: 1, id, method, params });
      }),
  };
};
