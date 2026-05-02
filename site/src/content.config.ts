/**
 * Content collections — typed schema for cases (and later articles). Astro
 * validates every MDX file in src/content/cases/ against this schema at
 * build time, which means a missing impact metric or wrong company id
 * fails the build instead of slipping into prod.
 */
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const cases = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/cases' }),
  schema: z.object({
    id: z.string(),
    company: z.enum(['cs01', 'cs02']),
    companyLabel: z.string(),
    title: z.string(),
    desc: z.string(),
    metric: z.string().optional(),
    tags: z.array(z.string()),
    theme: z.enum(['dark', 'bright']).default('bright'),
    /**
     * Per-case accent — drives --acc / --acc-rgb on the .case-page wrapper.
     * Components (PainCard, IterCard, dc-tags, dc-quote, etc.) read these
     * vars, so flipping `accent` recolors every accented chrome in the case.
     * Pass either a named preset ('green' / 'blue' / 'red') or a custom
     * { hex, rgb } pair where rgb is "R, G, B" (no alpha).
     */
    accent: z
      .union([
        z.enum(['green', 'blue', 'red', 'cyan']),
        z.object({ hex: z.string(), rgb: z.string() }),
      ])
      .default('green'),
    deeplink: z.string(),
    no: z.string().optional(),
    role: z.string().optional(),
    year: z.string().optional(),
    thumb: z.string().optional(),
    order: z.number().default(0),
    status: z.enum(['live', 'soon']).default('live'),
    impact: z
      .array(
        z.object({
          num: z.string(),
          lbl: z.string(),
        })
      )
      .default([]),
    meta: z
      .array(
        z.object({
          label: z.string(),
          value: z.string(),
        })
      )
      .default([]),
  }),
});

const companies = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/companies' }),
  schema: z.object({
    id: z.string(),
    name: z.string(),
    role: z.string(),
    year: z.string(),
    title: z.string(),
    desc: z.string(),
    tags: z.array(z.string()).default([]),
    thumb: z.string().optional(),
    order: z.number().default(0),
    showcaseTitle: z.string().optional(),
    showcaseDesc: z.string().optional(),
    showcaseTags: z.array(z.string()).optional(),
    showcaseMeta: z.string().optional(),
  }),
});

const articles = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/articles' }),
  schema: z.object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    date: z.coerce.date(),
    author: z.string().default('Roman Pogorov'),
    readingTime: z.string().optional(),
    tags: z.array(z.string()).default([]),
    status: z.enum(['live', 'draft', 'soon']).default('live'),
  }),
});

const rightPanel = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/right-panel' }),
  schema: z.object({
    id: z.string(),
    kind: z.enum(['pain', 'strength', 'agent', 'release']),
    tag: z.string(),
    title: z.string(),
    lead: z.string().optional(),
    short: z
      .object({
        role: z.string().optional(),
        date: z.string().optional(),
        name: z.string().optional(),
        summary: z.string().optional(),
      })
      .optional(),
    stats: z
      .array(
        z.object({
          k: z.string(),
          v: z.string(),
        })
      )
      .default([]),
    sections: z
      .array(
        z.object({
          h: z.string(),
          items: z.array(z.string()),
        })
      )
      .default([]),
    cta: z
      .object({
        label: z.string(),
        openShowcase: z.string(),
      })
      .optional(),
    order: z.number().default(0),
  }),
});

export const collections = { cases, articles, companies, rightPanel };
