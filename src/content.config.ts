import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

/**
 * 文章统一放在 src/content/posts/<专题>/<文件名>.md
 * 目录名即专题 id，frontmatter 里可覆盖。
 */
const posts = defineCollection({
  loader: glob({ pattern: '**/*.{md,mdx}', base: './src/content/posts' }),
  schema: z.object({
    title: z.string(),
    description: z.string().default(''),
    date: z.coerce.date(),
    updated: z.coerce.date().optional(),
    tags: z.array(z.string()).default([]),
    /** 不填则取目录名 */
    topic: z.string().optional(),
    draft: z.boolean().default(false),
    featured: z.boolean().default(false),
    /** 阅读时间（分钟），不填按字数估算 */
    minutes: z.number().optional(),
  }),
});

/**
 * 学习中心：src/content/learn/<课程>/<序号>-<slug>.md
 * 目录名即课程 id，文件名前缀决定章节顺序，frontmatter 的 module 决定所在模块。
 */
const learn = defineCollection({
  loader: glob({ pattern: '**/*.md', base: './src/content/learn' }),
  schema: z.object({
    title: z.string(),
    module: z.string(),
    summary: z.string().default(''),
    minutes: z.number().optional(),
  }),
});

export const collections = { posts, learn };
