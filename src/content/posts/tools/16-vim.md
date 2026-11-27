---
title: Vim 实用主义：只学二十个操作，够用十年
description: 移动、编辑、搜索、替换、分屏、宏、配置，按"实际会用到的频率"排序。
date: 2024-12-08
tags: [Vim, 编辑器, 效率]
---

### 先接受一个事实

```
Vim 的功能有几百个，日常真正高频的不到 20 个
先把 20 个练成肌肉记忆，比背 200 个命令有用
```

### 模式（唯一需要先理解的）

```
Normal（普通）→ 移动与操作
Insert（插入）→ 打字（i / a / o 进入）
Visual（可视）→ 选择（v / V / Ctrl+V）
Command（命令）→ :w :q :%s
```

**"按 i 才能打字"** 是唯一的门槛，习惯就好。

### 二十个高频操作

**移动（8 个）**

```
h j k l      左 下 上 右
w / b        下一个/上一个词
0 / $        行首/行尾
gg / G       文件首/尾
:n           第 n 行
Ctrl+d/u     翻半页
%            括号匹配跳转
f x          行内跳到下一个 x
```

**编辑（6 个）**

```
i / a        插入（前/后）
o / O        下一行/上一行插入
dd           删一行
yy           复制一行
p            粘贴
u            撤销（Ctrl+r 重做）
```

**搜索替换（3 个）**

```
/word        搜索（n 下一个，N 上一个）
:%s/a/b/g    全文替换
:%s/a/b/gc   替换前确认
```

**保存退出（3 个）**

```
:w           保存
:q           退出
:wq / ZZ     保存退出（:q! 强制不保存退出）
```

**这一组就够日常编辑了。**

### 进阶但极高频（值得学）

```
ciw          改一个词（change inner word）
ci"          改引号里的内容
di(          删括号里的内容
yap          复制一段（含空行）
viw          选中一个词
V            行选择
Ctrl+v       块选择（列编辑）
>> / <<      缩进/反缩进
J            合并下一行
gd           跳到定义
```

**`ciw` 是最值得练的一个**：改单词不用先删再打。

### 多文件与分屏

```
:e file      打开文件
:bn / :bp    下/上一个 buffer
:sp file     水平分屏
:vsp file    垂直分屏
Ctrl+w h/j/k/l  在分屏间移动
Ctrl+w =     等分窗口
:tabnew      新标签页
gt / gT      下/上标签页
```

### 宏（批量重复操作的神器）

```
qa           开始录制到寄存器 a
（做你的操作）
q            结束录制
@a           执行一次
10@a         执行 10 次
@@           重复上一次
```

**典型场景**：

```
把 100 行的 "key: value" 改成 "value = key"
qa → 行首 → 删除 key → 移动 → 改符号 → j → q
→ 99@a
```

**"宏 + 数字"能省掉大量重复劳动**。

### 与外部命令结合

```
:!ls          执行 shell 命令
:r !date      插入命令输出
:%!sort       对整个文件排序（用外部命令处理）
:%!jq .       格式化 JSON
```

**`:%!xxx` 是"把整个文件交给外部工具处理"**，非常强大：

```
格式化 JSON：:%!jq .
格式化 SQL ：:%!sqlformat -
```

### 配置（最小可用 .vimrc）

```vim
set number relativenumber      " 行号（相对）
set expandtab tabstop=2 shiftwidth=2
set autoindent smartindent
set ignorecase smartcase       " 搜索忽略大小写，但有大写时敏感
set incsearch hlsearch
set nowrap
set mouse=a                    " 允许鼠标
set clipboard=unnamedplus      " 与系统剪贴板共享
set undofile                   " 持久撤销
syntax on
filetype plugin indent on
```

**"相对行号"配合 `5j` 这类跳转非常好用**。

**`set clipboard=unnamedplus`** 让 `yy` 直接进系统剪贴板（跨应用复制）。

### 插件（不要装太多）

```
最小组合：
① 文件搜索：fzf.vim / telescope（Neovim）
② 语法高亮与 LSP：coc.nvim / nvim-lsp
③ 状态栏：lightline / lualine
④ Git：vim-fugitive
⑤ 目录树：NERDTree（老派）/ oil.nvim
```

**"装 50 个插件"是新手最大的坑**：

```
启动慢、冲突多、排错难
→ 先不装，缺什么补什么
```

**"能不用插件就不用"**：Vim 自带的功能比想象的多。

### 五个实用技巧

**① 用 `:earlier` / `:later` 撤销"时间"**

```
:earlier 5m      回到 5 分钟前
:later 5m        前进 5 分钟
```

**比 u/Ctrl+r 更适合"刚才改乱了"**。

**② 用 `=` 格式化缩进**

```
gg=G             全文按语法重排缩进
```

**③ 用 `:%norm` 批量执行普通模式命令**

```
:%norm A;        给每行末尾加分号
:%norm i//       给每行开头加注释
```

**"`:%norm` 是"不用宏的批量操作"**。

**④ 用 `Ctrl+a` / `Ctrl+x` 改数字**

```
光标在数字上 → Ctrl+a 加一，Ctrl+x 减一
```

**⑤ 用 `.` 重复上一次操作**

```
改了第一个 → 移动 → . 重复
```

**`.` 是 Vim 最强的"重复"机制**。

### 换编辑器不是目的

```
Vim 的价值：
① 在任何服务器上都能用（不用装）
② 纯键盘（不用切鼠标）
③ 大文件打开快

不值得为 Vim 而 Vim：
团队主流是 VS Code → 用 Vim 插件模式也能拿到 80% 的效率
```

**"运维必须会 Vim"是现实**，但日常开发用什么都行。

### 检查清单

```
□ 知道四个模式
□ 移动：hjkl w b 0 $ gg G
□ 编辑：i a o dd yy p u
□ 搜索：/word，n/N
□ 替换：:%s/a/b/gc
□ ciw / ci" / di(
□ 分屏与切 buffer
□ 会宏（qa / @a / 10@a）
□ :%!cmd 结合外部工具
□ 最小 .vimrc（行号 + 缩进 + 搜索 + 剪贴板）
□ 插件按需（不超过 5 个）
□ 会用 . 重复、:%norm、:earlier
```
