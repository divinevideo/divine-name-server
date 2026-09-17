// ABOUTME: Vitest config for the admin UI
// ABOUTME: node environment — the tests cover pure form-rule logic, not rendering

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
