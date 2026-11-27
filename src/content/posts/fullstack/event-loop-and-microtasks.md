---
title: 事件循环、微任务与渲染时机：为什么 Promise 比 setTimeout 先跑
description: 把任务队列、微任务检查点、渲染与 requestAnimationFrame 串成一条时间线，才能解释"明明写在前面却后执行"的现象。
date: 2025-09-30
tags: [JavaScript, 事件循环, 异步, 前端]
---

面试常问"宏任务与微任务的区别"，但真正的价值在于能预测代码的执行顺序，并解释页面为什么"卡住"。

## 一、执行模型：一个循环，多个队列

浏览器主线程只有一个，它的循环大致是：

```
取出一个宏任务执行 → 清空所有微任务 → 可能需要渲染 → 取下一个宏任务
```

- **宏任务**：`setTimeout`、`setInterval`、I/O 回调、用户交互事件、`postMessage`。
- **微任务**：`Promise.then`、`queueMicrotask`、`MutationObserver`。
- **微任务队列在每个宏任务结束后被完整清空**，且清空过程中新产生的微任务会继续执行（同一个检查点内）。

所以：

```js
setTimeout(() => console.log('timeout'), 0);
Promise.resolve().then(() => console.log('promise'));
console.log('sync');
// 输出：sync → promise → timeout
```

`setTimeout(0)` 也要等当前宏任务结束并清空微任务后才执行，且浏览器对嵌套定时器有 4ms 最小间隔（`setTimeout` 的钳制）。

## 二、微任务也可能是"死循环"

微任务清空是"直到队列为空"，因此持续产生微任务会**饿死渲染**：

```js
function loop() {
  Promise.resolve().then(loop);   // 永不结束的微任务链
}
loop();   // 页面直接卡死，连点击都无响应
```

换成 `setTimeout(loop, 0)` 就能让出主线程。**这是"为什么我的循环让页面卡住"最常见的原因之一。**

## 三、渲染时机：rAF 在微任务之后、渲染之前

一次渲染机会大致顺序：

```
微任务清空 → requestAnimationFrame 回调 → 样式计算/布局/绘制 → 下一帧
```

由此可得两个实用结论：

1. 在 `rAF` 里改样式，能在同一帧生效；在 `setTimeout` 里改，可能要等下一帧。
2. 需要"批量 DOM 修改"时，用 `rAF` 合并，避免多次强制同步布局。

```js
// 反例：循环里读布局属性，强制同步重排（layout thrashing）
for (const el of items) {
  el.style.width = el.offsetWidth + 10 + 'px';   // 读-写交替，每轮都重排
}

// 正解：先批量读，再批量写
const widths = items.map((el) => el.offsetWidth);
items.forEach((el, i) => (el.style.width = widths[i] + 10 + 'px'));
```

## 四、`async/await` 到底在第几轮执行

`await` 之后的代码等价于 `then` 回调，属于**微任务**。

```js
async function a() {
  console.log('a1');
  await null;
  console.log('a2');
}
a();
Promise.resolve().then(() => console.log('p1'));
console.log('sync');
// a1 → sync → a2 → p1   （a 的 await 先入队）
```

用这个模型可以准确推断多个 `await` 的交叉顺序：**入队顺序决定执行顺序，而不是书写位置**。

## 五、跨线程的补充

- `Web Worker` 有独立的循环与栈，和主线程只通过消息通信；`postMessage` 的回调在主线程属于宏任务。
- `SharedArrayBuffer` + `Atomics.wait` 可以同步阻塞 Worker（不能阻塞主线程）。
- `requestIdleCallback` 只在浏览器空闲时执行，**不能保证执行时机**，别用它做关键逻辑。

## 六、实践清单

1. 长任务拆分：把 >50ms 的同步逻辑切成若干块，块之间 `await new Promise(r => setTimeout(r, 0))` 让出主线程。
2. 避免在微任务里做重活，它一定插在渲染之前。
3. 高频事件（scroll、resize）用 `passive: true` 监听，避免阻塞滚动。
4. 需要动画就用 `rAF` 或 CSS 动画，不要用 `setInterval` 驱动。

> 一句话：**宏任务是"一件事"，微任务是"这件事的收尾"；渲染只发生在两者都清空之后。**
