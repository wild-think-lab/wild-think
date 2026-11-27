---
title: 实验报告式教程：从零源码部署一套 LAMP
description: 按实验报告的格式走一遍——目的、环境、原理、步骤、验证、注意事项、附录脚本。做完你会真正理解"网站是由几层东西拼起来的"。
date: 2023-12-23
tags: [入门, LAMP, 实验报告, 零基础, Linux]
minutes: 45
featured: true
---

这份教程的结构是照着实验报告来的：每一节都告诉你**做什么、为什么做、做完怎么验证**。它适合已经读完《Linux 从入门到能干活》前 6 章的人当第一次实战作业。

先说一句实话：**源码编译不是生产环境的推荐做法**。生产上应该用包管理器（`dnf install httpd php mysql`）或容器。但源码编译能让你看清"Apache 依赖 APR、PHP 依赖 httpd 的 apxs"这类真实关系——所以它在教学场景里非常值。

## 一、实验目的

1. 理解 Web 服务的最小构成：Web 服务器 + 数据库 + 脚本语言。
2. 亲手处理一次完整的依赖链（APR → APR-Utils → httpd → PHP）。
3. 会用日志和 `phpinfo` 验证"每一层真的活着"，而不是凭"命令没报错"猜。

## 二、实验环境

### 2.1 软件环境

| 项 | 版本 | 说明 |
| --- | --- | --- |
| 操作系统 | CentOS 7.9 x86_64 | 也可以用 Rocky 9 / Ubuntu 22.04，步骤会标注差异 |
| 编译工具 | gcc / make / gcc-c++ | 源码编译前提 |
| APR | 1.7.0 | Apache 可移植运行库 |
| APR-Utils | 1.6.1 | APR 的补充工具库 |
| httpd | 2.4.54 | Apache Web 服务器 |
| MySQL | 5.7.37 | 二进制包，不用编译 |
| PHP | 7.1.10 | 以 Apache 模块方式运行 |

### 2.2 安装包清单

| 包 | 用途 | 获取方式 |
| --- | --- | --- |
| apr-1.7.0.tar.gz | httpd 依赖 | apr.apache.org |
| apr-util-1.6.1.tar.gz | httpd 依赖 | apr.apache.org |
| httpd-2.4.54.tar.gz | Web 服务器 | httpd.apache.org |
| mysql-5.7.37-linux-glibc2.12-x86_64.tar.gz | 数据库 | dev.mysql.com |
| php-7.1.10.tar.gz | 脚本语言 | php.net |

> 版本号必须自己核对：下载页上的文件名和上面的不一致时，以实际下载的为准，别照抄别人的命令。

## 三、实验原理

一次 PHP 页面的请求，走过的链路是：

```text
浏览器 → httpd（80 端口）→ 发现是 .php → 交给 PHP 模块执行
                                  ↓
                              PHP 连 MySQL（3306 或 socket）
                                  ↓
                         MySQL 返回数据 → PHP 生成 HTML → httpd 回给浏览器
```

所以三者的关系是**嵌套依赖**，不是三个独立软件：

- httpd 需要 APR（内存池、跨平台抽象）和 APR-Utils（加密、数据库连接等扩展）。
- PHP 需要 httpd 的 `apxs` 工具才能"把自己编译成 Apache 的模块"。
- 因此编译顺序固定：**APR → APR-Utils → httpd → PHP**，MySQL 可并行准备。

顺序错了，后面的必然报错——这也是这类实验最有价值的地方：报错信息会直接告诉你缺了谁。

## 四、实验步骤

### 4.1 准备编译环境

**操作目的**：确认 gcc、make、依赖库齐全，避免编译到一半才发现缺东西。

```bash
yum install -y gcc gcc-c++ make wget
yum install -y pcre pcre-devel openssl openssl-devel zlib zlib-devel
yum install -y libxml2-devel libcurl-devel libpng-devel libjpeg-devel freetype-devel
```

Rocky 9 把 `yum` 换成 `dnf`；Ubuntu 用 `apt install build-essential libpcre3-dev ...`。

### 4.2 编译安装 APR

**操作目的**：给 httpd 准备运行库。

```bash
cd /usr/local/src
tar -xf apr-1.7.0.tar.gz && cd apr-1.7.0
./configure --prefix=/usr/local/apr
make -j$(nproc) && make install
```

关键参数说明：

