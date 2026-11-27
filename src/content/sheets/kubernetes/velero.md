---
title: Velero 速查
summary: 备份/恢复/定时/迁移的常用命令，以及"备份了但没备到卷"的检查方法。
group: kubernetes
order: 2
tags: [Velero, 备份]
---

### 安装

```bash
velero install \
  --provider aws \
  --plugins velero/velero-plugin-for-aws:v1.9.0 \
  --bucket velero-backup \
  --secret-file ./credentials-velero \
  --use-volume-snapshots=false \
  --backup-location-config region=cn-north-1,s3ForcePathStyle="true",s3Url=http://minio:9000
```

### 备份

```bash
velero backup create <name>
velero backup create <name> --include-namespaces app
velero backup create <name> --include-volumes
velero backup create <name> --exclude-namespaces kube-system,monitoring
velero backup create <name> --include-resources deployments,configmaps,secrets
velero backup create <name> --selector team=core
```

### 查看

```bash
velero backup get
velero backup describe <name>
velero backup describe <name> --details    # 看 resource 错误
velero backup logs <name>
```

### 恢复

```bash
velero restore create --from-backup <name>
velero restore create --from-backup <name> --include-namespaces app --restore-volumes=true
velero restore create --from-backup <name> --namespace-mappings old:new
velero restore create --from-backup <name> --exclude-resources pods,deployments,services
velero restore get
velero restore describe <name> --details
```

### 定时

```bash
velero schedule create daily --schedule "0 2 * * *" --include-volumes
velero schedule get
```

**建议两条**：

```
daily-res   ：每天资源（不含卷）
weekly-full ：每周含卷
```

### 迁移到新集群

```
1) 源集群 velero backup create full --include-volumes
2) 新集群安装 velero，指向同一 bucket
3) 新集群预建 StorageClass（与源同名）
4) velero backup get 能看到备份
5) velero restore create --from-backup full
```

### 关键检查

```bash
# 备份里到底有没有卷数据
velero backup describe <name> --details | grep -i volume

# 备份存储对象数量（MinIO/S3）
mc ls -r myminio/velero-backup/backups/<name>/ | wc -l
```

### 常见问题

| 现象 | 原因 |
| --- | --- |
| restore 后 PVC Pending | StorageClass 不存在/名字不同 |
| restore 报 no matches for kind | CRD 未先恢复 |
| 卷数据为空 | 未加 `--include-volumes` 或卷类型不支持（hostPath） |
| 备份 PartiallyFailed | 某些资源权限不足/被 finalizer 卡住 |
| 备份很慢 | 卷数据量大 + 无快照（走 restic 上传） |

### 注意

```
① 备份 TTL 默认 30 天（ttl 参数可调）
② 备份存储不要与集群同故障域
③ 每月做一次恢复演练（唯一验收标准）
④ Velero 不替代 etcd snapshot
```
