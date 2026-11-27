export type Topic = {
  id: string;
  index: string;
  name: string;
  en: string;
  desc: string;
  icon: string;
  accent: string;
};

/**
 * 十大专题 —— 顺序即首页卡片顺序
 * index 是排版用的编号，accent 是卡片悬停时的高亮色
 */
export const TOPICS: Topic[] = [
  {
    id: 'starter',
    index: '00',
    name: '从零开始学技术',
    en: 'START HERE',
    desc: '完全不懂也没关系。先讲清“这东西到底在干什么”，再给一份照抄就能跑通的实验报告：环境、步骤、验证、排错，一步不落。',
    icon: 'spark',
    accent: '#7fd1b9',
  },
  {
    id: 'linux',
    index: '01',
    name: 'Linux 运维知识库',
    en: 'LINUX & SYSTEM',
    desc: '发行版差异、Shell、权限模型、进程与服务、日志体系、内核参数调优、线上故障排查。',
    icon: 'terminal',
    accent: '#ff8a3d',
  },
  {
    id: 'network',
    index: '02',
    name: '计算机网络与路由交换',
    en: 'NETWORK',
    desc: 'TCP/IP 协议栈、子网划分与 VLSM、VLAN、OSPF/BGP、ACL 与 NAT、抓包与链路排障。',
    icon: 'network',
    accent: '#5eb0ff',
  },
  {
    id: 'security',
    index: '03',
    name: '网络安全与渗透基础',
    en: 'SECURITY',
    desc: '信息收集、Web 漏洞原理与复现、基线加固、应急响应流程、等级保护落地。',
    icon: 'shield',
    accent: '#7ae582',
  },
  {
    id: 'sre-cloud',
    index: '04',
    name: '云原生与 SRE 体系',
    en: 'CLOUD NATIVE & SRE',
    desc: 'Docker 与 K8s、监控告警（Prometheus/Zabbix）、日志栈、CI/CD、容量与高可用设计。',
    icon: 'cloud',
    accent: '#a78bfa',
  },
  {
    id: 'db',
    index: '05',
    name: '数据库知识库',
    en: 'DATABASE',
    desc: 'MySQL 索引与事务、锁与慢查询、备份恢复、Redis 数据结构与缓存治理、MongoDB 基础。',
    icon: 'database',
    accent: '#ffd166',
  },
  {
    id: 'fullstack',
    index: '06',
    name: '全栈开发笔记',
    en: 'FULL STACK',
    desc: 'HTML/CSS/JS 基础、Vue 与 React 工程化、Node/Go/Python 服务端、接口设计与部署。',
    icon: 'code',
    accent: '#4dd0e1',
  },
  {
    id: 'interview',
    index: '07',
    name: '面试题库与原理拆解',
    en: 'INTERVIEW',
    desc: '运维、网络、云原生、安全方向高频题，按“结论—原理—追问”三层答法整理。',
    icon: 'clipboard',
    accent: '#ff9db1',
  },
  {
    id: 'lab',
    index: '08',
    name: '实操实验指南',
    en: 'HANDS-ON LAB',
    desc: '可复现的实验：环境准备、拓扑与步骤、验证命令、踩坑记录与回滚方式。',
    icon: 'flask',
    accent: '#f0a35e',
  },
  {
    id: 'tools',
    index: '09',
    name: '效率工具箱',
    en: 'TOOLBOX',
    desc: '终端与编辑器配置、脚本模板、命令速查、排障工具链与自用环境清单。',
    icon: 'tool',
    accent: '#8fb996',
  },
  {
    id: 'project',
    index: '10',
            name: '项目与作品',
    en: 'PROJECTS',
    desc: 'KingLinux、KingNetwork、LinuxGG 等自研项目的架构说明、迭代记录与设计取舍。',
    icon: 'box',
    accent: '#c0a6ff',
  },
];

export const TOPIC_MAP = new Map(TOPICS.map((t) => [t.id, t]));

export function topicById(id: string): Topic | undefined {
  return TOPIC_MAP.get(id);
}

export const SITE = {
  title: '野生思考',
  tagline: '把复杂的技术，变成可以落地复现的思考与实践',
  desc: '野生思考 —— 一个写给底层技术实践者的知识库。Linux、网络、安全、SRE、云原生、数据库、全栈，只记录可复现、可落地的内容。',
  author: 'wild-think-lab',
  since: 2026,
};
