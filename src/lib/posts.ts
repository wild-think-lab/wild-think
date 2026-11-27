import { getCollection, type CollectionEntry } from 'astro:content';
import { TOPICS, topicById } from './site';

export type Post = CollectionEntry<'posts'>;

/** 专题 id：优先 frontmatter.topic，其次目录名 */
export function postTopicId(post: Post): string {
  return post.data.topic ?? post.id.split('/')[0];
}

export function postSlug(post: Post): string {
  return post.id.split('/').slice(1).join('/');
}

export function postHref(post: Post): string {
  return `/writing/${postSlug(post)}/`;
}

export function readingMinutes(post: Post): number {
  if (post.data.minutes) return post.data.minutes;
  const words = (post.body ?? '').replace(/[#>*`\-|]/g, '').length;
  return Math.max(1, Math.round(words / 420));
}

let cache: Post[] | undefined;

export async function allPosts(): Promise<Post[]> {
  if (!cache) {
    const list = await getCollection('posts', ({ data }) => !data.draft);
    cache = list.sort((a, b) => b.data.date.getTime() - a.data.date.getTime());
  }
  return cache;
}

export async function topicsWithCounts() {
  const posts = await allPosts();
  return TOPICS.map((topic) => ({
    ...topic,
    count: posts.filter((p) => postTopicId(p) === topic.id).length,
    latest: posts.find((p) => postTopicId(p) === topic.id),
  }));
}

export async function postsByTopic(topicId: string): Promise<Post[]> {
  const posts = await allPosts();
  return posts
    .filter((p) => postTopicId(p) === topicId)
    .sort((a, b) => {
      const d = b.data.date.getTime() - a.data.date.getTime();
      if (d !== 0) return d;
      // 同一天的文章按文件名序号升序，保证 01 → 02 → 03 的阅读顺序
      return a.id.localeCompare(b.id, 'en', { numeric: true });
    });
}

export async function allTags(): Promise<{ tag: string; count: number }[]> {
  const posts = await allPosts();
  const map = new Map<string, number>();
  for (const p of posts) {
    for (const t of p.data.tags) map.set(t, (map.get(t) ?? 0) + 1);
  }
  return [...map.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export async function postsByYear(): Promise<
  { year: string; posts: Post[] }[]
> {
  const posts = await allPosts();
  const map = new Map<string, Post[]>();
  for (const p of posts) {
    const y = String(p.data.date.getFullYear());
    if (!map.has(y)) map.set(y, []);
    map.get(y)!.push(p);
  }
  return [...map.entries()]
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .map(([year, list]) => ({ year, posts: list }));
}

export function topicLabel(post: Post): string {
  return topicById(postTopicId(post))?.name ?? '未分类';
}

export function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function shortDate(d: Date): string {
  return `${String(d.getMonth() + 1).padStart(2, '0')}.${String(
    d.getDate()
  ).padStart(2, '0')}`;
}

/** 粗略抽取正文纯文本，用于搜索结果与 RSS 摘要 */
export function plainExcerpt(body: string, len = 160): string {
  const text = body
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~\-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return text.slice(0, len);
}
