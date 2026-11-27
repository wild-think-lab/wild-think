export type Course = {
  id: string;
  name: string;
  en: string;
  tag: string;
  desc: string;
  icon: string;
  accent: string;
  /** 学完能做什么，3 条以内 */
  can: string[];
};

/**
 * 学习中心的课程清单。章节内容在 src/content/learn/<id>/*.md，
 * 文件名前缀（01-、02-）决定顺序，frontmatter 的 module 决定分组。
 */
export const COURSES: Course[] = [
  {
    id: 'linux',
    name: 'Linux 从入门到能干活',
    en: 'LINUX FUNDAMENTALS',
    tag: '系统基础',
    desc: '从"Linux 是什么"开始，一路走到能独立装软件、看日志、定位故障。每一步都配命令和验证方法。',
    icon: 'terminal',
    accent: '#ff8a3d',
    can: ['在一台空机器上装好服务并设成自启', '看懂权限、进程、日志，能自己排查', '把日常操作写成可复用的脚本'],
  },
  {
    id: 'python',
    name: 'Python 从零到能写脚本',
    en: 'PYTHON FOR BEGINNERS',
    tag: '编程语言',
    desc: '不假设你会任何编程。从装环境、变量、流程控制讲到函数、数据结构、文件处理和虚拟环境。',
    icon: 'code',
    accent: '#4dd0e1',
    can: ['写出一段能处理真实数据的脚本', '看懂报错并自己修', '管理依赖，让别人也能跑起来'],
  },
  {
    id: 'network',
    name: '网络从入门到会抓包',
    en: 'NETWORK BASICS',
    tag: '网络基础',
    desc: '先把 IP、端口、域名、HTTP 四件事讲透，再动手用 ping、curl、tcpdump 验证结论。',
    icon: 'network',
    accent: '#5eb0ff',
    can: ['说清"网站打不开"落在哪一层', '会读一次完整的 HTTP 请求', '能用抓包证明"包到底到没到"'],
  },
];

export const COURSE_MAP = new Map(COURSES.map((c) => [c.id, c]));
export const courseById = (id: string) => COURSE_MAP.get(id);
