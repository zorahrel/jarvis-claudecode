/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * Vitest config for the dashboard package — Phase 2 Plan 02-02 (ORC-10).
 *
 * Separate from `vite.config.ts` so the dev/build pipeline doesn't pull in
 * jsdom (which is heavy). Tests run against jsdom for DOM APIs the React
 * Testing Library needs.
 */
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    css: false,
  },
})
