import { defineConfig } from 'vite';
import { appVersion } from './tools/version.mjs';

export default defineConfig({
  base: './',
  server: { port: 5173, host: '127.0.0.1' },
  build: { target: 'es2022', chunkSizeWarningLimit: 2500 },
  // shown on the title / pause screens (src/ui/UI.ts)
  define: { 'import.meta.env.VITE_APP_VERSION': JSON.stringify(appVersion()) },
});
