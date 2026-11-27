---
title: curl 与 jq 速查
summary: 调接口、抓时间分段、走代理、上传下载、看响应头；配 jq 把 JSON 拆成人能读的样子，一行提取想要的字段。
group: 开发
order: 11
tags: [curl, jq, HTTP, 调试]
---

## 最基本的几种

```bash
curl -s https://api.example.com/health
curl -i https://api.example.com/health          # 带响应头
curl -v https://api.example.com/health          # 全过程（TLS、重定向）
curl -sS -o /dev/null -w '%{http_code}\n' https://example.com/   # 只看状态码
```

`-sS`：静默但保留错误输出。只 `-s` 时出错也一声不吭，脚本里排查很痛苦。

## 计时：慢在哪一段

```bash
curl -o /dev/null -s -w 'dns:%{time_namelookup} conn:%{time_connect} tls:%{time_appconnect} ttfb:%{time_starttransfer} total:%{time_total}\n' https://example.com/
```

判读：

- `dns` 大 → 解析慢（换 resolver，或检查 `/etc/resolv.conf`）
- `conn` - `dns` 大 → TCP 建连慢（网络/防火墙)
- `tls` - `conn` 大 → TLS 握手慢（证书链太大、要访问 OCSP）
- `ttfb` - `tls` 大 → 服务端处理慢
- `total` - `ttfb` 大 → 传输慢（响应体大、带宽）

## 请求方法与数据

```bash
curl -X POST https://api/x -H 'Content-Type: application/json' -d '{"a":1}'
curl -X POST https://api/x --data-binary @body.json
curl -X PUT https://api/x -F 'file=@./a.png' -F 'name=demo'     # multipart
curl -X DELETE https://api/x/1
curl -G https://api/x --data-urlencode 'q=中文 空格'             # GET 带参数并编码
```

`-d` 会默认 `Content-Type: application/x-www-form-urlencoded`；JSON 必须手动指定头。

## 请求头与认证

```bash
curl -H 'Authorization: Bearer $TOKEN' https://api/x
curl -u user:pass https://api/x                 # Basic
curl --cookie 'sid=abc' https://api/x
curl -H 'X-Request-Id: test-123' https://api/x
curl -A 'healthcheck/1.0' https://api/x
```

## 重定向与 TLS

```bash
curl -L https://example.com              # 跟随重定向
curl -L --max-redirs 5 https://example.com
curl -k https://self-signed.local        # 跳过证书校验（仅调试）
curl --resolve api.example.com:443:10.0.0.5 https://api.example.com/   # 绕过 DNS 指到某台
curl --cacert ./ca.pem https://internal/  # 自签 CA
```

`--resolve` 是灰度验证的神器：不改 DNS、不改 hosts 就能把请求打到指定机器。

## 下载与上传

```bash
curl -O https://example.com/file.tar.gz          # 用远端文件名
curl -o out.bin https://example.com/file
curl -C - -O https://example.com/big.iso         # 断点续传
curl -T ./file https://upload.example.com/       # PUT 上传
curl --limit-rate 1M -O https://example.com/big.iso
```

## 代理

```bash
curl -x http://127.0.0.1:7890 https://example.com
curl --socks5-hostname 127.0.0.1:1080 https://example.com
export https_proxy=http://127.0.0.1:7890
```

`socks5` 与 `socks5h` 的区别：后者由代理解析 DNS（避免 DNS 污染）。

## 并发与循环

```bash
seq 1 10 | xargs -I{} -P5 curl -s -o /dev/null -w '{} %{http_code}\n' http://localhost/api/{}
for i in $(seq 1 5); do curl -s -o /dev/null -w '%{http_code} ' http://h/; done; echo
```

## jq：把 JSON 变成人能读的

```bash
curl -s https://api/x | jq                 # 格式化
curl -s https://api/x | jq '.data.items[0]'
curl -s https://api/x | jq '.data.items[] | {id, name}'
curl -s https://api/x | jq -r '.items[].name'      # 去引号，配合 shell
curl -s https://api/x | jq '.items | length'
curl -s https://api/x | jq '[.items[] | select(.status=="active")]'
curl -s https://api/x | jq 'sort_by(.created_at) | last'
curl -s https://api/x | jq '{total: (.items|length), first: .items[0].name}'
curl -s https://api/x | jq 'to_entries | map({(.key): .value}) | add'
```

常用参数：

| 参数 | 作用 |
| --- | --- |
| `-r` | 输出原始字符串（去掉引号） |
| `-c` | 紧凑输出（一行） |
| `-e` | 结果为 false/null 时退出码 1（脚本判断用） |
| `--arg k v` | 传入变量，避免手写引号 |
| `-S` | 按 key 排序 |

```bash
jq -n --arg name demo '{name: $name, ts: now}'
```

## 组合套路

```bash
# 拿 token
TOKEN=$(curl -s -X POST https://auth/token -d 'grant_type=client_credentials' | jq -r '.access_token')

# 批量拉分页
for p in 1 2 3; do
  curl -s "https://api/x?page=$p" | jq -r '.data[].id'
done | sort -u > ids.txt

# 只挑 5xx 的 traceId
curl -s 'https://logs/api?q=status:500' | jq -r '.hits[].traceId'
```

## 常见问题

- 返回中文乱码：`--compressed` 加上，配合 `jq` 输出 UTF-8。
- 提示 `SSL certificate problem`：内网自签，加 `--cacert` 而不是 `-k`。
- `Empty reply from server`：服务端接受了连接但没返回，通常是后端崩了或协议不匹配（HTTP 打到 HTTPS 端口）。
- 上传大文件超时：`--expect100-timeout` 与 `--max-time` 一起调。
