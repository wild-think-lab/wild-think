---
title: 用 Makefile 把一套操作收成一条命令
description: 为什么用 Make 而不是一堆 shell 脚本、PHONY 与依赖、多环境参数、Tab 的坑、以及"Make 不适合做什么"。
date: 2026-11-27
tags: [Makefile, 自动化, 工具]
---

### 为什么还要用 Make

```
现状：README 里 12 条命令，新人按顺序敲，漏一步就报错
Make：make up / make test / make clean，一条命令一个动作
```

**Make 的价值不是"编译"，是"把动作命名并记下来"**。

**与替代方案对比**：

| 方案 | 优点 | 缺点 |
| --- | --- | --- |
| README | 简单 | 容易过期、没人维护 |
| shell 脚本集合 | 灵活 | 名字散乱、不知道有哪些 |
| Make | 有清单、有依赖、极通用 | 语法老、Tab 敏感 |
| Taskfile/just | 语法现代 | 需额外安装 |

**结论：Make 是最不需要额外安装的"任务清单"**。

### 一个可用的模板

```makefile
.DEFAULT_GOAL := help
SHELL := /bin/bash
.ONESHELL:

APP     ?= app
ENV     ?= dev
VERSION ?= $(shell git rev-parse --short HEAD)

.PHONY: help build test lint up down logs clean

help: ## 显示可用命令
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) \
	  | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

build: ## 构建镜像
	docker build -t $(APP):$(VERSION) .

test: ## 跑测试
	go test ./... -race -cover

lint: ## 静态检查
	golangci-lint run

up: ## 启动本地环境
	docker compose up -d

down: ## 停止本地环境
	docker compose down --remove-orphans

logs: ## 跟踪日志
	docker compose logs -f --tail=100

clean: ## 清理产物
	rm -rf dist/ tmp/
```

**用法**：

```bash
make           # 默认执行 help（列出所有命令）
make build
make ENV=prod up
```

**`help` 目标用 `##` 注释自动生成列表**——这是最实用的一个技巧，让 Makefile 自己变成文档。

### 四个语法要点

**① 必须用 Tab**

```
❌ 空格缩进 → "missing separator" 报错
✅ Tab 缩进
```

**在编辑器里显示 Tab**（VS Code）：

```json
"[makefile]": { "editor.insertSpaces": false, "editor.tabSize": 4 }
```

**② `.PHONY` 声明"不是文件"**

```makefile
.PHONY: build test clean
```

**不声明的后果**：如果目录里恰好有个叫 `test` 的文件，`make test` 会认为"已是最新"而不执行。

**③ `.ONESHELL` 让多行在同一 shell 里跑**

```makefile
.ONESHELL:
deploy:
	cd /srv/app
	git pull
	npm ci
```

**不加 `.ONESHELL`** 时每行是独立的 shell，`cd` 不保持（这是最常见的坑）。

**④ 变量与默认值**

```makefile
APP ?= app        # 可以被 make APP=xxx 覆盖，也可被环境变量覆盖
VERSION := $(shell git rev-parse --short HEAD)
```

`?=` 可覆盖，`:=` 立即展开，`=` 延迟展开。

### 依赖与增量

```makefile
dist/app: $(shell find . -name '*.go')
	go build -o dist/app ./cmd/app

dist/app.tar.gz: dist/app
	tar czf $@ -C dist app
```

**这就是"真正的 Make"**：目标依赖文件，文件比目标新才重建。

**但注意**：对"跑测试""部署"这类动作，依赖文件时间是没意义的，必须 `.PHONY`。

### 多环境参数

```makefile
ENV ?= dev

ifeq ($(ENV),prod)
  COMPOSE_FILE := docker-compose.prod.yml
  REPLICAS := 4
else
  COMPOSE_FILE := docker-compose.yml
  REPLICAS := 1
endif

up:
	docker compose -f $(COMPOSE_FILE) up -d --scale app=$(REPLICAS)
```

**用法**：`make ENV=prod up`

**更好的做法**：参数从一个 `.env` 文件读，Make 只做动作。

### 串行执行与 `-j`

```bash
make -j4 test    # 并行跑 4 个任务
```

**危险**：并行执行互相依赖的任务会出乱子。**默认别用 `-j`**，除非你明确设计过。

### 常见报错

| 报错 | 原因 |
| --- | --- |
| `missing separator` | 用了空格缩进 |
| `*** No rule to make target` | 目标名拼错 / 依赖文件不存在 |
| `recipe commences before first target` | 命令出现在第一个目标之前 |
| `Nothing to be done for 'x'` | 有同名文件且不是 PHONY |
| `cd: command not found`? 不，是 `cd` 不生效 | 没 `.ONESHELL` |

### Make 不适合做什么

```
❌ 复杂控制流（if/for/函数）→ 写 shell 脚本，Make 里调用
❌ 长时间运行的服务 → systemd
❌ 依赖管理（装包）→ 用包管理器
❌ 跨平台的复杂逻辑 → 用 Go/Node 脚本
```

**规则：Make 只做"命名 + 依赖 + 调用脚本"**，逻辑放脚本里。

### 检查清单

```
□ 有 help 目标（自动列出命令）
□ 用 Tab 缩进（编辑器已配置）
□ 所有动作目标都是 .PHONY
□ 多行逻辑用 .ONESHELL 或写成脚本
□ 关键参数用 `?=`（可覆盖）
□ VERSION 从 git 取（不用手工维护）
□ 不用 Make 写复杂控制流
□ 各命令有 `##` 注释（help 能读）
```
