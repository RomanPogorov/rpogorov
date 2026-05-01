// @ts-check
import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';

export default defineConfig({
  site: 'https://clauderunner.com',
  base: '/rpogorov-dev/app/',
  outDir: '../app',
  build: {
    assets: 'assets',
  },
  integrations: [mdx()],
});
