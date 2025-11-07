import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { defineConfig } from 'vitest/config';

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
    alias: {
      $lib: fileURLToPath(new URL('./src/lib', import.meta.url))
    },
    conditions: ['svelte', 'browser']
  },
  test: {
    environment: 'jsdom',
    exclude: ['tests/**'],
    include: ['src/**/*.{test,spec}.{js,ts}']
  }
});
