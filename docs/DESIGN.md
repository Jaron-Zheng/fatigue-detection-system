# 设计规范 · Tesla 设计语言（本项目 UI 基准）

> 基准来源：`awesome-design-md-main/design-md/tesla/DESIGN.md`（已通读并全文落地）。
> 本文档记录规范在本项目中的映射方式与项目特有的裁定，取代此前的 Apple 设计规范版本。

## 1. 总原则

| 维度 | 规范 | 本项目落地 |
|---|---|---|
| 颜色 | 单色系 + 唯一强调色 Electric Blue `#3E6AE1` | UI 外壳（按钮/链接/导航）只用一支蓝；四级疲劳语义色仅用于数据可视化与报警 |
| 字体 | Universal Sans（专有，不可用） | `Inter, system-ui, PingFang SC, Microsoft YaHei`；Display/Text 同族，只靠字号分层 |
| 字重 | 只有 400 / 500 | `--fw-semibold`/`--fw-bold` 历史令牌全部映射到 500 |
| 字号 | UI 14px、hero 40px 封顶、promo 22px | 正文 14px/1.5 行高；关键安全提示 16px（`--fs-subhead`） |
| 字距 | 默认字距，不用负字距、不用大写转换 | 所有 `--ls-*` 归零；删除全部 `text-transform: uppercase` |
| 圆角 | 按钮 4px、卡片 12px、其余 0 | `--r-sm: 4px`、`--r-lg/xl/2xl: 12px`；`--r-pill`（历史名）映射 4px |
| 阴影 | 全站零阴影 | `--sh-xs/sm/md/lg: none`；卡片靠"浅灰画布 + 纯白面板"底色差分层 |
| 动效 | 0.33s `cubic-bezier(0.5,0,0,0.75)`，只过渡颜色 | `--ease`/`--dur-base`；无缩放、无位移、无视差、无按压 scale |

## 2. 颜色令牌对照

| 令牌 | 浅色 | 深色 | 用途 |
|---|---|---|---|
| `--bg` | `#f4f4f4` Light Ash | `#171a20` Carbon Dark | 页面画布 |
| `--bg-elevated` | `#ffffff` | `#1e2229` | 卡片/面板 |
| `--bg-inset` / `--bg-sunken` | `#f4f4f4` / `#ececec` | `#242932` / `#12151a` | 卡中卡、悬停底 |
| `--text` | `#171a20` Carbon Dark | `#f4f4f4` | 标题主文 |
| `--text-secondary` | `#393c41` Graphite | `#c9cbd0` | 次级文字 |
| `--text-tertiary` | `#5c5e62` Pewter | `#a0a3a9` | 辅助文字/表头 |
| `--text-quaternary` | `#8e8e8e` Silver Fog | `#6b6e75` | 禁用态/占位符（浅底 3.0，仅限此类场景） |
| `--accent` | `#3e6ae1` | `#5a8bf2` | 唯一交互色 |
| `--btn-bg` | `#3e6ae1` | `#3e6ae1` | 主按钮底（白字 4.7，两主题一致） |
| `--separator` | `#eeeeee` Cloud Gray | `#2c3038` | 表格行线/分隔 |
| `--lv-awake/mild/moderate/severe` | 深校准版（白底 ≥4.5） | 高明度版（暗底 ≥4.5） | 四级疲劳可视化 |

语义色裁定：Tesla 规范"无第二种彩色"针对营销页 chrome；本系统的疲劳分级色是**安全功能信息**（数据可视化范畴），予以保留，但不得用于按钮、链接、导航等交互外壳。

## 3. 图标系统（Lucide）

- 来源：[lucide-icons/lucide](https://github.com/lucide-icons/lucide)（MIT），24×24 视窗、2px 圆头描边、`currentColor`。
- 内联于 `web/index.html` 顶部 `<symbol id="i-*">` 库，**symbol id 沿用旧命名**，JS 动态换图标（`#i-pause/#i-play`、`#i-mute/#i-sound`、`#i-sun/#i-moon`）零改动。
- 尺寸体系：16px（卡片标题）/ 17px（导航）/ 18px（按钮）/ 24px（特性卡置顶线稿）。

## 4. 布局骨架

### 导航（单层 56px）
左：logo + 加宽字距 wordmark；中：三视图入口（14px/500）；右：运行状态、专业模式、静音、主题、设置。首页 hero 之上透明悬浮白字（`body:has(#viewHome.active) .global-nav:not(.is-scrolled)`），滚动后（motion.js 加 `.is-scrolled`）切实底。

### 首页（一屏一讯息）
1. hero：Carbon Dark `#171a20` 画幅（对应 Tesla 全屏摄影段），100vh 减导航；白字 40px 标题 + promo 行 + CTA 对（主 Electric Blue 200×44 定宽；次半透明白 176×44）
2. 能力段：白底，2×2 Light Ash 大卡（12px 圆角、无描边无投影）
3. 数字段：40–56px/500 大数字 + Pewter 小字，大留白
4. 收尾段：Light Ash 底 + 主 CTA

### 工作台（车机仪表组）
- 顶部仪表条 `cluster`：左等级芯片+原因 / 中 128px 细环 + 40px 大数字（车速表式）/ 右时长·峰值·均值
- 主区：视频舞台（12px 圆角、零阴影）+ 控制条（4px 矩形按钮，画面/检测分组）+ 图表卡纵列
- 右栏：指标面板（单块白面板内 2 列紧凑行，发丝线分行，左缘 3px 状态色条为功能信息）、检测记录时间线、个人基准值

### 报告（订单页头部模式）
标题摘要靠左、CTA 按钮组靠右；三等分卡片网格 + 全宽曲线/建议/实验工具卡；概要数字 30–32px/500。

## 5. 动效

- 全站过渡统一 `0.33s cubic-bezier(0.5,0,0,0.75)`，只允许 `background-color / color / box-shadow(描线) / opacity`。
- 滚动进场 `[data-reveal]`：纯淡入 + 70ms 组内错峰（motion.js 加 `.is-inview`）。
- 已删除：按压 scale(0.95)、卡片悬停位移/缩放、视差（data-parallax）、磁贴沉入（data-tile-exit）、模糊消散标题。
- `prefers-reduced-motion: reduce` 时全部动效直出终态。

## 6. 硬规则（不得违反）

1. 交互色只有 `--accent` 一支；不引入第二彩色 chrome。
2. 任何组件不加 `box-shadow`（描线用 `inset 0 0 0 1px`，不算阴影）。
3. 不出现胶囊圆角（`border-radius: 9999px`）与全大写文本。
4. 字重不出现 600/700（历史令牌名可引用，值必须是 500）。
5. hover 只变色，不缩放不位移。
6. CSS 变量名不得改名：JS `cssVar()` 与导出报告按名取色（清单见 tokens.css 头注）。
7. 图标 symbol id `#i-*` 不得改名：三处 JS 动态换图依赖。
8. 测试锚点不得移除：全部元素 ID、`.view`×3、`.sheet.open`、`.t-body`、`.metric-label`、`.gn-links a[data-goto]`。

## 7. 变更记录

- 本轮：从 Apple 设计语言整体迁移至 Tesla 设计语言（tokens/base/components/layout/motion/index.html 全量重写，图标库替换为 Lucide）。
