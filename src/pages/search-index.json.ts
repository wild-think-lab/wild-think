import type { APIRoute } from 'astro';
import { allPosts, postHref, postTopicId, plainExcerpt } from '../lib/posts';
import { topicById } from '../lib/site';
import { u } from '../lib/url';

export const GET: APIRoute = async () => {
  const posts = await allPosts();
  const index = posts.map((p) => ({
    title: p.data.title,
    desc: p.data.description,
    url: u(postHref(p)),
    topic: topicById(postTopicId(p))?.name ?? '未分类',
    tags: p.data.tags,
    date: p.data.date.toISOString().slice(0, 10),
    text: plainExcerpt(p.body ?? '', 420),
  }));

  return new Response(JSON.stringify(index), {
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
};
