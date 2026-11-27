import type { APIRoute } from 'astro';
import { allPosts, postHref, plainExcerpt } from '../lib/posts';
import { SITE } from '../lib/site';

const esc = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export const GET: APIRoute = async ({ site }) => {
  const posts = await allPosts();
  const base = site?.href.replace(/\/$/, '') ?? '';
  const self = base + import.meta.env.BASE_URL + 'rss.xml';
  const siteUrl = base + import.meta.env.BASE_URL;

  const items = posts
    .map((p) => {
      const url = siteUrl.replace(/\/$/, '') + postHref(p);
      const desc = p.data.description || plainExcerpt(p.body ?? '', 200);
      return `    <item>
      <title>${esc(p.data.title)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <pubDate>${p.data.date.toUTCString()}</pubDate>
      <description>${esc(desc)}</description>
    </item>`;
    })
    .join('\n');

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>${esc(SITE.title)}</title>
    <link>${siteUrl}</link>
    <description>${esc(SITE.tagline)}</description>
    <language>zh-CN</language>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <self>${self}</self>
${items}
  </channel>
</rss>`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
