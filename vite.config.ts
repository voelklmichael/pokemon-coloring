import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative base so the build works under https://<user>.github.io/<repo>/
  base: './',
  test: {
    environment: 'node',
  },
});
