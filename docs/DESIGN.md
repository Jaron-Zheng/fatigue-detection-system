# 设计规范 · Apple 设计语言（本项目 UI 基准）

> 本文档以 `tokens.css`、`base.css`、`motion.css`、`components.css`、`layout.css` 实际代码为准。

## 1. 总原则

| 维度 | 实际代码取值 |
|---|---|
| 颜色 | Action Blue `#0071e3`（浅色交互色）/ Sky Link Blue `#2997ff`（深色交互色）+ 四级疲劳语义色（仅用于数据可视化与报警） |
| 字体 | `Inter, system-ui, PingFang SC, Microsoft YaHei`；Display/Text 同族，只靠字号分层 |
| 字重 | 只有 400 / 500（`--fw-semibold`/`--fw-bold` 历史令牌全部映射到 500） |
| 字号 | UI 14px、hero `clamp(30px, 4.2vw, 40px)` 封顶；12px 为最小档 |
| 字距 | 负字距：body `-0.374px`、caption `-0.224px`、display `-0.012em`（Apple "tight headline" 效果） |
| 圆角 | 阶梯：4px / 8px / 12px / 18px / 9999px(胶囊)。主 CTA 按钮用 `9999px`（胶囊形） |
| 阴影 | 五级双光源阴影体系：`--sh-xs` ~ `--sh-xl`，每层 = ambient(大范围低透明度) + key(窄边高透明度)；另有辅助阴影（`--sh-card` / `--sh-focus` / `--sh-nav`） |
| 缓动 | 主缓动 `cubic-bezier(0.4, 0, 0.6, 1)`；出场 `cubic-bezier(0.16, 1, 0.3, 1)`；弹簧 `cubic-bezier(0.34, 1.56, 0.64, 1)`；抽屉 `cubic-bezier(0.32, 0.72, 0, 1)` |
| 动效时长 | 0.1s(按压) / 0.24s(快) / 0.32s(中) / 0.5s(慢) / 0.6s(进场) / 0.8s(长进场) |

## 2. 颜色令牌对照

| 令牌 | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--bg` | `#f4f4f4` | `#171a20` | 页面画布 |
| `--bg-elevated` | `#ffffff` | `#1e2229` | 卡片/面板 |
| `--bg-inset` / `--bg-sunken` | `#f4f4f4` / `#ececec` | `#242932` / `#12151a` | 卡中卡、悬停底 |
| `--text` | `#171a20` | `#f4f4f4` | 标题主文 |
| `--text-secondary` | `#393c41` | `#c9cbd0` | 次级文字 |
| `--text-tertiary` | `#5c5e62` | `#a0a3a9` | 辅助文字/表头 |
| `--text-quaternary` | `#767a82` | `#7e828a` | 禁用态/占位符 |
| `--accent` | `#0071e3` | `#2997ff` | 交互色 |
| `--btn-bg` | `var(--accent)` = `#0071e3` | `#0071e3` | 主按钮底（白字 4.7:1） |
| `--accent-text` | `#0066cc` | `#2997ff` | 文字链接色 |
| `--separator` | `#eeeeee` | `#2c3038` | 表格行线/分隔 |
| `--lv-awake` | `#1fa355` | `#1fa355` | 清醒 |
| `--lv-mild` | `#a87705` | `#a87705` | 轻度 |
| `--lv-moderate` | `#f2680c` | `#f2680c` | 中度 |
| `--lv-severe` | `#e02b2b` | `#e02b2b` | 重度 |

语义色在浅色/深色两套主题下取完全相同的值（单一配色约束）。四档均为中等明度（相对亮度 0.17–0.29），在白底与 `#171a20` 深底上同时满足 ≥3:1。

## 3. 图标系统

- 来源：[lucide-icons/lucide](https://github.com/lucide-icons/lucide)（MIT），24×24 视窗、2px 圆头描边、`currentColor`。
- 内联于 `web/index.html` 顶部 `<symbol id="i-*">` 库。
- 尺寸体系：16px（`.btn`）/ 15px（`.pill`）/ 17px（导航）/ 18px（`.btn-lg`、`.gn-icon`、`.btn-icon`）。

## 4. 阴影体系

五级双光源阴影 + 辅助阴影（tokens.css 实际值）：

| 令牌 | 值 |
|---|---|
| `--sh-xs` | `0 1px 2px rgba(0,0,0,0.05)` |
| `--sh-sm` | `0 2px 8px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04)` |
| `--sh-md` | `0 4px 16px rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.04)` |
| `--sh-lg` | `0 12px 40px rgba(0,0,0,0.10), 0 4px 12px rgba(0,0,0,0.05)` |
| `--sh-xl` | `0 20px 60px rgba(0,0,0,0.12), 0 8px 20px rgba(0,0,0,0.06)` |
| `--sh-card` | `0 2px 8px rgba(0,0,0,0.04)` |
| `--sh-card-hover` | `0 12px 40px rgba(0,0,0,0.08), 0 4px 12px rgba(0,0,0,0.04)` |
| `--sh-focus` | `0 0 0 3px rgba(62,106,225,0.4)` |
| `--sh-nav` | `0 1px 0 rgba(0,0,0,0.08)` |

深色模式阴影加深（如 `--sh-xl` → `0 20px 60px rgba(0,0,0,0.4), 0 8px 20px rgba(0,0,0,0.2)`）。

## 5. 动效

- 滚动进场 `[data-reveal]`：位移 + 淡入，`--ease-reveal` 曲线，错峰 60ms；
- 标题模糊浮现 `[data-reveal="blur"]`：opacity + `blur(12px)` + translateY(24px)；
- 卡片交互：`.card.interactive:active` scale(0.99)；`.feat:active` scale(0.98)；
- 按压回弹：`.pill/.btn:active` scale(0.95)，弹簧曲线 `--ease-spring` 回弹；
- 视差：`[data-parallax]` 随滚动位移；
- 导航毛玻璃：`backdrop-filter: saturate(1.8) blur(20px)`；
- Toast：顶部滑入 + 弹簧效果；
- 报警脉冲：`::before` 伪元素 scale + opacity 扩散环；
- 抽屉：从 translateX(100%) 滑入，退场 backdrop 延迟 0.1s 淡出；
- 等级芯片：`chipPop` scale 0.92→1.04→1；
- 仪表弧线/分布条/指标条：width / stroke-dashoffset / flex-basis 过渡；
- 进度条光泽扫过；
- 启动环脉冲 drop-shadow 呼吸；
- `prefers-reduced-motion: reduce` 时全部动效时长归零；
- 进场动效由 IntersectionObserver 触发一次即止。

## 6. 硬规则

1. 交互色只有 `--accent` 一支。
2. CSS 变量名不得改名：JS `cssVar()` 与导出报告按名取色（清单见 tokens.css 头注）。
3. 图标 symbol id `#i-*` 不得改名：JS 动态换图依赖。
4. 测试锚点不得移除：全部元素 ID、`.view`×3、`.sheet.open`、`.t-body`、`.metric-label`、`.gn-links a[data-goto]`。
5. 按钮图标家族化尺寸：`.btn` 16px / `.btn-lg` 18px / `.pill` 15px / `.gn-icon`/`.btn-icon` 18px。图标 24 viewBox、stroke currentColor 2px、圆端点圆拐角（Lucide 系）。
