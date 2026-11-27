---
title: 部署对象存储：MinIO 单机与分布式
module: 进阶篇
summary: S3 兼容对象存储的部署、桶与策略、mc 客户端、容量与生命周期，五个"存进去取不出来"的原因。
minutes: 50
---

### 为什么自建对象存储

```
① 备份/日志归档需要便宜的大容量
② 应用要 S3 接口（不想被云厂商绑死）
③ 图片/附件/模型文件独立于数据库
```

**"文件存数据库"** → 库变大、备份变慢、并发差。

### 单机部署（容器）

```bash
docker run -d --name minio \
  -p 9000:9000 -p 9001:9001 \
  -e MINIO_ROOT_USER=admin \
  -e MINIO_ROOT_PASSWORD='<强密码>' \
  -v /data/minio:/data \
  -v /etc/localtime:/etc/localtime:ro \
  quay.io/minio/minio server /data --console-address ":9001"
```

**要点**：

```
① 数据目录必须挂出来
② 9000 是 API，9001 是控制台
③ 单机就是单点，重要数据要异地
```

### 分布式（纠删码）

```bash
minio server http://node{1...4}/data{1...2}
```

```
① 至少 4 节点（纠删码需要）
② 各节点盘数一致，容量一致
③ 用 DNS/主机名，不要用会变的 IP
```

**判据**：N 节点可容忍 N/2 节点故障（视配置）。

### 桶与策略

```bash
mc alias set local http://127.0.0.1:9000 admin '<pwd>'
mc mb local/backup
mc anonymous set none local/backup      # 禁止匿名
```

```bash
# 生命周期：30 天后自动删除
mc ilm rule add local/backup --expire-days 30
mc ilm rule ls local/backup
```

**"桶设成 public"** → 全网可下载，是最常见的泄密原因。

### 应用接入（S3 兼容）

```python
import boto3
s3 = boto3.client("s3", endpoint_url="http://10.0.0.30:9000",
                  aws_access_key_id="app", aws_secret_access_key="***")
s3.upload_file("a.zip", "backup", "a.zip")
```

**注意**：

```
① 用独立 access key（不用 root 账号）
② 权限按桶/前缀限定
③ 预签名 URL 给前端直传（别让文件过应用）
```

### 五个"存进去取不出来"

**① 路径/桶名写错**

```
list 看不到对象（前缀不匹配）
```

**② 权限只给了 ListBucket 没给 GetObject**

```
能看列表，下载 403
```

**③ 时钟偏差导致签名失效**

```
S3 签名对时间敏感（NTP 必须准）
```

**④ 大文件超时**

```
分片上传（multipart）或直传
```

**⑤ 磁盘满 → 写入失败但读还在**

```
监控容量水位（80% 告警）
```

### 容量与备份

```
① 逻辑备份：mc mirror 到另一个集群/云
② 版本控制：开启 object versioning（防误删）
③ 保留期与生命周期规则
```

```bash
mc mirror --overwrite local/backup remote-site/backup
```

### 检查清单

```
□ 数据目录独立挂盘
□ 控制台端口不暴露公网
□ 桶默认私有
□ 应用用独立 key + 最小权限
□ 前端用预签名直传
□ NTP 准（签名依赖时间）
□ 有容量水位告警
□ 有版本控制/防误删
□ 有异地 mirror
□ 有生命周期清理规则
```
