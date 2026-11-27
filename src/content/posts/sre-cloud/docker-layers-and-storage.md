---
title: 镜像分层、写时复制与存储驱动：为什么容器磁盘会悄悄涨
description: 从镜像分层理解容器的读写机制，再解释 overlay2 下"删了文件反而更占空间"、磁盘持续增长的真实原因与治理手段。
date: 2026-01-11
tags: [Docker, 容器, 镜像分层, overlay2, 云原生]
---

容器不是虚拟机，没有独立的磁盘镜像。它共享内核，用**联合挂载**把若干只读层叠成一份可写视图。理解了这一层，很多"玄学"问题就解释得通。

## 一、镜像 = 只读层的叠加

`Dockerfile` 的每条 `RUN`、`COPY`、`ADD` 都会产生新的一层。层是**只读且可复用**的：两个镜像共享同一个基础层时，磁盘上只有一份。

```
alpine:3.19                     ← 基础层
├─ RUN apk add curl             ← 层 2：安装的包
├─ COPY app.jar /app/           ← 层 3：应用文件
└─ CMD ["java","-jar","/app/app.jar"]
```

```bash
docker history --no-trunc <image>     # 每层大小与创建指令
docker image inspect <image> --format '{{.RootFS.Layers}}'
```

所以**指令顺序决定缓存命中与体积**：把变化频繁的 `COPY 源码` 放在安装依赖之后，依赖层就能复用缓存，构建更快、镜像更小。

## 二、容器层是写时复制（CoW）

容器启动时在最上面加一个**可写层**。读文件时从下往上找；写文件时：

- 文件在下层只读层 → 先把整个文件**复制到可写层**，再修改（copy-up）
- 文件已在可写层 → 直接改

这带来两个后果：

1. **修改大文件代价高**：改 1 字节也要复制整个文件。
2. **删除不是真删**：在下层删除文件，只是在上层写一个"白障（whiteout）"标记，下层那块空间**依然被镜像层占用**。

```bash
# 典型反例：临时下载大文件又删掉，镜像照样变大
RUN curl -o /tmp/big.tar.gz http://... && tar -xzf /tmp/big.tar.gz -C /opt && rm /tmp/big.tar.gz
```

正确做法是**同一层内完成下载、使用、清理**（如上，因为写在同一 `RUN` 里，白障不产生新块）。或者用多阶段构建，把中间产物留在 builder 阶段。

## 三、磁盘持续增长的六个来源

```bash
docker system df -v          # 镜像/容器/卷/构建缓存各自占用
du -sh /var/lib/docker/*     # 目录级实际占用
```

1. **停止但未删除的容器**：可写层仍在。`docker ps -a` 里一堆 Exited 就是它。
2. **悬空镜像（dangling）**：`<none>:<none>`，多为重建同名镜像产生。
3. **构建缓存**：`docker builder prune` 可清，默认保留量很大。
4. **匿名卷**：`docker run -v /data` 会创建匿名卷，容器删了卷还在。
5. **容器日志**：`*-json.log` 默认无上限，这是最常见的"夜里磁盘满"。
6. **overlay2 目录碎片**：大量小层导致 inode 与目录项开销。

治理命令（按风险从低到高）：

```bash
docker image prune -f                    # 悬空镜像
docker container prune -f                # 已停止容器
docker volume prune -f                   # 未使用的匿名卷（先确认没有数据）
docker builder prune --filter until=72h  # 构建缓存
docker system prune -a --volumes         # 慎用：会删所有未使用对象
```

日志限额写进 `/etc/docker/daemon.json`（需重启 dockerd）：

```json
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "50m", "max-file": "3" }
}
```

## 四、存储驱动对比（overlay2 为什么是默认）

| 驱动 | 原理 | 适用 | 局限 |
| --- | --- | --- | --- |
| overlay2 | 联合挂载，多层目录叠加 | 绝大多数 Linux 生产环境 | 层数过多时性能下降，inode 消耗高 |
| btrfs / zfs | 快照式 | 需要快照/配额能力 | 内存占用高，稳定性依赖文件系统成熟度 |
| devicemapper | 块设备 thin pool | 老环境 | 已逐步弃用，pool 满会导致容器全挂 |
| vfs | 每层完整复制 | 测试、特殊文件系统 | 极慢、极占空间，**不要用于生产** |

查看当前驱动：`docker info | grep -i storage`。

## 五、实践约定

- 基础镜像用最小化版本（`alpine`、`distroless`），减少层数与攻击面。
- 一个 `RUN` 里完成"装—用—清"，避免白障残留。
- 用多阶段构建把编译工具链留在 builder 阶段。
- 业务数据一律走 volume 或 bind mount，**不要写容器可写层**（容器重建即丢）。
- 给 `/var/lib/docker` 单独分区或独立盘，避免容器把系统盘写满导致整机异常。

> 一句话：**容器的"磁盘"是叠出来的，不是分出来的。删除不代表释放，复制不代表新增——只有理解 CoW，才知道空间到底去哪了。**
