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
  {
    id: 'shell',
    name: 'Shell 脚本从看懂到能上线',
    en: 'SHELL SCRIPTING',
    tag: '自动化',
    desc: '不假设你写过脚本。从第一行 shebang 讲到参数处理、错误处理、日志、定时执行，最后写出一个敢放到生产上的备份脚本。',
    icon: 'terminal',
    accent: '#c3e88d',
    can: ['把一串手敲命令变成可复用的脚本', '脚本出错时能自己定位，不会静默失败', '让脚本定时跑，并知道它有没有真的跑成功'],
  },
  {
    id: 'docker',
    name: 'Docker 从装到能上生产',
    en: 'DOCKER PRACTICE',
    tag: '容器',
    desc: '容器不是虚拟机。先把镜像、容器、卷、网络四个概念讲清，再写 Dockerfile、用 Compose 起一套服务，最后把镜像瘦下来。',
    icon: 'container',
    accent: '#58a6ff',
    can: ['把一个应用打成镜像并在任意机器上跑起来', '用 Compose 管多容器服务', '看懂容器起不来的报错并修掉'],
  },
  {
    id: 'mysql',
    name: 'MySQL 从建库到能运维',
    en: 'MYSQL PRACTICE',
    tag: '数据库',
    desc: '从"装完连不上"开始，讲清库表设计、索引与执行计划、事务与锁、备份恢复和慢查询，最后能自己判断"这条 SQL 为什么慢"。',
    icon: 'database',
    accent: '#ffd166',
    can: ['独立装好并安全地连上数据库', '会看 EXPLAIN，知道索引有没有生效', '能做备份、能恢复到某个时间点'],
  },
  {
    id: 'kubernetes',
    name: 'Kubernetes 从看懂到能上线',
    en: 'KUBERNETES PRACTICE',
    tag: '容器编排',
    desc: '从"为什么需要编排"开始，讲清 Pod/工作负载、Service 与 Ingress、配置与密钥、存储、排障五步法，最后落到生产可用：资源、HPA、PDB 与发布策略。',
    icon: 'box',
    accent: '#7aa2f7',
    can: [
      '把一个无状态服务完整部署到集群并对外访问',
      'Pod 起不来时按五步法定位到具体原因',
      '判断一个服务缺了哪些"能上生产"的条件',
    ],
  },
  {
    id: 'observability',
    name: '可观测性从指标到复盘',
    en: 'OBSERVABILITY',
    tag: '监控与排障',
    desc: '从"为谁监控"开始，讲清指标、日志、链路三件套怎么接起来，再讲告警设计与排障流程，最后落到一次故障的完整复盘。',
    icon: 'pulse',
    accent: '#f7768e',
    can: [
      '为一个服务设计出黄金信号与 SLO 阈值',
      '用 traceId 把一次慢请求定位到具体一段',
      '把告警噪音降到"每条都愿意处理"的程度',
    ],
  },
  {
    id: 'security-basics',
    name: '安全运维入门：从盘资产到能应急',
    en: 'SECURITY OPERATIONS',
    tag: '安全',
    desc: '不假设你有安全背景。从资产盘点与威胁建模讲起，讲清账号权限、暴露面收敛、日志检测，最后落到一次应急响应的前 60 分钟。',
    icon: 'shield',
    accent: '#c792ea',
    can: [
      '列出一份能用的资产与威胁清单',
      '把公网暴露面收敛到"只剩必要端口"',
      '出了安全事件时知道前 60 分钟做什么',
    ],
  },
  {
    id: 'troubleshooting',
    name: '故障排查实战：从现象到根因',
    en: 'TROUBLESHOOTING',
    tag: '排障',
    desc: '不背命令清单，讲方法。从"先分层再缩小"的框架开始，一路练到系统层、网络层、应用与依赖层，最后落到"是什么变了"和"复盘怎么防再发"。',
    icon: 'search',
    accent: '#7aa2f7',
    can: [
      '看到一个故障先判断它在哪一层',
      '用二分与抓包把范围缩到具体一段',
      '把一次故障变成能复用的 runbook 与案例',
    ],
  },
  {
    id: 'cloud-native',
    name: '云原生交付：从镜像到 GitOps',
    en: 'CLOUD NATIVE DELIVERY',
    tag: '云原生',
    desc: '不堆概念。先讲清云原生到底解决什么问题，再落到镜像工程化、能上生产的 Deployment、流量入口、GitOps 交付与容量核算，每一步都配可落地的配置。',
    icon: 'cloud',
    accent: '#4dd0e1',
    can: [
      '做出小、快、可追溯、非 root 的镜像',
      '把 Deployment 配到"发布不掉容量、回滚有路"',
      '用 GitOps 把变更纳入 review 与回滚',
    ],
  },
  {
    id: 'network-advanced',
    name: '网络进阶：从会用到会设计',
    en: 'NETWORK IN PRACTICE',
    tag: '网络进阶',
    desc: '在会用 ping 和 curl 之后往下走一层。先讲二层与 VLAN，再讲路由与边界，然后用抓包把"不通"变成证据，最后落到一张小型网络该怎么规划。',
    icon: 'network',
    accent: '#5eb0ff',
    can: [
      '能画清一张网络：网段、VLAN、出口与回程',
      '面对"不通"能按层缩小到具体一跳',
      '能独立规划一个小机房或办公网',
    ],
  },
  {
    id: 'k8s-ops',
    name: 'K8s 运维进阶：把它当生产系统来养',
    en: 'KUBERNETES IN PRODUCTION',
    tag: 'K8s 运维',
    desc: '集群跑起来只是开始。这门课讲调度与探针怎么配、升级怎么不翻车、网络与存储怎么排、节点挂了怎么救、安全边界怎么划，全部按"生产"而非"演示"来写。',
    icon: 'container',
    accent: '#8b7cf6',
    can: [
      '能把 Deployment 的探针、调度与资源配到"发布不掉容量"',
      '能独立完成一次不跨版本、可回退的集群升级',
      '面对节点/网络/存储故障有一套自己的排查顺序',
    ],
  },
];

export const COURSE_MAP = new Map(COURSES.map((c) => [c.id, c]));
export const courseById = (id: string) => COURSE_MAP.get(id);
