---
title: 实验报告：Keepalived 双机热备从零到切换成功
description: 用两台机器 + VIP 做高可用，讲清 VRRP 原理、配置写法、健康检查脚本、脑裂与真实切换测试的完整过程。
date: 2026-11-27
tags: [实验, 高可用, Keepalived, VRRP]
---

### 一、实验目的

1. 两台 Nginx 服务器组成主备，对外提供一个 VIP。
2. 主节点故障时，VIP 自动漂移到备节点，服务不中断（< 3 秒）。
3. 验证"脑裂"现象与防范。

### 二、环境

| 角色 | 主机 | IP | 说明 |
| --- | --- | --- | --- |
| 主 | ha1 | 10.0.0.21 | PRIORITY 100 |
| 备 | ha2 | 10.0.0.22 | PRIORITY 90 |
| VIP | — | 10.0.0.200 | 对外访问地址 |

系统：Ubuntu 22.04 / CentOS 7 均可，两台都装 Nginx + Keepalived。

### 三、原理

```
VRRP（虚拟路由冗余协议）：
  多台机器组成一个"虚拟路由器"，共用一个 VIP
  通过 VRRP 通告（组播 224.0.0.18）互相探测
  优先级高的成为 MASTER，持有 VIP
  MASTER 停止发送通告 → 备机在 ~3×advert_int 秒后接管
```

关键点：**VIP 是一个"附加在网卡上的地址"**，不是真正独立的设备。切换 = 把地址从一台机器挪到另一台。

### 四、配置

**① 安装**

```bash
apt install -y nginx keepalived
systemctl enable --now nginx
```

**② ha1（主）`/etc/keepalived/keepalived.conf`**

```conf
global_defs {
    router_id HA1
    script_user root
    enable_script_security
}

vrrp_script chk_nginx {
    script "/etc/keepalived/check_nginx.sh"
    interval 2
    weight -20          # 失败时优先级 -20
    fall 2              # 连续 2 次失败判定为故障
    rise 2
}

vrrp_instance VI_1 {
    state MASTER
    interface eth0
    virtual_router_id 51
    priority 100
    advert_int 1
    authentication {
        auth_type PASS
        auth_pass SecretPass123
    }

    virtual_ipaddress {
        10.0.0.200/24 dev eth0
    }

    track_script {
        chk_nginx
    }

    notify_master "/etc/keepalived/notify.sh master"
    notify_backup "/etc/keepalived/notify.sh backup"
    notify_fault  "/etc/keepalived/notify.sh fault"
}
```

**③ ha2（备）**

同样内容，只改三处：

```
router_id HA2
state BACKUP
priority 90
```

**④ 健康检查脚本 `/etc/keepalived/check_nginx.sh`**

```bash
#!/usr/bin/env bash
# 返回 0 表示健康，非 0 表示故障
exec 9>/var/run/keepalived_check.lock
flock -n 9 || exit 0        # 防重叠

code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1/health)
[[ "$code" == "200" ]] || exit 1

# 进程也要在
pgrep -x nginx >/dev/null || exit 1
exit 0
```

```bash
chmod +x /etc/keepalived/check_nginx.sh
```

**⑤ 通知脚本（可选，但很有用）`/etc/keepalived/notify.sh`**

```bash
#!/usr/bin/env bash
case "$1" in
  master) echo "$(date) HA1 became MASTER" >> /var/log/ha.log ;;
  backup) echo "$(date) HA1 became BACKUP" >> /var/log/ha.log ;;
  fault)  echo "$(date) HA1 FAULT" >> /var/log/ha.log ;;
esac
```

**⑥ Nginx 健康页**

```nginx
location = /health {
    access_log off;
    return 200 "ok\n";
}
```

### 五、验证

**① 启动与状态**

```bash
systemctl start keepalived
ip -4 addr show eth0 | grep 10.0.0.200
journalctl -u keepalived -n 20
```

预期：ha1 上有 VIP，ha2 上没有。

**② 访问验证**

```bash
curl http://10.0.0.200/health     # 应返回 ok
curl -I http://10.0.0.200
```

**③ 故障切换测试（核心）**

```bash
# 持续探测，观察中断时长
while true; do
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 1 http://10.0.0.200/health)
  printf '%s %s\n' "$(date +%T)" "$code"
  sleep 0.5
done
```

另开窗口停 Nginx：

```bash
systemctl stop nginx
```

预期：

