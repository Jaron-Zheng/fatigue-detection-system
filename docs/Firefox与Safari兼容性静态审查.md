# Firefox / Safari 兼容性静态审查

> 第四轮建议④的落地产出（2026-08-11）。
>
> **口径声明**：本机（Windows）没有安装 Firefox 与 Safari，也没有 macOS 环境，
> 因此本文档是**代码级静态审查**，不是实测验证——《测试报告.md》中
> "Firefox / Safari 兼容性：未验证"的标注**维持不变**。本文的价值是：
> 把"将来拿到这两种浏览器时该重点看什么"提前收敛成一份可执行清单。

## 一、审查方法

对 `web/js/**`（38 个模块）与 `web/css/**`（5 个文件）做高风险 API / CSS 特性
的全量 grep 扫描，逐项对照 Firefox / Safari 的公开支持情况。

## 二、逐项结论

### 2.1 已确认安全（有守卫或全浏览器支持）

| 特性 | 位置 | 结论 |
|---|---|---|
| OffscreenCanvas | quality.js:91 | `typeof OffscreenCanvas === 'function'` 守卫，Firefox 无此 API 时走普通 canvas 回退路径 |
| AudioContext | alarm.js:33 | `window.AudioContext \|\| window.webkitAudioContext` 双写，Safari 前缀已覆盖 |
| speechSynthesis | alarm.js:95 | `'speechSynthesis' in window` 守卫，不支持时静默降级 |
| WebGL2（GPU 委托探测） | app-chrome.js:120 | `getContext('webgl2') \|\| getContext('webgl')` 回退；且设置面板可手动切 CPU 委托 |
| WASM SIMD | vendor 双构建 | 同时携带 `vision_wasm_internal`（SIMD）与 `nosimd` 构建；Safari 16.4 以下、旧 Firefox 走 nosimd |
| ES 语法（可选链/flatMap/import.meta） | 多处 | Firefox 74+/Safari 13.1+ 全支持，现代版本无障碍 |
| 文件导出 | recorder.js downloadFile | 用 Blob + `<a download>`，未用 File System Access API（后者 Chrome-only） |
| backdrop-filter | css 多处 | 全部成对写了 `-webkit-backdrop-filter` 前缀（Safari 必需） |
| prefers-reduced-motion / hover:hover 守卫 | base.css / motion.css | 标准媒体查询，全支持 |

### 2.2 低风险（渐进增强，不支持时仅观感降级，不坏功能）

| 特性 | 位置 | 不支持时的表现 |
|---|---|---|
| `text-wrap: balance/pretty` | base.css:257/261、layout.css 4 处 | Safari 17.4 以下忽略该属性，标题换行回到默认算法 |
| `color-mix()` | components.css:803（仅 `.pill.is-on:hover` 悬停态） | Firefox 113 / Safari 16.2 以下该变量失效，悬停底色回退为初始值，不影响点击与状态 |

### 2.3 重点观察项（拿到真机后优先测）

1. **getUserMedia 权限与镜像流**：Safari 对 `facingMode`/约束的处理与 Chromium
   有差异；重点验证校准流程与 `video.mirrored`（CSS transform 镜像）表现。
2. **MediaPipe GPU 委托（WebGL2）在 Safari 的稳定性**：若异常，设置面板切
   CPU 委托应完全可用（CPU 路径不依赖 WebGL）。
3. **Service Worker（PWA）**：Safari 对 SW 缓存有 7 天不用即清理的策略，
   且安装到程序坞的行为与 Chromium 不同——`?pwa=1` 流程需在 Safari 重验。
4. **语音播报音色**：Safari 的 SpeechSynthesis 中文音色可用性因系统而异。
5. **自动播放策略**：Safari 要求更严格的手势链，报警音 `unlock()` 路径
   （alarm.js 已做手势内创建 + 1.5s 超时保护）需实测。

## 三、遗留结论（如实）

- 本审查**不能替代**两种浏览器上的实际运行验证；
- 测试报告"未验证项"表中该条目保持"未验证"，并引用本文档作为
  已有代码级证据；
- 拿到 Firefox / Safari 环境后的最小实测清单 = §2.3 五项 +
  `ui-smoke.mjs` 的手工等价操作（演示模式全流程 + 报告导出）。
