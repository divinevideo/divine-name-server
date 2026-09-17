import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // admin-ui has its own vitest project (node env, its own tsconfig); the CI
    // workflow runs it separately. Without this, the root run also globs
    // admin-ui/**/*.test.ts and executes those suites a second time, under the
    // worker's config rather than admin-ui's.
    exclude: ['**/node_modules/**', '**/*.spec.ts', 'admin-ui/**'],
  },
})
