import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      // Keep node_modules (Agent SDK and its native binary, yaml, zod) as runtime requires, not bundled.
      externalizeDeps: true,
      // server.js is the forge server the app uploads to SSH hosts (see src/desktop/remote).
      rolldownOptions: { input: { index: 'src/desktop/main/index.ts', server: 'src/desktop/remote/serverMain.ts' } },
    },
  },
  preload: {
    build: {
      externalizeDeps: true,
      // Sandboxed preloads must be CommonJS.
      rolldownOptions: { input: { index: 'src/desktop/preload/index.ts' }, output: { format: 'cjs', entryFileNames: '[name].cjs' } },
    },
  },
  renderer: {
    root: 'src/desktop/renderer',
    plugins: [react()],
    build: { rolldownOptions: { input: { index: 'src/desktop/renderer/index.html' } } },
  },
});
