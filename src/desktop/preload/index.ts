/**
 * Preload (sandboxed): exposes exactly the ForgeApi methods to the page as `window.forge`, nothing else.
 * No Node, no ipcRenderer, no arbitrary channels reach the page.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import { channel, EVENTS, METHODS, type ForgeApi } from '../shared/api.ts';

const subscribe = <T>(event: string) => (fn: (payload: T) => void) => {
  const listener = (_e: IpcRendererEvent, payload: T) => fn(payload);
  ipcRenderer.on(event, listener);
  return () => void ipcRenderer.removeListener(event, listener);
};

const methods = Object.fromEntries(METHODS.map((m) => [m, (...args: unknown[]) => ipcRenderer.invoke(channel(m), ...args)]));

const api = {
  ...methods,
  onEpicsChanged: subscribe(EVENTS.epicsChanged),
  onBusy: subscribe(EVENTS.busy),
} as unknown as ForgeApi;

contextBridge.exposeInMainWorld('forge', api);
