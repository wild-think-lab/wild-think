---
title: RHCE 备考笔记：那些"考试要考、工作常用"的操作
description: ansible 常用模块、playbook 结构、变量与模板、以及五个考试/实战都容易踩的坑。
date: 2023-10-20
tags: [Linux, RHCE, Ansible, 认证]
---

### 考试范围的两块

```
RHCSA：本机管理（用户、权限、存储、网络、服务、SELinux）
RHCE ：Ansible 自动化（inventory、playbook、roles、变量、模板）
```

**"RHCE 不考 Ansible 之外的深水区"**，但基础必须扎实。

### inventory 的最小写法

```ini
[web]
web1.example.com
web2.example.com

[db]
db1.example.com ansible_user=root

[all:vars]
ansible_python_interpreter=/usr/bin/python3
```

**YAML 格式**：

```yaml
all:
  children:
    web:
      hosts:
        web1:
        web2:
  vars:
    ansible_user: root
```

**`ansible_python_interpreter`** 是老版本镜像必配项（Python 路径不一致会导致"什么都失败"）。

### 三个必会的命令

```bash
ansible all -m ping                      # 连通性
ansible-playbook site.yml --check        # 预演
ansible-playbook site.yml -v             # 详细输出
```

**`--check`（dry run）** 是考试与实战都该先跑的一步。

### 十个高频模块

```yaml
- name: 装包
  ansible.builtin.dnf:
    name: httpd
    state: present

- name: 起服务
  ansible.builtin.service:
    name: httpd
    state: started
    enabled: true

- name: 复制文件
  ansible.builtin.copy:
    src: files/httpd.conf
    dest: /etc/httpd/conf/httpd.conf
    owner: root
    mode: "0644"

- name: 模板渲染
  ansible.builtin.template:
    src: templates/vhost.conf.j2
    dest: /etc/httpd/conf.d/vhost.conf

- name: 建用户
  ansible.builtin.user:
    name: deploy
    shell: /bin/bash
    groups: wheel

- name: 目录
  ansible.builtin.file:
    path: /data/app
    state: directory
    mode: "0755"

- name: 防火墙
  ansible.posix.firewalld:
    service: http
    permanent: true
    state: enabled
    immediate: true

- name: SELinux 布尔
  ansible.posix.seboolean:
    name: httpd_can_network_connect
    state: true
    persistent: true

- name: 挂载
  ansible.posix.mount:
    path: /data
    src: /dev/vg0/lv0
    fstype: xfs
    state: mounted

- name: 执行命令（尽量少用）
  ansible.builtin.command:
    cmd: /usr/local/bin/setup.sh
    creates: /var/lib/setup.done
```

**`creates`** 让命令"幂等"（文件存在就跳过）。

**"滥用 command/shell"** 是考试扣分点（不幂等）。

### playbook 结构

```yaml
- name: configure web
  hosts: web
  become: true
  vars:
    port: 8080
  tasks:
  - name: install
    ansible.builtin.dnf:
      name: httpd
      state: present
  handlers:
  - name: restart httpd
    ansible.builtin.service:
      name: httpd
      state: restarted
```

**handlers 的语义**：

```
只有 `notify` 且"任务真的改变了"才触发
→ 幂等执行第二次不会重启服务（这是优点）
```

### 变量优先级（重点）

```
命令行 -e  >  playbook vars  >  inventory 变量  >  role defaults
```

**考试技巧**：

```
用 -e 传"必须覆盖"的值（如目标端口）
用 defaults 放"可被覆盖的默认值"
```

### 模板（Jinja2）

```jinja
Listen {{ http_port }}
{% for vhost in vhosts %}
<VirtualHost *:{{ http_port }}>
    ServerName {{ vhost.name }}
</VirtualHost>
{% endfor %}
```

**常用过滤器**：

```jinja
{{ users | default([]) | join(',') }}
{{ path | basename }}
{{ item | upper }}
```

### roles 目录结构

```
roles/
└── web/
    ├── tasks/main.yml
    ├── handlers/main.yml
    ├── templates/
    ├── files/
    ├── vars/main.yml
    └── defaults/main.yml
```

```yaml
- hosts: web
  roles:
  - web
```

**`defaults` 与 `vars` 的区别**：

```
defaults：优先级最低（可被覆盖）
vars    ：优先级很高（几乎覆盖一切，除了 -e）
```

### 五个考试/实战都容易踩的坑

**① 忘了 become**

```
改系统配置需要 root
→ 加 `become: true`（或命令行 -b）
```

**② 模块名写简写**

```
yum: 能工作但会警告 → 写 ansible.builtin.dnf
```

**③ 引号与数字**

```yaml
mode: 0644        # YAML 会当八进制？
mode: "0644"      # 正确（字符串）
```

**"mode 不加引号"可能导致权限不对**。

**④ 没设 Python 解释器**

```
老镜像没装 python → "MODULE FAILURE"
```

**⑤ 忘了 firewalld 的 `immediate`**

```
permanent: true 但没有 immediate → 当前不生效（要 reload）
```

### 一个"完整"的练习 playbook

```yaml
- name: web server setup
  hosts: web
  become: true
  vars:
    http_port: 8080
    vhosts:
    - { name: app1, path: /var/www/app1 }
    - { name: app2, path: /var/www/app2 }
  tasks:
  - name: install httpd
    ansible.builtin.dnf: { name: [httpd, firewalld], state: present }

  - name: start services
    ansible.builtin.service: { name: "{{ item }}", state: started, enabled: true }
    loop: [httpd, firewalld]

  - name: open port
    ansible.posix.firewalld:
      port: "{{ http_port }}/tcp"
      permanent: true
      state: enabled
      immediate: true

  - name: create vhost dirs
    ansible.builtin.file:
      path: "{{ item.path }}"
      state: directory
      mode: "0755"
    loop: "{{ vhosts }}"

  - name: render vhost config
    ansible.builtin.template:
      src: vhosts.conf.j2
      dest: /etc/httpd/conf.d/vhosts.conf
    notify: restart httpd

  handlers:
  - name: restart httpd
    ansible.builtin.service: { name: httpd, state: restarted }
```

### 检查清单

```
□ inventory 分好组 + 设 python 解释器
□ 先 `-m ping` 验证连通
□ 先 `--check` 预演
□ 优先用模块（少用 command/shell）
□ command 用 creates/removes 做幂等
□ 用 handlers 触发重启（不硬写 restart）
□ 变量优先级清楚（-e > vars > inventory > defaults）
□ mode 用字符串加引号
□ firewalld 用 permanent + immediate
□ 配置好 become（或 -b）
□ roles 结构规范（tasks/handlers/templates/defaults）
```
