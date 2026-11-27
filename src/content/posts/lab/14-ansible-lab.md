---
title: 实验报告：用 Ansible 批量部署 10 台 Web 节点
description: 目的/环境/原理/步骤/验证/注意/总结/附录，一份可以直接照着做完的实验。
date: 2026-11-27
tags: [实验, Ansible, 自动化]
---

### 一、实验目的

```
① 掌握 inventory 分组与变量
② 掌握 role 结构（tasks/handlers/templates/defaults）
③ 验证"幂等"：第二次执行不应产生变更
④ 掌握"分批执行"与"失败容忍"
```

### 二、实验环境

| 项 | 值 |
| --- | --- |
| 控制节点 | 1 台（Rocky 9，2C4G） |
| 被控节点 | 10 台（Rocky 9，2C2G） |
| 网络 | 10.0.1.0/24 |
| 版本 | ansible-core 2.15 |

**前置**：

```bash
dnf install -y ansible-core
ansible --version
```

**免密**：

```bash
ssh-keygen -t ed25519 -N '' -f ~/.ssh/id_ed25519
for i in $(seq 1 10); do ssh-copy-id root@10.0.1.$i; done
```

### 三、原理

```
① ansible 通过 SSH 推送"模块"到远端执行
② 模块返回 JSON（changed/failed）→ 控制端判断
③ 幂等：模块自己判断"是否已是目标状态"
④ handler：只有 changed 才触发（如重启服务）
```

**"幂等"是 Ansible 与"一堆 shell 脚本"的核心差别**。

### 四、实验步骤

**1）目录结构**

```
ansible-lab/
├── ansible.cfg
├── inventory/hosts
├── site.yml
└── roles/web/
    ├── tasks/main.yml
    ├── handlers/main.yml
    ├── templates/vhost.conf.j2
    └── defaults/main.yml
```

**2）ansible.cfg**

```ini
[defaults]
inventory = ./inventory/hosts
host_key_checking = False
forks = 10
stdout_callback = yaml
```

**3）inventory**

```ini
[web]
web[01:10].lab ansible_host=10.0.1.[1:10]

[web:vars]
ansible_user=root
http_port=8080
```

**4）role 的 tasks**

```yaml
# roles/web/tasks/main.yml
- name: install packages
  ansible.builtin.dnf:
    name: [httpd, firewalld]
    state: present

- name: start services
  ansible.builtin.service:
    name: "{{ item }}"
    state: started
    enabled: true
  loop: [httpd, firewalld]

- name: open port
  ansible.posix.firewalld:
    port: "{{ http_port }}/tcp"
    permanent: true
    state: enabled
    immediate: true

- name: render vhost
  ansible.builtin.template:
    src: vhost.conf.j2
    dest: /etc/httpd/conf.d/vhost.conf
    mode: "0644"
  notify: restart httpd
```

**5）模板**

```jinja
Listen {{ http_port }}
<VirtualHost *:{{ http_port }}>
    DocumentRoot /var/www/html
    ServerName {{ inventory_hostname }}
</VirtualHost>
```

**6）handlers**

```yaml
- name: restart httpd
  ansible.builtin.service:
    name: httpd
    state: restarted
```

**7）defaults**

```yaml
http_port: 8080
```

**8）site.yml**

```yaml
- name: deploy web
  hosts: web
  become: true
  roles:
  - web
```

**9）执行**

```bash
ansible all -m ping
ansible-playbook site.yml --check
ansible-playbook site.yml
```

### 五、验证

**1）幂等验证（关键）**

```bash
ansible-playbook site.yml
# 第二次执行应显示 changed=0
```

**2）端口验证**

```bash
for i in $(seq 1 10); do
  curl -s -o /dev/null -w "10.0.1.$i → %{http_code}\n" http://10.0.1.$i:8080/
done
```

**3）防火墙验证**

```bash
ansible web -m shell -a "firewall-cmd --list-ports"
```

**4）handler 验证**

```bash
# 改模板里的 ServerName，再跑一次
# 观察 httpd 是否重启（且只重启一次）
ansible web -m shell -a "systemctl show httpd -p ActiveEnterTimestamp"
```

### 六、注意

```
① 第一次跑之前用 --check 预演
② 改模板后要确认 handler 被触发（且不重复触发）
③ forks 不要超过被控节点数太多（避免 SSH 风暴）
④ 失败容忍：serial + max_fail_percentage
```

**分批执行**：

```yaml
- hosts: web
  serial: 2
  max_fail_percentage: 50
```

**"一次全量执行 100 台"** 出错时影响面巨大。

### 七、总结

```
① role 结构让配置可复用
② 幂等是"可反复执行"的前提
③ handler 让"只在必要时重启"
④ serial 让失败可控
```

**"第二次执行 changed=0"** 是 role 写对了的标志。

### 八、附录：常见报错

| 报错 | 原因 |
| --- | --- |
| MODULE FAILURE | 被控端没有 python3 |
| UNREACHABLE | SSH 不通/密钥未分发 |
| Permission denied | 未加 become |
| "has no attribute" | 模块参数写错（拼写/缩进） |
| handler 没触发 | 模板内容未变（幂等正确行为） |
