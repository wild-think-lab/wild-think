---
title: 网络自动化：配置模板与批量变更
module: 进阶篇
summary: 从手动 SSH 到 Netmiko/Ansible/NAPALM、配置备份与差异检查、灰度与回滚，五个"自动化把故障放大"的原因。
minutes: 50
---

### 先解决"能可靠地连上"

```python
# Netmiko 最小示例
from netmiko import ConnectHandler
dev = {"device_type": "cisco_ios", "host": "10.0.0.1",
       "username": "ops", "password": "***"}
with ConnectHandler(**dev) as conn:
    print(conn.send_command("show ip interface brief"))
```

**要点**：

```
① 连接要设超时（否则脚本挂死）
② 登录后先 enable/timeout 设置
③ 输出要结构化（textfsm/genie 解析，别用正则硬匹配）
```

### Ansible 管网络设备

```yaml
- hosts: switches
  gather_facts: false
  tasks:
    - name: backup config
      cisco.ios.ios_config:
        backup: yes
        backup_options:
          filename: "{{ inventory_hostname }}.cfg"
          dir_path: /backup/network
```

```yaml
    - name: set ntp
      cisco.ios.ios_config:
        lines:
          - ntp server 10.0.0.10
```

**为什么用它**：幂等（重复执行不重复改）、有 inventory、有日志。

### 变更流程（关键）

```
① 生成目标配置（模板 + 变量）
② 拉取当前配置，做 diff
③ 在 1 台灰度执行 + 验证
④ 批量执行（限并发，防冲击）
⑤ 验证业务（ping/端口/关键接口）
⑥ 失败回滚（用备份配置）
```

**"直接批量刷"** → 一个模板错误全网瘫痪。

### 差异检查示例

```python
import difflib, pathlib
old = pathlib.Path("old.cfg").read_text().splitlines()
new = pathlib.Path("new.cfg").read_text().splitlines()
for line in difflib.unified_diff(old, new, "old", "new", lineterm=""):
    print(line)
```

**判据**：diff 里出现意外删除行 → 停下。

### 五个"自动化把故障放大"

**① 没有 dry-run**

```
模板一处写错 → 全部设备同错
```

**② 并发太高**

```
一次性连 500 台 → 设备 CPU/登录数打满
```

**③ 没有配置备份**

```
改坏了无法回滚
```

**④ 没做验证**

```
脚本"成功"但业务已断
```

**⑤ 凭据硬编码**

```
脚本进 Git → 密码泄露
```

**用**：Ansible Vault / 环境变量 / 密钥管理。

### 一个最小可用的自动化栈

```
① inventory（含分组：核心/接入/防火墙）
② 模板（Jinja2，按角色生成）
③ 备份（每次变更前）
④ diff 审核（人工确认）
⑤ 灰度 → 批量 → 验证
⑥ 日志与变更记录（谁、何时、改了什么）
```

### 检查清单

```
□ 连接有超时与重试
□ 输出结构化解析
□ 有 inventory 与分组
□ 变更前自动备份
□ 有 diff 与人工审核
□ 先灰度 1 台
□ 并发受限
□ 变更后有业务验证
□ 有一键回滚
□ 凭据不入库（Vault/环境变量）
```
