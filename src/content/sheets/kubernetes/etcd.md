---
title: etcd 速查
summary: 常用 etcdctl 命令、健康检查、快照与恢复、碎片整理与告警阈值。
group: kubernetes
order: 1
tags: [Kubernetes, etcd]
---

### 基本信息

```bash
export ETCDCTL_API=3
EP="https://127.0.0.1:2379"
CA="--cacert=/etc/kubernetes/pki/etcd/ca.crt"
CERT="--cert=/etc/kubernetes/pki/etcd/server.crt --key=/etc/kubernetes/pki/etcd/server.key"
```

### 健康与状态

```bash
etcdctl $EP $CA $CERT endpoint health
etcdctl $EP $CA $CERT endpoint status -w table
etcdctl $EP $CA $CERT member list -w table
```

**关注**：

```
DB SIZE      ：> 2GB 开始关注，> 4GB 谨慎
RAFT INDEX 差 ：成员间差值大 → 有成员落后
IS LEADER     ：确认 leader 存在
```

### 读写

```bash
etcdctl $EP $CA $CERT put /key value
etcdctl $EP $CA $CERT get /key
etcdctl $EP $CA $CERT get / --prefix --keys-only | head
etcdctl $EP $CA $CERT del /key
etcdctl $EP $CA $CERT watch /key
```

### 快照

```bash
etcdctl $EP $CA $CERT snapshot save /backup/etcd-$(date +%F).db
etcdctl snapshot status /backup/etcd-xxx.db -w table
```

### 恢复

```bash
systemctl stop kube-apiserver etcd
etcdctl snapshot restore /backup/etcd-xxx.db \
  --data-dir=/var/lib/etcd-restore \
  --initial-cluster-token etcd-cluster-1 \
  --initial-advertise-peer-urls https://1.1.1.1:2380 \
  --initial-cluster "etcd1=https://1.1.1.1:2380,etcd2=..."
```

**恢复后必须改 `--data-dir` 与 `etcd.yaml` 里的 `data-dir`，否则起不来。**

### 碎片整理

```bash
etcdctl $EP $CA $CERT defrag
```

**注意**：

```
defrag 会阻塞该成员（期间不可写）
→ 逐个成员做，不要同时
```

### 告警与参数

```conf
--quota-backend-bytes=8589934592   # 8GiB
--auto-compaction-retention=5h
```

**默认 quota 2GiB，超过后集群变只读**（`etcdserver: mvcc: database space exceeded`）。

### 解除"空间超出"只读

```bash
etcdctl $EP $CA $CERT compact $(etcdctl endpoint status --write-out=json | jq '.[0].Status.header.revision')
etcdctl $EP $CA $CERT defrag
etcdctl $EP $CA $CERT alarm disarm
```

### 常用排查

| 现象 | 检查 |
| --- | --- |
| apiserver 全挂 | etcd 三节点是否健康 / 是否只读 |
| 写入超时 | 磁盘 fsync 延迟（用 fio 测） |
| 成员不一致 | raft index 差 / 网络延迟 |
| DB 过大 | 是否开了自动压缩 / 是否有大量事件堆积 |

**etcd 对磁盘 fsync 极其敏感**（必须 SSD，避免与高 IO 混部）。
