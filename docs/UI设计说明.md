# UI 设计说明

## 设计目标

本项目 UI 以 Apple 设计语言（Apple Design Language）为基准，
强调克制的层次体系与光学质感动效。

### 设计令牌实际取值（源自 `tokens.css`）

| 维度 | 实际值 |
|---|---|
| 强调色 | Action Blue `#0071e3`（浅色）/ Sky Link Blue `#2997ff`（深色） |
| 骨架色 | Carbon Dark `#171a20`（深色）/ Light Ash `#f4f4f4`（浅色画布）/ `#ffffff`（白面板） |
| 灰字体系 | 四档带蓝调灰：`#393c41` / `#5c5e62` / `#767a82` /（深色镜像 `#c9cbd0` / `#a0a3a9` / `#7e828a`） |
| 字阶 | hero `clamp(30px, 4.2vw, 40px)` 封顶；正文 14px / 1.5 行高；12px 为最小档 |
| 字重 | 仅 400 / 500 两档（`--fw-semibold` 和 `--fw-bold` 均映射到 500） |
| 字距 | 负字距：body `-0.374px`、caption `-0.224px`、display `-0.012em`（Apple "tight headline" 效果） |
| 圆角 | 阶梯：4px(微·`--r-xs`) / 8px(小·`--r-sm`) / 12px(中·`--r-md`/`--r-lg`) / 18px(大·`--r-xl`/`--r-2xl`) / 9999px(胶囊·`--r-pill`) |
| 阴影 | 五级双光源阴影体系：`--sh-xs` ~ `--sh-xl`，每层 = ambient(大范围低透明度) + key(窄边高透明度)；另有 `--sh-focus/card/nav` 辅助阴影；深色模式阴影加深 |
| 缓动 | 主缓动 `cubic-bezier(0.4, 0, 0.6, 1)`；出场 `cubic-bezier(0.16, 1, 0.3, 1)`；弹簧 `cubic-bezier(0.34, 1.56, 0.64, 1)`；抽屉 `cubic-bezier(0.32, 0.72, 0, 1)` |
| 动效时长 | 0.1s(按压) / 0.24s(快) / 0.32s(中) / 0.5s(慢) / 0.6s(进场) / 0.8s(长进场) |
| 间距 | 8pt 网格：4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48 / 64 / 80px |

### 图表与叠加层令牌

| 令牌 | 浅色 | 深色 |
|---|---|---|
| `--chart-score` | `#3e6ae1` | `#5a8bf2` |
| `--chart-ear` | `#3e6ae1` | `#5a8bf2` |
| `--chart-mar` | `#5c5e62` | `#a0a3a9` |
| `--chart-axis` | `#767a82` | `#7e828a` |

关键点叠加层常态为白色系单色线稿，事件色：闭眼 `#ff453a`（systemRed）、张嘴 `#ffd60a`（systemYellow）。

## 页面结构

### 首屏（viewHome）

- 全幅磁贴（tile）布局，Carbon Dark `#171a20` / Light Ash `#f4f4f4` 交替产生节奏；
- 磁贴 1（Carbon Dark）：隐私 eyebrow + 大标题（hero clamp 30~40px）+ CTA 按钮组 + 原创 SVG 产品示意图；
  首页 hero 之上导航透明悬浮白字，滚动后切毛玻璃实底；
- 磁贴 2（白底）：2×2 浅灰大卡，12px 圆角；
- 磁贴 3（浅灰）：关键数字收尾（478 关键点 / 7 类特征 / 4 级预警 / 0 字节上传），
  数字从 0 滚动入场（count-up）。

### 工作台（viewWork）

- 顶部仪表条 `cluster`：左等级芯片+原因 / 中 128px 细环 + 40px 大数字 / 右时长·峰值·均值；
- 主区：大圆角（12px）视频画面 + 控制条；趋势图与专业模式波形图在下；
- 右栏：指标面板 + 检测记录时间线 + 个人基准值；
- 校准环、待机/错误/暂停遮罩覆盖在画面上。

### 报告页（viewReport）

- 标题摘要靠左、CTA 按钮组靠右；
- 概要/状态分布/行为统计三等分卡片网格 + 全程曲线 + 建议列表；
- 历史会话卡：localStorage 保存最近 10 次文字摘要，带一键清空（应用内二次确认）；
- 专业模式追加：参数敏感性分析、权重消融、离线复现、视频离线评测 + 锚点导航条。

### 单层导航（56px）

- 左 logo + 加宽字距 wordmark；中：三视图入口（14px/500）；
  右：运行状态、专业模式开关、静音、主题、设置。
  首页 hero 之上透明悬浮白字，滚动后（`.is-scrolled`）切毛玻璃实底。

## 深色模式

- **主题三态**：跟随系统 → 深色 → 浅色循环；
  `localStorage 'fatigue.theme'` 只存 light/dark，auto 即 removeItem；
  storage 事件做多窗口被动同步；`prefers-color-scheme` 变化实时跟随 auto 态；
