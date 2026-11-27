import { defineConfig } from 'astro/config';

// 站点托管在 GitHub Pages 项目页：https://wild-think-lab.github.io/wild-think/
export default defineConfig({
  site: 'https://wild-think-lab.github.io',
  base: '/wild-think',
  trailingSlash: 'ignore',
  build: {
    format: 'directory',
    inlineStylesheets: 'auto',
  },
  markdown: {
    shikiConfig: {
      themes: { light: 'github-light', dark: 'poimandres' },
      wrap: false,
    },
    remarkRehype: { footnoteLabel: '注释' },
  },
  devToolbar: { enabled: false },
});
