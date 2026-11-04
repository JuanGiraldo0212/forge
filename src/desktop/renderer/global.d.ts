import type { ForgeApi } from '../shared/api.ts';

declare global {
  interface Window {
    readonly forge: ForgeApi;
  }
}
