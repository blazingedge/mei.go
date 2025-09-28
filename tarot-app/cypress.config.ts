import { defineConfig } from "cypress";

export default defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      
    },
    // cypress.config.ts
    env: { API_BASE: 'https://lumiere-api.laife91.workers.dev' }

  },
});
