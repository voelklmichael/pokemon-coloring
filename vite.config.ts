import { defineConfig } from 'vitest/config';

// UTC build time, e.g. "2026-11-01 09:31 UTC"
const buildTime = new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

export default defineConfig({
  // Relative base so the build works under https://<user>.github.io/<repo>/
  base: './',
  plugins: [
    {
      name: 'build-time',
      transformIndexHtml: (html) => html.replaceAll('%BUILD_TIME%', buildTime),
    },
  ],
  test: {
    environment: 'node',
  },
});
