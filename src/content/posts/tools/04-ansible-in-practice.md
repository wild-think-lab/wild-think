---
title: Ansible 实战：从 inventory 到可复用的 role
description: 谁该用 Ansible、目录怎么排、幂等三条纪律、模板与变量优先级、批量执行的并发控制，以及"跑一半失败"怎么收场。
date: 2022-03-16
tags: [Ansible, 自动化, 配置管理, 运维]
---

### Ansible 的定位

- 只管"机器里面"（包、文件、服务、用户）。
- **无 agent**，靠 SSH，这点决定了它适合"临时接管存量机器"。
- 与 Terraform 的分工：Terraform 建机器，Ansible 配机器。

不适合：需要秒级响应的编排、需要强事务的多机协同。这类交给 K8s Operator 或专门工具。

### 目录怎么排

```
ansible/
├── ansible.cfg
├── inventories/
│   ├── prod/hosts.yml
│   └── prod/group_vars/all.yml
├── playbooks/
│   ├── site.yml
│   └── rotate-certs.yml
└── roles/
    ├── common/
    │   ├── defaults/main.yml
    │   ├── tasks/main.yml
    │   ├── handlers/main.yml
    │   └── templates/sshd_config.j2
    └── nginx/
```

`ansible.cfg` 几行就够：

```ini
[defaults]
inventory = inventories/prod/hosts.yml
roles_path = roles
host_key_checking = False
interpreter_python = auto_silent
forks = 20
stdout_callback = yaml
```

`forks` 默认是 5，20 台机器要跑 4 轮。改到 20（不超过目标机的承受能力）能快数倍。

### inventory 与变量分层

```yaml
# inventories/prod/hosts.yml
all:
  children:
    web:
      hosts:
        web[01:03].corp.local:
      vars:
        nginx_worker: 4
    db:
      hosts:
        db01.corp.local:
  vars:
    ansible_user: ops
    ansible_ssh_private_key_file: ~/.ssh/id_ed25519
```

变量优先级（从低到高，记住后半段就够）：

```
role defaults → inventory group_vars → inventory host_vars
→ playbook vars → role vars → extra-vars (-e)
```

`-e` 最高，用来临时覆盖；`defaults` 最低，是可被覆盖的"合理默认值"。**把可调参数放 defaults，把不该被覆盖的放 vars。**

### 幂等三条纪律

1. 用模块，不用 `command`/`shell`。模块自带幂等，`shell` 每次都会执行。
2. 非用不可时，加 `creates`/`changed_when`：

```yaml
- name: 初始化数据库（只执行一次）
  command: /usr/local/bin/db-init
  args:
    creates: /var/lib/app/.initialized
  changed_when: false
```

3. `notify` 只触发需要重载的 handler，不要"每次都 restart"。

```yaml
- name: 部署 nginx 配置
  template:
    src: nginx.conf.j2
    dest: /etc/nginx/nginx.conf
    owner: root
    mode: '0644'
    validate: 'nginx -t -c %s'
  notify: reload nginx

handlers:
  - name: reload nginx
    service:
      name: nginx
      state: reloaded
```

`validate` 是关键：配置写错了在**替换前**就报错，不会把线上 nginx 弄挂。

### 一个能复用的 role

```yaml
# roles/common/tasks/main.yml
- name: 基础包
  package:
    name: "{{ common_packages }}"
    state: present

- name: 时区
  timezone:
    name: "{{ common_timezone }}"

- name: 系统限制
  copy:
    dest: /etc/security/limits.d/99-app.conf
    content: |
      * soft nofile {{ common_nofile }}
      * hard nofile {{ common_nofile }}

- name: 创建运维账号
  user:
    name: "{{ ops_user }}"
    groups: wheel
    shell: /bin/bash
    create_home: yes
    password: "{{ ops_password_hash }}"

- name: 下发公钥
  authorized_key:
    user: "{{ ops_user }}"
    key: "{{ lookup('file', 'files/ops.pub') }}"
```

配合 `defaults/main.yml`：

```yaml
common_packages: [vim, curl, rsync, chrony, lsof, tcpdump]
common_timezone: Asia/Shanghai
common_nofile: 65535
ops_user: ops
ops_password_hash: "{{ vault_ops_password_hash }}"
```

密码用 `ansible-vault`：

```bash
ansible-vault create group_vars/prod/vault.yml
ansible-vault edit group_vars/prod/vault.yml
ansible-playbook site.yml --ask-vault-pass
```

### 批量执行与并发

```bash
ansible all -m ping
ansible web -m shell -a 'systemctl is-active nginx' -f 20
ansible-playbook site.yml --limit web01 --check --diff     # 预演
ansible-playbook site.yml --tags nginx                     # 只跑部分
ansible-playbook site.yml --start-at-task 'restart nginx'   # 从某步接续
```

`--check --diff` 是安全网：先看会改什么，再真跑。**改生产之前必须跑一次。**

### "跑一半失败"怎么收场

失败通常是这几类：

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| `UNREACHABLE` | SSH 不通、sudo 密码没配 | 先 `ansible host -m ping` |
| `Missing sudo password` | 需要 `-K` 或配 NOPASSWD | playbook 里 `become: yes` + `--ask-become-pass` |
| 卡在 `Gathering Facts` | 目标机 python 缺失/版本低 | `gather_facts: no` 或装 python3 |
| 部分机器成功部分失败 | 分组串行 | `serial: 1` 或 `max_fail_percentage` |

```yaml
- hosts: web
  serial: 2                  # 每次只动 2 台，滚动更新
  max_fail_percentage: 0     # 有一台失败就停
  become: yes
  roles:
    - nginx
```

滚动 + 失败即停，是"批量改生产"的默认姿势。

### 与容器化的关系

Ansible 管"机器"，镜像管"应用运行环境"。两者不冲突，但**不要用 Ansible 去配容器内部**——那等于放弃镜像的可复现性。常见分工：

- 基础镜像与 AMI 用 Packer/Ansible 做镜像烘焙；
- 集群节点用 Ansible 做初始化；
- 应用全部走容器 + GitOps。

### 一句话总结

Ansible 的价值是"把一次性操作变成可重复、可审计的代码"，纪律只有三条：**用模块、写 validate、先 `--check`**。
