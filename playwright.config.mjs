import { defineConfig } from '@playwright/test';

// Browser specs start their own ephemeral loopback server and close it in the
// same process. No shared fixed port or pre-existing server is required.
export default defineConfig({
  testDir: './tests/browser',
  timeout: 25_000,
  workers: 1,
  use: { headless: true, browserName: 'chromium' },
});