- `@media (prefers-color-scheme: dark)` 跟随系统 + `[data-theme]` 手动覆盖；
- 不是简单反转：磁贴底色换两级 Carbon Dark、强调色换 `#2997ff`、语义色保持同值（单一配色约束）。

## 动效系统（motion.css）

实际实现的动效类别：

| # | 动效 | 说明 |
|---|---|---|
| 1 | 滚动进场 | `data-reveal` 元素从下方 30px 浮入 + 淡入，错峰 60ms；`ease-reveal` 曲线 |
| 2 | 视图切换 | display 直接切换，无转场动画 |
| 3 | 数字滚动 | `data-countup` 从 0 递增，等宽数字前提 |
| 4 | 导航毛玻璃 | 滚动后 `backdrop-filter: saturate(1.8) blur(20px)` + 底部分隔线 |
| 5 | 卡片交互 | `.card.interactive` active 时 `scale(0.99)`；`.feat` active 时 `scale(0.98)` |
| 6 | 按压回弹 | `.pill/.btn` active 时 `scale(0.95)`，弹簧曲线回弹 |
| 7 | 链接箭头 | `.link-arrow` active 时箭头位移 |
| 8 | 视差 | `[data-parallax]` 随滚动位移 |
| 9 | 网格进场 | `.feat-grid` 按行错峰浮入 |
| 10 | Toast | 顶部滑入 + 弹簧效果 |
| 11 | 报警脉冲 | `::before` 伪元素 `scale + opacity` 扩散环 |
| 12 | Spinner | 渐变环旋转 |
| 13a | 标题模糊浮现 | `data-reveal="blur"`：opacity + `blur(12px)` + translateY |
| 13b | Hero 插画微动 | 车道线流动、扫描线流动、仪表弧线进场、状态点呼吸 |
| 14 | 错峰淡入 | `data-staggered`：translateY(30px) + opacity 依次淡入 |
| 15 | 导航毛玻璃增强 | `saturate(1.8) blur(20px)` |
| 16 | Tile 微缩放 | `.feat:active` scale(0.98) |
| 17 | 顶部条带滑入 | `.ts-promo` 从 translateY(-100%) 滑入 |
| 19 | 滚动驱动 | `data-reveal="scroll"` 更长进场 |
| 20 | 图标 active | `.gn-icon/.btn-icon` active scale(0.88) |
| 21 | 链接箭头滑入 | active 时箭头位移动画 |
| 22 | Hero 视差 | `.ts-hero-title/sub/cta` 随滚动位移 |
| 23 | 抽屉滑入 | `.sheet` 从 translateX(100%) 滑入；退场 backdrop 延迟 0.1s 淡出 |
| 24 | 指标条填充 | `.metric-spark > i` width 弹簧过渡 |
| 25 | 等级芯片 | `chipPop` keyframes：scale 0.92→1.04→1 |
| 26 | 仪表弧线 | `.gauge .bar` stroke-dashoffset 过渡 |
| 27 | 分布条 | `.dist-seg` flex-basis 过渡 |
| 28 | 进度条光泽 | `::after` 光泽扫过 |
| 29 | 滚动淡出 | `.ts-hero-inner` opacity + transform 随滚动 |
| 30 | 启动环脉冲 | `calibPulse` drop-shadow 呼吸 |

- `prefers-reduced-motion: reduce` 时全部动效时长归零（base.css 兜底）；
- `prefers-reduced-motion: no-preference` 包裹所有动效；
- 悬停交互在 `hover: hover` + `pointer: fine` 设备启用；
- 进场动效由 IntersectionObserver 触发一次即止。

## 反馈与确认交互

- **按钮图标统一**：带文字按钮配引导图标，取自 `<symbol id="i-*">` 库（Lucide 系，24 viewBox / stroke 2px / 圆端点）；
- **应用内二次确认**：危险操作使用 `toastConfirm` 行内确认卡（alertdialog 语义 + Esc 取消 + 确认键聚焦 + 单实例互斥），不用原生 `confirm()`；唯一例外是 `beforeunload` 卸载确认。

## 响应式

- 1920 / 1440 / 1366 / 平板 / 390px 移动端均有实测截图；
- 移动端可浏览首页、查看报告与基础操作；实时检测建议桌面进行。

## 无障碍

- 语义化标签 + 标题层级 + skip-link；
- 弹窗 role=dialog + aria-modal + Escape 关闭 + Tab 焦点陷阱；
- 状态不只依赖颜色（文字 + 图标 + 徽章）；图表 canvas 带 role=img + aria-label；
- axe-core 扫描 critical/serious 清零；
- 文字对比度按 WCAG AA ≥4.5:1 校准。

## 强调色与语义色并存

1. **交互色**：所有按钮/链接/激活态只有一支 `--accent`（浅色 `#0071e3` / 深色 `#2997ff`）；
2. **语义色**：四级疲劳预警（`--lv-awake/mild/moderate/severe`），仅用于等级芯片/报警/图表阈值线；
3. **分区规则**：交互元素用强调色；状态徽章/等级芯片/报警/图表用语义色。两族颜色在使用上严格分区。
