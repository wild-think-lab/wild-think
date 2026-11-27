---
title: 可访问性（a11y）：不是"给少数人用的额外功能"
description: 六个最容易做错的点、语义化与键盘可达、对比度与焦点，以及五个"看着没问题其实不可用"的原因。
date: 2026-11-27
tags: [前端, 可访问性, 设计]
---

### 为什么值得做

```
① 键盘用户 / 屏幕阅读器用户 / 色觉差异 / 视力下降 都是真实用户
② 语义化顺带改善 SEO 与可维护性
③ 很多"体验差"的根源就是 a11y 问题
```

**"用 div 当按钮"** 既不可访问，体验也差（无键盘、无状态）。

### 六个最容易做错的点

**① 用 div 当按钮**

```html
<!-- 差 -->
<div onclick="save()">保存</div>

<!-- 好 -->
<button type="button" onclick="save()">保存</button>
```

**"div 需要 tabindex + keydown + role 才能勉强可用"** —— 直接用 button 更省事。

**② 图片没有 alt**

```html
<img src="chart.png" alt="2026 年 Q3 各区域营收对比，华东最高">
<img src="deco.png" alt="">   <!-- 装饰图：空 alt -->
```

**"alt 写文件名"** 等于没写。

**③ 表单没有 label**

```html
<label for="email">邮箱</label>
<input id="email" type="email" autocomplete="email">
```

**"只有 placeholder"** 在输入后就不见了（用户忘了填什么）。

**④ 焦点被吃掉**

```css
:focus { outline: none; }   /* 差 */
:focus-visible { outline: 2px solid #ff8a3d; outline-offset: 2px; }
```

**"去掉 outline"** 让键盘用户完全找不到自己在哪。

**⑤ 颜色对比度不足**

```
正文 ≥ 4.5:1
大文本（≥18.66px 粗体 / 24px）≥ 3:1
```

**"浅灰字 + 白底"** 是最常见的对比度问题。

**⑥ 只靠颜色传达信息**

```
红色 = 错误 → 再加图标 + 文案
```

**"只有颜色"** 对色盲用户等于没有信息。

### 键盘可达的三个检查

```
① Tab 能走到所有可操作元素（顺序合理）
② Enter/Space 能触发按钮
③ Esc 能关闭弹窗，且焦点回到触发元素
```

**"弹窗打开后焦点还在背后"** 是典型的模态问题：

```
打开时把焦点移入，关闭时移回触发元素
```

### 语义结构

```html
<header>...</html>
<nav aria-label="主导航">...</nav>
<main>
  <h1>标题</h1>
  <section aria-labelledby="sec1">
    <h2 id="sec1">小节</h2>
  </section>
</main>
<footer>...</footer>
```

**"标题层级跳级（h1 → h4）"** 会让屏幕阅读器导航混乱。

### 五个"看着没问题其实不可用"

**① 用图片当文字**

```
banner 里的字是图片 → 屏幕阅读器读不到、搜索不到
→ 真文字 + CSS 样式
```

**② 无限滚动无提示**

```
键盘/屏幕阅读器用户不知道"还有内容"
→ 提供"加载更多"按钮或状态提示
```

**③ 动画无法关闭**

```
prefers-reduced-motion 不处理 → 眩晕用户难受
```

```css
@media (prefers-reduced-motion: reduce) {
  * { animation: none !important; transition: none !important; }
}
```

**④ 自定义下拉框没有键盘支持**

```
方向键、Enter、Esc 全都不响应
→ 用成熟组件库，别自己写
```

**⑤ 错误提示只在视觉上出现**

```
<div class="red-border"></div>
→ 需要 aria-invalid + 文案 + role="alert"
```

### 一个"十分钟"自检

```
1) 拔掉鼠标，只用键盘走一遍主流程
2) 打开系统"高对比度/放大"看是否可用
3) 用浏览器 DevTools 的"无障碍"面板看对比度
4) 逐个图片检查 alt
5) 表单逐个检查 label
```

**"只用键盘走一遍"** 能发现 70% 的问题。

### 检查清单

```
□ 可操作元素用原生控件（button/a/input）
□ 图片有 alt（装饰图为空 alt）
□ 表单有 label + autocomplete
□ focus-visible 可见
□ 对比度达标（4.5:1 / 3:1）
□ 不只靠颜色传达信息
□ Tab 顺序合理
□ 弹窗焦点管理正确
□ 标题层级不跳级
□ 支持 prefers-reduced-motion
□ 错误提示有 aria + 文案
□ 只用键盘能走完主流程
```
