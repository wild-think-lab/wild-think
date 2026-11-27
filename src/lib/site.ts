export type Topic = {
  id: string;
  index: string;
  name: string;
  en: string;
  desc: string;
  icon: string;
  accent: string;
  /** 所属大类，用于首页与专题页分组 */
  category: CategoryId;
};

export type CategoryId =
  | 'foundation'
  | 'system'
  | 'ops'
  | 'cloud'
  | 'data'
  | 'security'
  | 'dev'
  | 'practice';

export const CATEGORIES: { id: CategoryId; name: string; en: string; note: string }[] = [
  { id: 'foundation', name: '基础入门', en: 'FOUNDATION', note: '完全不懂，从这里开始' },
  { id: 'system', name: '系统与网络', en: 'SYSTEM & NETWORK', note: '机器、协议、路怎么走通' },
  { id: 'ops', name: '运维与自动化', en: 'OPERATIONS', note: '让重复的事自己跑起来' },
  { id: 'cloud', name: '云与交付', en: 'CLOUD & DELIVERY', note: '容器、虚拟化、发布流水线' },
  { id: 'data', name: '数据', en: 'DATA', note: '存、查、备份与性能' },
  { id: 'security', name: '安全', en: 'SECURITY', note: '漏洞、加固、应急与合规' },
  { id: 'dev', name: '开发', en: 'DEVELOPMENT', note: '前端、后端、接口与工程化' },
  { id: 'practice', name: '实战与工具', en: 'PRACTICE', note: '实验、工具、可复现的产出' },
];

/**
 * 全站专题 —— 顺序即编号，category 决定分组
 */
