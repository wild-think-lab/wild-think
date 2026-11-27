/** 统一处理 base 前缀，兼容 GitHub Pages 项目页部署 */
const BASE = import.meta.env.BASE_URL.replace(/\/$/, '');

export function u(path = '/'): string {
  const clean = '/' + String(path).replace(/^\/+/, '');
  if (clean === '/') return BASE + '/';
  return BASE + clean.replace(/\/$/, '') + '/';
}

/** 非目录型资源（如 /rss.xml、/search-index.json） */
export function f(path: string): string {
  return BASE + '/' + String(path).replace(/^\/+/, '');
}

export function abs(path = '/'): string {
  const site = import.meta.env.SITE?.replace(/\/$/, '') ?? '';
  return site + u(path);
}

/** 标签可能含斜杠（如 TCP/IP），逐段编码后拼成路径 */
export function tagHref(tag: string): string {
  return u('/tags/' + tag.split('/').map(encodeURIComponent).join('/'));
}
