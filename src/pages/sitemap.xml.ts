import type { APIRoute } from 'astro';
import { allPosts, allTags, postHref } from '../lib/posts';
import { TOPICS } from '../lib/site';

export const GET: APIRoute = async ({ site }) => {
  const base = (site?.href.replace(/\/$/, '') ?? '') + import.meta.env.BASE_URL;
  const posts = await allPosts();
  const tags = await allTags();

  const urls: { loc: string; lastmod?: string; priority?: string }[] = [
    { loc: '', priority: '1.0' },
    { loc: 'topics/', priority: '0.9' },
    { loc: 'writing/', priority: '0.9' },
    { loc: 'archive/', priority: '0.6' },
    { loc: 'tags/', priority: '0.6' },
    { loc: 'search/', priority: '0.5' },
    { loc: 'about/', priority: '0.5' },
  ];

  for (const t of TOPICS) urls.push({ loc: `topics/${t.id}/`, priority: '0.8' });
  for (const p of posts)
    urls.push({
      loc: postHref(p).replace(/^\//, ''),
      lastmod: (p.data.updated ?? p.data.date).toISOString().slice(0, 10),
      priority: '0.8',
    });
  for (const t of tags)
    urls.push({ loc: `tags/${t.tag.split('/').map(encodeURIComponent).join('/')}/`, priority: '0.4' });

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
  .map(
    (u) => `  <url>
    <loc>${base}${u.loc}</loc>${u.lastmod ? `\n    <lastmod>${u.lastmod}</lastmod>` : ''}${
      u.priority ? `\n    <priority>${u.priority}</priority>` : ''
    }
  </url>`
  )
  .join('\n')}
</urlset>`;

  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
