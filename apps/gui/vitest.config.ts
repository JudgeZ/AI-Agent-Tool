import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

const XTERM_CSS_ID = '@xterm/xterm/css/xterm.css';

export default defineConfig({
  plugins: [
    svelte({
      compilerOptions: {
        dev: true
      }
    })
  ],
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        module: 'esnext',
        moduleResolution: 'bundler'
      }
    }
  },
  resolve: {
    alias: [
      { find: '$lib', replacement: fileURLToPath(new URL('./src/lib', import.meta.url)) },
      { find: '$app/environment', replacement: fileURLToPath(new URL('./src/test-support/app-environment.ts', import.meta.url)) },
      { find: XTERM_CSS_ID, replacement: fileURLToPath(new URL('./src/test-support/mocks/xterm.css', import.meta.url)) },
      { find: /^@xterm\/xterm$/, replacement: fileURLToPath(new URL('./src/test-support/mocks/xterm.ts', import.meta.url)) },
      { find: /^@xterm\/addon-fit$/, replacement: fileURLToPath(new URL('./src/test-support/mocks/xterm-fit.ts', import.meta.url)) }
    ],
    conditions: ['svelte', 'browser']
  },
  test: {
    environment: 'jsdom',
    exclude: ['tests/**'],
    include: ['src/**/*.{test,spec}.{js,ts}'],
    setupFiles: ['./src/setupTests.ts'],
    globals: true,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      thresholds: {
        lines: 85,
        statements: 85,
        functions: 85,
        branches: 65
      }
    }
  }
});
