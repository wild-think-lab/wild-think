---
title: Ansible 速查
summary: 临时命令、playbook 骨架、常用模块、变量与 vault、tags 与 check 模式、批量执行的并发与限流，现场照抄用。
group: 自动化
order: 10
tags: [Ansible, 自动化, 运维]
---

## 临时命令（ad-hoc）

```bash
ansible all -m ping
ansible web -m shell -a 'systemctl is-active nginx' -f 10
ansible all -m setup -a 'filter=ansible_distribution*'
ansible db -m command -a 'df -h' -b              # -b = become(sudo)
ansible all -m copy -a 'src=./motd dest=/etc/motd mode=0644' -b
```

只跑一次的小事用 ad-hoc，重复的事写成 playbook。

## playbook 骨架

```yaml
- name: 部署 nginx
  hosts: web
  become: yes
  serial: 2                    # 每次 2 台，滚动
  max_fail_percentage: 0
  vars:
    nginx_port: 8080
  tasks:
    - name: 安装
      package: { name: nginx, state: present }
    - name: 配置
      template:
        src: nginx.conf.j2
        dest: /etc/nginx/nginx.conf
        validate: 'nginx -t -c %s'
      notify: reload nginx
    - name: 启动
      service: { name: nginx, state: started, enabled: yes }
  handlers:
    - name: reload nginx
      service: { name: nginx, state: reloaded }
```

## 常用模块

| 目的 | 模块 | 关键参数 |
| --- | --- | --- |
| 装包 | `package` / `apt` / `yum` | `name`、`state` |
| 服务 | `service` / `systemd` | `state`、`enabled`、`daemon_reload` |
| 文件 | `copy` / `template` | `src`、`dest`、`mode`、`validate` |
| 目录 | `file` | `state: directory`、`mode` |
| 用户 | `user` | `groups`、`shell`、`password` |
| 公钥 | `authorized_key` | `user`、`key` |
| 下载 | `get_url` | `url`、`dest`、`checksum` |
| 拉代码 | `git` | `repo`、`version`、`dest` |
| 定时 | `cron` | `name`、`minute`、`job`、`state` |
| 防火墙 | `firewalld` / `ufw` | `port`、`permanent` |
| 命令 | `command` / `shell` | 加 `creates` 保证幂等 |
| 断言 | `assert` / `fail` | `that`、`msg` |

`command` 不过 shell（无管道、无重定向）；需要管道就用 `shell`，但必须配 `creates` 或 `changed_when`。

## 变量优先级（从低到高）

```
role defaults → inventory group_vars → inventory host_vars
→ playbook vars → role vars → set_fact → extra-vars(-e)
```

- 可覆盖的默认值放 `defaults/main.yml`
- 不该被改的放 `vars/main.yml`
- 临时覆盖用 `-e`

## 加密

```bash
ansible-vault create group_vars/prod/vault.yml
ansible-vault edit group_vars/prod/vault.yml
ansible-vault encrypt_string 'secret' --name 'db_password'
ansible-playbook site.yml --ask-vault-pass
ansible-playbook site.yml --vault-password-file .vault_pass
```

`.vault_pass` 必须进 `.gitignore`。

## 控制执行范围

```bash
ansible-playbook site.yml --limit web01
ansible-playbook site.yml --tags nginx
ansible-playbook site.yml --skip-tags slow
ansible-playbook site.yml --start-at-task 'reload nginx'
ansible-playbook site.yml --check --diff            # 预演，必做
ansible-playbook site.yml -e nginx_port=9090
```

## 循环与条件

```yaml
- name: 创建多个目录
  file:
    path: "{{ item }}"
    state: directory
    mode: '0755'
  loop:
    - /data/app
    - /data/logs
    - /data/tmp

- name: 只在 CentOS 上执行
  yum: { name: epel-release, state: present }
  when: ansible_distribution == 'CentOS'

- name: 等待端口
  wait_for: { port: 8080, timeout: 30 }
```

`loop` 里用 `{{ item }}`，别用老的 `with_items`（虽仍可用）。

## 提速

```ini
# ansible.cfg
[defaults]
forks = 20                  # 默认 5
gathering = smart
fact_caching = jsonfile
fact_caching_connection = /tmp/ansible_facts
fact_caching_timeout = 3600
```

```yaml
- hosts: web
  gather_facts: no          # 不需要 facts 时关掉，省 2–5 秒/台
```

`pipelining = True` 能再快一截（要求目标机 `requiretty` 关闭）。

## 失败处理

```yaml
- name: 可能失败的命令
  command: /opt/app/healthcheck
  register: hc
  failed_when: hc.rc not in [0, 2]
  ignore_errors: yes
  retries: 3
  delay: 5
  until: hc.rc == 0
```

`ignore_errors` 少用——真正的错误被吞掉比失败更危险。

## 排障

```bash
ansible-playbook site.yml -vvv
ansible host -m ping -vvv
ansible-inventory --graph
ansible-doc -l | grep -i user
ansible-doc copy | head -40
```

`ansible-inventory --graph` 能立刻看出变量挂在哪个组上，是"变量没生效"的最快排查手段。
