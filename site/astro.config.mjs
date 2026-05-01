// @ts-check
import { defineConfig } from 'astro/config';

export default defineConfig({
  site: 'https://clauderunner.com',
  base: '/rpogorov-dev/',
  outDir: '../dist-astro',
  build: {
    assets: 'assets',
  },
});
