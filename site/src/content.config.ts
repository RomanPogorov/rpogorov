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

export const collections = { cases };