1. ~2–4 秒后，探测出现少量 `000`（超时）。
2. VIP 漂到 ha2，恢复 `200`。
3. `ip addr` 显示 ha2 持有 VIP。

**④ 恢复测试**

```bash
systemctl start nginx
```

主节点恢复后（`rise 2`，约 4 秒）会抢回 VIP（因为优先级高）。

**⑤ 脑裂测试（故意制造）**

```bash
# 两台都停掉对方的通告？不好模拟。
# 更简单：直接在 ha2 上手动加 VIP，模拟"双主"
ip addr add 10.0.0.200/24 dev eth0        # 在 ha2（备）上
```

现象：两台都有 VIP，客户端可能连到任意一台 → **数据不一致风险**。

防范：

```
① 交换机/防火墙层禁止两台之间隔离（保证通告可达）
② 配置 `vrrp_strict`（严格模式，拒绝不合规的通告）
③ 加仲裁：VIP 存在性检查（"如果我发现有别人也持有这个 IP，就降级"）
④ 数据库/存储层再加一层锁（如分布式锁）
```

### 六、常见问题

| 现象 | 原因 |
| --- | --- |
| 两台都没有 VIP | `virtual_router_id` 冲突（同网段其他 Keepalived 用了 51） |
| 一直在切换（flapping） | 健康检查太敏感 / 网络抖动 |
| VIP 有但访问不了 | ARP 缓存 / 交换机 MAC 表未更新 |
| 切换后新主机不响应 | 防火墙没放通，或 Nginx 未监听 0.0.0.0 |

**`virtual_router_id` 冲突**很常见：同一 VLAN 里两个 Keepalived 组用了同一个 id，会互相"打架"。**每组分配唯一 id**。

**ARP 问题**的处理：Keepalived 默认会发免费 ARP（gratuitous ARP），但某些交换机/云环境不认。云上通常不支持 VIP 漂移，需要改用云厂商的 SLB。

### 七、注意事项

1. **Keepalived 只解决"IP 层"的高可用**，不解决数据同步。数据库双主需要另做（主从复制 + 只读切换）。
2. **云环境慎用**：阿里云/腾讯云的 VPC 不支持 VIP 漂移（同一子网内 ARP 不可控），要用 SLB/CLB。
3. **切换时间**：`advert_int 1` + `fall 2` ≈ 2–3 秒。想更快就调小，但网络抖动会误切。
4. **脑裂比宕机更危险**：宁可"两台都不提供服务"，也不要"两台都提供服务"。

### 八、总结

Keepalived 的价值不是"技术复杂"，而是**把一个必须人工介入的故障变成自动的 2–3 秒切换**。

真正的难点在：
- 健康检查写得准（检查业务而不是只检查端口）。
- 脑裂有防范。
- 数据层的高可用单独设计。

### 附录：一键部署脚本（两台通用）

```bash
#!/usr/bin/env bash
set -euo pipefail
ROLE=${1:-master}
PEER_IP=${2:-10.0.0.22}

apt update && apt install -y nginx keepalived curl

cat >/etc/nginx/sites-enabled/default <<'EOF'
server {
    listen 80 default_server;
    location = /health { access_log off; return 200 "ok\n"; }
    location / { return 200 "hello from $hostname\n"; }
}
EOF
systemctl restart nginx

if [[ "$ROLE" == "master" ]]; then STATE=MASTER; PRIO=100; RID=HA1;
else STATE=BACKUP; PRIO=90; RID=HA2; fi

cat >/etc/keepalived/check_nginx.sh <<'EOF'
#!/usr/bin/env bash
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 2 http://127.0.0.1/health)
[[ "$code" == "200" ]] || exit 1
pgrep -x nginx >/dev/null || exit 1
exit 0
EOF
chmod +x /etc/keepalived/check_nginx.sh

cat >/etc/keepalived/keepalived.conf <<EOF
global_defs { router_id $RID }
vrrp_script chk_nginx {
  script "/etc/keepalived/check_nginx.sh"
  interval 2
  weight -20
  fall 2
  rise 2
}
vrrp_instance VI_1 {
  state $STATE
  interface eth0
  virtual_router_id 51
  priority $PRIO
  advert_int 1
  authentication { auth_type PASS; auth_pass SecretPass123 }
  virtual_ipaddress { 10.0.0.200/24 dev eth0 }
  track_script { chk_nginx }
}
EOF

systemctl enable --now keepalived
systemctl restart keepalived
ip -4 addr show eth0 | grep 10.0.0.200 || echo "VIP not present (expected on backup)"
```
