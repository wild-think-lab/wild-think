---
title: 大文件传输：跨机房搬 1TB 数据的四种方式
description: rsync、scp/sftp、对象存储中继、专线/快递硬盘的适用场景与实测速度，以及"断点续传""校验一致"的具体做法。
date: 2024-06-07
tags: [传输, rsync, 备份, 运维]
---

### 四种方式

| 方式 | 适用 | 1TB 跨千兆网耗时 |
| --- | --- | --- |
| rsync（增量+续传） | **首选**，可断点、可校验 | 约 3–4 小时（100MB/s） |
| scp / sftp | 少量文件、简单场景 | 类似，但断了要从头 |
| 对象存储中继 | 跨云、无法直连 | 取决于带宽与费用 |
| 快递硬盘 | 超大容量、跨地域 | 1–3 天（物理） |

### rsync：为什么它是首选

```bash
rsync -avz --partial --progress --checksum \
  -e 'ssh -p 22' /data/ user@dst:/data/
```

参数含义：

| 参数 | 作用 |
| --- | --- |
| `-a` | 归档模式（递归 + 保留权限/时间/链接） |
| `-v` | 显示详情 |
| `-z` | 传输压缩（文本类收益大，已压缩文件无收益） |
| `--partial` | **断了保留已传部分，下次接着传** |
| `--progress` | 进度 |
| `--checksum` | 按校验和比较（慢但可靠，默认按大小+时间） |

**大文件断点续传的关键是 `--partial` + 再来一次同样的命令**。

**提速选项**（大文件、高延迟链路）：

```bash
rsync -av --partial \
  --inplace \
  -e 'ssh -T -c aes128-gcm@openssh.com -o Compression=no' \
  /data/big.iso user@dst:/data/
```

- `--inplace`：直接写目标文件（省一次临时文件复制，但中断后目标文件可能不完整）。
- 换更快的加密算法（`aes128-gcm` 比默认快）。
- 关掉 SSH 压缩（已压缩数据压缩无用还耗 CPU）。

**多线程 rsync**：rsync 本身单线程，可以按目录分片并行：

```bash
for d in /data/part*; do
  rsync -av --partial "$d" user@dst:/data/ &
done
wait
```

注意：**并行数不要超过带宽或磁盘能承受的量**，一般 3–6 个。

### scp / sftp

```bash
scp -r /data/dir user@dst:/data/
sftp user@dst
# put -r /data/dir
```

缺点：**断了要从头传**。1TB 传 3 小时断了重来，代价太大。只在文件小、网络稳时用。

`sftp` 有个隐藏优点：能 `reget`（续传）：

```bash
sftp> reget big.iso
```

### 对象存储中继

场景：两台机器不在同一网络，但都能访问对象存储（OSS/S3）。

```bash
# 上传到对象存储（分片上传，可续传）
aws s3 cp /data/big.tar s3://bucket/tmp/ --storage-class STANDARD

# 另一端下载
aws s3 cp s3://bucket/tmp/big.tar /data/
```

优点：走的是"到云的高带宽"，通常比跨机房直连快。

成本提醒：**1TB 上传免费，下载出流量费可能几百元**。跨云还要算两边的流量。

### 快递硬盘

**当数据量 > 10TB 或带宽 < 10Mbps 时，快递硬盘往往更快**：

```
1TB 数据：
  10Mbps 专线 → 约 10 天
  快递硬盘 → 1–2 天
```

做法：

1. 硬盘做全盘加密（LUKS/BitLocker）。
2. 记录校验和（`sha256sum` 清单）。
3. 到岸后校验，不一致的重新传。

### 校验一致性的三种做法

**① 传后对比校验和**

```bash
# 源端
find /data -type f -exec sha256sum {} + > /tmp/src.sha256
# 目标端
find /data -type f -exec sha256sum {} + > /tmp/dst.sha256
# 对比（路径不同要先统一）
diff <(awk '{print $1}' /tmp/src.sha256 | sort) <(awk '{print $1}' /tmp/dst.sha256 | sort)
```

**② rsync 的 `--checksum`**

逐文件按内容比对，可靠但慢（要读全部数据）。

**③ 抽查 + 抽样**

TB 级数据全量校验要读一遍盘（几小时）。折中：**全量比对文件大小与数量，再抽查 10% 的内容校验和**。

### 传输过程中的性能瓶颈

```
① 网络带宽（最常见）
② SSH 加密 CPU（老 CPU 上 aes 会成为瓶颈）
③ 磁盘 IO（源端读、目标端写）
④ 单线程（rsync 单个大文件只能用一核）
```

判断方法：

```bash
# 传输时看
iftop -i eth0          # 网络是否跑满
top                    # 是否有单核 100%（ssh 加密）
iostat -x 1            # 磁盘 util
```

**千兆网实测上限约 110MB/s**，如果只跑到 30MB/s，瓶颈多半在磁盘或加密。

### 跨机房传输的稳定技巧

```bash
# 用 screen/tmux 挂着，防 SSH 断开
tmux new -s xfer
rsync -av --partial /data/ user@dst:/data/
# Ctrl+B D 脱离

# 加超时与重试（写个循环）
for i in $(seq 1 10); do
  rsync -av --partial --timeout=300 /data/ user@dst:/data/ && break
  echo "retry $i"; sleep 60
done
```

`--timeout=300`：300 秒无数据就断开重试（避免卡死）。

### 检查清单

```
□ 大文件用 rsync --partial，不用 scp
□ 跨地域先测带宽，估算耗时
□ 用 tmux 挂着，断开不影响
□ 有重试循环（网络抖动必现）
□ 传完做校验（至少抽样）
□ > 10TB 考虑快递硬盘 + 全盘加密
□ 对象存储中继注意出流量费用
```
