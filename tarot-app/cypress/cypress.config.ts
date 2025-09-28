import { defineConfig } from 'cypress';

export default defineConfig({
  e2e: {
    baseUrl: 'http://localhost:4200',
    env: { API_BASE: 'http:lumiere-api.laife91.workers.dev' },
    supportFile: 'cypress/support/e2e.ts',   // <-- IMPORTANTE
    specPattern: 'cypress/e2e/**/*.cy.ts',
    video: false,
  },
});
