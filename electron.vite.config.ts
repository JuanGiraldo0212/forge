import react from '@vitejs/plugin-react';
import { defineConfig } from 'electron-vite';

export default defineConfig({
  main: {
    build: {
      // Keep node_modules (Agent SDK and its native binary, yaml, zod) as runtime requires, not bundled.
      externalizeDeps: true,
      rolldownOptions: { input: { index: 'src/desktop/main/index.ts' } },
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