export const TOPICS: Topic[] = [
  {
    id: 'starter',
    index: '01',
    name: '从零开始学技术',
    en: 'START HERE',
    desc: '完全不懂也没关系。先讲清“这东西到底在干什么”，再给一份照抄就能跑通的实验报告：环境、步骤、验证、排错，一步不落。',
    icon: 'spark',
    accent: '#7fd1b9',
    category: 'foundation',
  },
  {
    id: 'linux',
    index: '02',
    name: 'Linux 系统与运维',
    en: 'LINUX & SYSTEM',
    desc: '发行版差异、权限模型、进程与服务、日志体系、内核参数、线上故障排查，以及从零到能独立运维一台机器。',
    icon: 'terminal',
    accent: '#ff8a3d',
    category: 'system',
  },
  {
    id: 'windows',
    index: '03',
    name: 'Windows Server 与域控',
    en: 'WINDOWS SERVER',
    desc: 'AD 域、组策略、DNS/DHCP、文件共享权限、远程管理，以及企业里躲不开的那些 Windows 侧问题。',
    icon: 'grid',
    accent: '#58a6ff',
    category: 'system',
  },
  {
    id: 'network',
    index: '04',
    name: '计算机网络与路由交换',
    en: 'NETWORK',
    desc: 'TCP/IP 协议栈、子网划分与 VLSM、VLAN、OSPF、ACL 与 NAT、抓包与链路排障。',
    icon: 'network',
    accent: '#5eb0ff',
    category: 'system',
  },
  {
    id: 'shell',
    index: '05',
    name: 'Shell 脚本与自动化',
    en: 'SHELL & AUTOMATION',
    desc: '从第一条 shebang 到能上线的运维脚本：参数处理、错误处理、日志、并发控制、定时任务与安全边界。',
    icon: 'terminal',
    accent: '#c3e88d',
    category: 'ops',
  },
  {
    id: 'monitor',
    index: '06',
    name: '监控与可观测性',
    en: 'MONITORING',
    desc: '指标、日志、链路三条线：Prometheus + Grafana、Zabbix、告警收敛、SLI/SLO 与故障复盘。',
    icon: 'pulse',
    accent: '#ff6b9d',
    category: 'ops',
  },
  {
    id: 'sre-cloud',
    index: '07',
    name: '云原生与 SRE 体系',
    en: 'CLOUD NATIVE & SRE',
    desc: 'Docker 与 K8s、服务发布、容量与高可用、故障演练，把“能跑”做成“跑得住”。',
    icon: 'cloud',
    accent: '#a78bfa',
    category: 'cloud',
  },
  {
    id: 'virtual',
    index: '08',
    name: '虚拟化与私有云',
    en: 'VIRTUALIZATION',
    desc: 'VMware、Proxmox VE、KVM 的选择与落地，快照、迁移、存储、网络桥接与资源超分。',
    icon: 'layers',
    accent: '#7dd3fc',
    category: 'cloud',
  },
  {
    id: 'devops',
    index: '09',
    name: 'DevOps 与交付流水线',
    en: 'DEVOPS & CI/CD',
    desc: 'Git 分支模型、GitHub Actions、镜像构建、灰度发布与回滚，让发布变成一件不紧张的事。',
    icon: 'arrowUp',
    accent: '#86efac',
    category: 'cloud',
  },
  {
    id: 'db',
    index: '10',
    name: '数据库知识库',
    en: 'DATABASE',
    desc: 'MySQL 索引与事务、锁与慢查询、备份恢复；Redis 数据结构与缓存治理；PostgreSQL 与 MongoDB 基础。',
    icon: 'database',
    accent: '#ffd166',
    category: 'data',
  },
  {
    id: 'security',
    index: '11',
    name: '网络安全与渗透基础',
    en: 'SECURITY',
    desc: '信息收集、Web 漏洞原理与复现、基线加固、应急响应、等级保护与最小权限落地。',
    icon: 'shield',
    accent: '#7ae582',
    category: 'security',
  },
  {
    id: 'fullstack',
    index: '12',
    name: '全栈开发笔记',
    en: 'FULL STACK',
    desc: 'HTML/CSS/JS、Vue 与 React 工程化、Python/Go 服务端、接口设计与部署，前后端各讲一层。',
    icon: 'code',
    accent: '#4dd0e1',
    category: 'dev',
  },
  {
    id: 'lab',
    index: '13',
    name: '实操实验指南',
    en: 'HANDS-ON LAB',
    desc: '可复现的实验：环境准备、拓扑与步骤、验证命令、踩坑记录与回滚方式，照着做就能跑通。',
    icon: 'flask',
    accent: '#f0a35e',
    category: 'practice',
  },
  {
    id: 'project',
    index: '14',
    name: '项目与工程实践',
    en: 'PROJECTS',
    desc: '真实工程的架构说明、迭代记录与设计取舍：为什么这样分层、踩过哪些坑、后来怎么改的。',
    icon: 'box',
    accent: '#c0a6ff',
    category: 'practice',
  },
  {
    id: 'tools',
    index: '15',
    name: '效率工具箱',
    en: 'TOOLBOX',
    desc: '终端与编辑器配置、命令速查、排障工具链、自用环境清单，以及 789 个可直达的工具站点。',
    icon: 'tool',
    accent: '#8fb996',
    category: 'practice',
  },
  {
    id: 'interview',
    index: '16',
    name: '面试题库与原理拆解',
    en: 'INTERVIEW',
    desc: '运维、网络、云原生、安全方向高频题，按“结论—原理—追问”三层答法整理。',
    icon: 'clipboard',
    accent: '#ff9db1',
    category: 'practice',
  },
];

export const TOPIC_MAP = new Map(TOPICS.map((t) => [t.id, t]));

export function topicById(id: string): Topic | undefined {
  return TOPIC_MAP.get(id);
}

export function topicsByCategory(cat: CategoryId): Topic[] {
  return TOPICS.filter((t) => t.category === cat);
}

export const SITE = {
  title: '野生思考',
  tagline: '把复杂的技术，变成可以落地复现的思考与实践',
  desc: '野生思考 —— 写给底层技术实践者的知识库。Linux、Windows、网络、自动化、云原生、数据库、安全、开发，只记录可复现、可落地的内容。',
  author: 'wild-think-lab',
  since: 2026,
};
