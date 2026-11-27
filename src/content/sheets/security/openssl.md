---
title: OpenSSL 与证书速查
summary: 生成密钥与 CSR、自签证书、检查有效期与链、转换格式、排查"证书不受信任"的四类原因。
group: 安全
order: 2
tags: [openssl, 证书, tls]
---

## 一、生成密钥与 CSR

```bash
# RSA 2048 私钥
openssl genrsa -out app.key 2048
# 更推荐 ECC（更快更短）
openssl ecparam -genkey -name prime256v1 -out app.key

# 生成 CSR（交互式）
openssl req -new -key app.key -out app.csr
# 非交互
openssl req -new -key app.key -out app.csr -subj "/CN=app.example.com/O=Example"

# 带 SAN（现代浏览器必须）
openssl req -new -key app.key -out app.csr -subj "/CN=app.example.com" \
  -addext "subjectAltName=DNS:app.example.com,DNS:www.app.example.com,IP:10.0.0.10"
```

**CN 已不再被主流浏览器认可**，必须用 SAN。

## 二、自签证书（内网/测试）

```bash
# 一条命令生成自签（含 SAN）
openssl req -x509 -newkey rsa:2048 -nodes -keyout self.key -out self.crt \
  -days 365 -subj "/CN=internal.example.com" \
  -addext "subjectAltName=DNS:internal.example.com,IP:10.0.0.10"

# 用自建 CA 签发（更适合内网多台）
openssl genrsa -out ca.key 4096
openssl req -x509 -new -key ca.key -days 3650 -out ca.crt -subj "/CN=My Internal CA"
openssl x509 -req -in app.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
  -out app.crt -days 365 -extfile <(printf "subjectAltName=DNS:app.example.com")
```

## 三、检查证书

```bash
# 看本地证书内容
openssl x509 -in app.crt -noout -text
openssl x509 -in app.crt -noout -subject -issuer -dates

# 看远端证书（含完整链）
openssl s_client -connect example.com:443 -servername example.com -showcerts </dev/null

# 只看有效期
echo | openssl s_client -connect example.com:443 2>/dev/null | \
  openssl x509 -noout -dates

# 校验链
openssl verify -CAfile ca.crt app.crt

# 检查私钥与证书是否匹配（比对 modulus 的 hash）
openssl x509 -noout -modulus -in app.crt | openssl md5
openssl rsa  -noout -modulus -in app.key | openssl md5
```

## 四、格式转换

```bash
# PEM → DER
openssl x509 -in cert.pem -outform DER -out cert.der
# DER → PEM
openssl x509 -inform DER -in cert.der -out cert.pem

# PFX/P12 → PEM（拆出证书与私钥，Windows 导出常用）
openssl pkcs12 -in cert.pfx -out cert.pem -nodes
openssl pkcs12 -in cert.pfx -nocerts -nodes -out key.pem

# PEM → PFX
openssl pkcs12 -export -out cert.pfx -inkey app.key -in app.crt -certfile ca.crt

# 从私钥提取公钥
openssl rsa -in app.key -pubout -out app.pub
```

## 五、加密与摘要

```bash
# 对称加密文件
openssl enc -aes-256-cbc -salt -pbkdf2 -in file.tar -out file.tar.enc
openssl enc -d -aes-256-cbc -pbkdf2 -in file.tar.enc -out file.tar

# 摘要
sha256sum file
openssl dgst -sha256 file

# 随机密码
openssl rand -base64 24
```

## 六、"证书不受信任"的四类原因

| 报错 | 原因 | 处理 |
| --- | --- | --- |
| `unable to verify the first certificate` | **缺中间证书** | 服务端配 fullchain（域证书 + 中间证书） |
| `certificate has expired` | 过期 | 续期 |
| `certificate is not yet valid` | 客户端时间不对 | 校对 NTP |
| `self signed certificate` | 自签且未加入信任 | 把 CA 加到客户端信任库 |
| `hostname mismatch` | SAN 里没有这个域名 | 重新签发含该域名的证书 |

**最常见的是第一条**：只配了 `server.crt`（域名证书），没配中间证书。浏览器有时能自动补全，但 Java/curl/部分客户端不行。

```nginx
ssl_certificate     /etc/ssl/fullchain.pem;   # 域名证书 + 中间证书
ssl_certificate_key /etc/ssl/privkey.pem;
```

## 七、客户端信任库

```bash
# Debian/Ubuntu
cp ca.crt /usr/local/share/ca-certificates/myca.crt
update-ca-certificates

# RHEL/CentOS
cp ca.crt /etc/pki/ca-trust/source/anchors/
update-ca-trust

# Java（独立信任库）
keytool -importcert -alias myca -file ca.crt -keystore $JAVA_HOME/lib/security/cacerts
```

**Java 用自己的 cacerts**，系统 CA 更新对它无效（高频踩坑）。

## 八、Let's Encrypt（免费证书）

```bash
# certbot
certbot certonly --webroot -w /var/www/html -d example.com -d www.example.com \
  --email ops@example.com --agree-tos --no-eff-email

# 自动续期（一般已自带 timer）
systemctl list-timers | grep certbot
certbot renew --dry-run
```

**`--dry-run` 必须跑一次**：确认续期流程没坏，否则 90 天后才发现。

## 九、检查清单

```
□ 服务端配 fullchain（含中间证书）
□ 证书含 SAN（不是只靠 CN）
□ 有到期监控（剩 30 天告警）
□ 自动续期有 dry-run 验证
□ 私钥权限 600，且不入 Git
□ 客户端时间同步正常（否则"未生效"）
□ Java 应用的信任库单独更新
```