| 参数 | 含义 |
| --- | --- |
| `--prefix=/usr/local/apr` | 安装到哪里，后面 httpd 要用这个路径 |
| `-j$(nproc)` | 用全部 CPU 核心并行编译，快很多 |

### 4.3 编译安装 APR-Utils

**操作目的**：补齐 httpd 需要的扩展能力。

```bash
cd /usr/local/src
tar -xf apr-util-1.6.1.tar.gz && cd apr-util-1.6.1
./configure --prefix=/usr/local/apr-util --with-apr=/usr/local/apr
make -j$(nproc) && make install
```

`--with-apr` 必须指向刚才装的 APR，否则它会去找系统自带的旧版本，之后 httpd 链接出错。

### 4.4 编译安装 httpd

**操作目的**：装 Web 服务器本体。

```bash
cd /usr/local/src
tar -xf httpd-2.4.54.tar.gz && cd httpd-2.4.54
./configure \
  --prefix=/usr/local/apache2 \
  --with-apr=/usr/local/apr \
  --with-apr-util=/usr/local/apr-util \
  --enable-so \
  --enable-rewrite \
  --with-mpm=prefork
make -j$(nproc) && make install
```

| 参数 | 为什么需要 |
| --- | --- |
| `--enable-so` | 允许动态加载模块（PHP 就靠这个挂进来） |
| `--enable-rewrite` | 支持 URL 重写，几乎所有框架都要 |
| `--with-mpm=prefork` | 多进程模型；PHP 的 apache 模块模式在非线程安全环境下更稳 |

验证 httpd 能起来：

```bash
/usr/local/apache2/bin/apachectl -k start
ss -lntp | grep :80
curl -I http://localhost
```

看到 `200 OK` 说明 Web 层通了。此时首页是 `It works!`。

### 4.5 部署 MySQL（二进制包）

**操作目的**：拿到数据库，采用官方二进制包省去编译。

```bash
# 建用户与目录
groupadd mysql && useradd -r -g mysql -s /sbin/nologin mysql
mkdir -p /opt/data /opt/mysql
tar -xf mysql-5.7.37-linux-glibc2.12-x86_64.tar.gz -C /opt/mysql --strip-components=1

# 初始化（注意 insecure 表示初始无密码，仅限实验）
chown -R mysql:mysql /opt/data
/opt/mysql/bin/mysqld --initialize-insecure --user=mysql \
  --basedir=/opt/mysql --datadir=/opt/data
```

启动并连上：

```bash
/opt/mysql/bin/mysqld_safe --defaults-file=/opt/mysql/my.cnf &
/opt/mysql/bin/mysql -uroot -S /tmp/mysql.sock
```

实验环境的 `my.cnf` 只需三行：

```ini
[mysqld]
basedir=/opt/mysql
datadir=/opt/data
socket=/tmp/mysql.sock
```

> `--initialize-insecure` 建的是空密码 root。**任何能被外部访问的机器上都不允许这么做。**

### 4.6 编译安装 PHP

**操作目的**：让 httpd 认识 `.php` 文件。

```bash
cd /usr/local/src
tar -xf php-7.1.10.tar.gz && cd php-7.1.10
./configure \
  --prefix=/usr/local/php \
  --with-apxs2=/usr/local/apache2/bin/apxs \
  --with-mysql-sock=/tmp/mysql.sock \
  --with-mysqli=mysqlnd \
  --with-pdo-mysql=mysqlnd \
  --enable-mbstring --enable-opcache
make -j$(nproc) && make install
```

| 参数 | 作用 |
| --- | --- |
| `--with-apxs2` | 用 httpd 提供的工具生成 `libphp.so` 模块 |
| `--with-mysql-sock` | 指定 socket 路径，必须和 MySQL 的一致，否则连不上 |
| `mysqlnd` | PHP 原生的 MySQL 驱动，不依赖外部客户端库 |

### 4.7 让 httpd 认识 PHP

```bash
cp php.ini-production /usr/local/php/lib/php.ini
```

编辑 `/usr/local/apache2/conf/httpd.conf`，确认这两行存在（`apxs` 安装通常会自动加上 `LoadModule`）：

```apache
LoadModule php7_module modules/libphp7.so

<FilesMatch ".+\.ph(p[3457]?|t|tml)$">
    SetHandler application/x-httpd-php
</FilesMatch>
```

重启：

```bash
/usr/local/apache2/bin/apachectl -k restart
```

### 4.8 验证

```bash
cat > /usr/local/apache2/htdocs/info.php <<'PHP'
<?php phpinfo(); ?>
PHP

curl -s http://localhost/info.php | grep -i "mysql"
```

看到 `mysql` 相关段落，说明 PHP 编译时把 MySQL 支持链接进来了。

## 五、实验结果与验证

### 5.1 分层验证（比"页面能打开"更可靠）

| 层 | 验证命令 | 期望 |
| --- | --- | --- |
| httpd 在跑 | `ss -lntp \| grep :80` | 有监听 |
| 静态页通 | `curl -I http://localhost` | 200 |
| PHP 模块加载 | `httpd -M \| grep php` | 出现 `php7_module` |
| PHP 能执行 | `curl http://localhost/info.php` | 输出 phpinfo |
| MySQL 可连 | `mysql -uroot -S /tmp/mysql.sock -e "select 1"` | 返回 1 |
| PHP 连 MySQL | 写一个 mysqli 测试页 | 输出 "connected" |

### 5.2 数据库连通性测试页

```php
<?php
$link = new mysqli("localhost", "root", "", "", null, "/tmp/mysql.sock");
echo $link->connect_error ? "失败: " . $link->connect_error : "connected";
```

`localhost` 会走 socket，正好验证第 4.6 步的 `--with-mysql-sock` 有没有配对。这是这类实验最常见的失败点。

## 六、注意事项

1. **防火墙与 SELinux**：实验环境可临时 `systemctl stop firewalld`、`setenforce 0`；生产环境应改为放行规则与正确的 SELinux 上下文（`semanage fcontext`）。
2. **路径一致性**：APR 装哪、httpd 的 `--with-apr` 就指哪；MySQL socket 在哪、PHP 的 `--with-mysql-sock` 就指哪。这类"编译时对不上"的错，运行时不会提醒你，只在功能失效时暴露。
3. **端口冲突**：系统可能自带一个 httpd，先 `rpm -qa | grep httpd` 确认，避免两个 Apache 抢 80。
4. **勘误**：本篇按 httpd 2.4.x + PHP 7.x 的路径记录。PHP 8 之后不再支持 `--with-apxs2` 之外的旧参数名，编译失败时以 `./configure --help` 为准。

## 七、实验总结

做完这套，你应该能回答三个问题：

- 为什么编译顺序不能颠倒？——后装的依赖前者，`apxs` 就是 httpd 的产物。
- 为什么"页面打不开"要分层查？——因为每一层都有自己的验证方式，混在一起查只会浪费时间。
- 为什么生产不建议源码编译？——升级、卸载、安全补丁都要自己扛，包管理器已经解决了这些。

**延伸思考**：把这套改成 httpd + PHP-FPM（FastCGI）模式，`ProxyPassMatch` 转发 `\.php$` 到 9000 端口，和模块模式比，哪个更容易横向扩容？

## 附录 A：整合脚本

```bash
#!/usr/bin/env bash
set -euo pipefail
SRC=/usr/local/src

compile_apr() {
  cd "$SRC" && tar -xf apr-1.7.0.tar.gz && cd apr-1.7.0
  ./configure --prefix=/usr/local/apr && make -j"$(nproc)" && make install
}
compile_apr_util() {
  cd "$SRC" && tar -xf apr-util-1.6.1.tar.gz && cd apr-util-1.6.1
  ./configure --prefix=/usr/local/apr-util --with-apr=/usr/local/apr \
    && make -j"$(nproc)" && make install
}
compile_httpd() {
  cd "$SRC" && tar -xf httpd-2.4.54.tar.gz && cd httpd-2.4.54
  ./configure --prefix=/usr/local/apache2 --with-apr=/usr/local/apr \
    --with-apr-util=/usr/local/apr-util --enable-so --enable-rewrite \
    --with-mpm=prefork && make -j"$(nproc)" && make install
}

compile_apr
compile_apr_util
compile_httpd
echo "httpd ok: $(/usr/local/apache2/bin/apachectl -v | head -1)"
```

脚本只负责到 httpd，MySQL 与 PHP 部分建议手动执行一遍——中间任何一步出错时，手动能看到具体上下文。

## 资料来源

结构与参数参考博客园《LAMP 环境部署-详解》，并按 httpd 2.4 / PHP 7.x 的实际行为做了核对与补充。
