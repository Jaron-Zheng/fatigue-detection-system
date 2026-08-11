# Apple 设计语言保真度审计报告

> 第三轮角色十五产出。审计方式：不读代码猜——用无头浏览器真实加载页面
> 读 computed style（`tools/design-audit.mjs`），配合截图取证
> （`docs-evidence/design-audit/`）与字面量静态检测（`tools/check-literals.mjs`）。
>
> 执行环境：Windows，Edge 无头，1920×1080　执行日期：2026-08-11

## 一、令牌落地一致性（任务 15.1）

**人工排查结果**：`components.css` + `layout.css` 共 67 处字面量颜色，逐处处置：

| 处置 | 数量 | 说明 |
|---|---|---|
| 改为令牌引用 | 11 | 报警发光阴影 6 处 → `rgba(var(--glow-*), α)`；Sky Link Blue 复述 3 处 → `rgba(var(--link-on-dark-rgb), α)`；新增 `--*-rgb` / `--glow-*` 分量令牌（浅/深双主题），发光阴影从此随主题自动切换 |
| 人工裁决保留（`lit-ok` 标记） | 22 | 语义色实心底上的白字、滑块/开关白色把手、视频浮层白字、打印白纸黑字、插画固定暗色等——均主题无关，标记内含理由 |
| 自动放行（中性黑白/近黑遮罩） | 34 | `rgba(0,0,0,α)` / `rgba(255,255,255,α)` 等，检测器内建豁免 |

**检测脚本**：`tools/check-literals.mjs`，已接入 `npm run check`（第 6 类检查）。
拦截能力实测（`--selftest` 真实输出）：

```text
✓ 自检通过：2 处违规被拦截（#e5322d、rgba(0,113,227,.4)），令牌引用/中性色/lit-ok 正确放行
```

真实扫描与集成结果（`npm run check` 真实输出）：

```text
✓ 设计令牌一致性检查通过（4 个样式文件无字面量颜色）
=== 结果：全部静态检查通过 ===   （6 类）
```

## 二、DESIGN.md「Do's and Don'ts」逐条核对（任务 15.2）

审计脚本 15 项断言全通过（真实输出摘录）：

```text
✓ R1 单一强调色：交互元素无第二支强调色（基色 #0071e3）
✓ R2 卡片/按钮/文字零投影
✓ R2 阴影只保留给浮层（实测有阴影的浮层：.stage, #sheet, #alarmBanner）
✓ R3 正文 17px（body=17px, .t-body=17px；tile 导语 19px 属展示层不算正文）
✓ R3 正文 400 / 字距 -0.374px
✓ R4 全站无 font-weight:500
✓ R5 --press-scale = 0.95 + 4 条 :active scale 规则
✓ R6 圆角只用令牌阶梯（实测集合：11px, 18px, 50%, 5px, 8px, 980px）
✓ R7 零装饰性渐变（滑块功能性填充除外）
✓ R8 全局导航黑色玻璃（rgba(0,0,0,0.8)，与 apple.com 实测同构）
✓ R9 正文行高 ≥1.47（实测 1.70）
✓ R10 --link-on-dark 仅用于深色上下文
=== 结果: 15 通过, 0 失败 ===
```

**带原因的例外（均记录，不含糊）**：

1. **R6 微装饰豁免**：图例色块（宽高 ≤12px 的 `<i>` 小方点）用 2/3px 圆角，
   不在容器级圆角语法约束范围——Apple 自己的圆角语法也只约束容器。
2. **R7 滑块豁免**：`input[type=range]` 的 linear-gradient 是"已填充比例"的
   功能性进度指示（settings.js `syncFill` 写入 `--pct`），DESIGN 禁止的是
   装饰性氛围渐变，二者性质不同。
3. **R8 玻璃导航**：`rgba(0,0,0,0.8) + backdrop-blur` 与 apple.com 全局导航的
   实测 computed style 同构（半透明黑玻璃），视觉呈现即"唯一纯黑区域"。
4. **R10 插画豁免**：`.vision-*` 是首页插画内部的暗色屏幕绘图（fill 为 tile-dark 系），
   属于"深色表面上的内容"，虽页面本身是浅色。

截图证据：`docs-evidence/design-audit/audit-{home,work}-{light,dark}.png`。

## 三、本项目组件 → 设计语言映射（任务 15.3）

| 本项目组件 | 对应 DESIGN.md 语言条目 | 落地情况 |
|---|---|---|
| 疲劳指数环形仪表 | 字阶 display 数字（font-display/600/tabular-nums）+ 单一强调色原则 | 数字 42px display；进度条颜色按等级取语义色（状态信息）；零阴影 |
| 六张指标卡 | utility card：描边分层、零阴影、rounded.lg | `inset 0 0 0 0.5px` 轮廓 + 18px 圆角；R2 实测零投影 |
| 视频悬浮控制按钮（识别点/镜像/实时数值） | pill 胶囊（rounded.pill）+ 图像上的玻璃态 | `.pill-sm` + 半透明黑底 blur；白字（lit-ok 标记） |
| 顶部导航与专业模式/主题切换 | 44px surface-black 全局条 + pill 动作元素 | 实测 44px、黑色玻璃；切换按钮为 pill-sm |
| 检测记录时间线 | 列表行 + 语义状态点 | tl-icon 用 `-soft` 底 + 语义色图标，文字双通道 |
| 报警横幅/光幕 | 唯一允许的阴影使用场景（浮层）+ 语义状态色 | sh-lg 级发光（`--glow-*` 令牌），白字/近黑字达标 AA |
| 设置抽屉 | 浮层（modal 层）+ 单一阴影 | `#sheet` sh-lg 实测有阴影；内部全令牌控件 |
| 报告页图表区 | card + 描边 + 无阴影；图表色取自 CSS 变量 | chart.js 按 `cssVar()` 取色随主题重绘（本轮修复了色带残留色的真实缺陷） |

说不出对应条目的组件：**无**——每个组件都能定位到令牌/组件条目；
DESIGN.md 中苹果官网专属组件（product-tile 购买磁贴、configurator-option-chip、
Add to Bag）本项目无对应场景，按任务要求**未照搬**。

## 四、Windows 字体栈实测（任务 15.4）

`tools/font-check.mjs` 真实输出（本机 Windows NT 10.0）：

```text
字体栈："SF Pro SC", "SF Pro Text", "SF Pro Icons", "PingFang SC",
        "Helvetica Neue", "Microsoft YaHei", Helvetica, Arial, sans-serif
  ✓ 可用：SF Pro SC / SF Pro Text / PingFang SC / Helvetica Neue / Microsoft YaHei / Arial
  ✓ 可用：Inter（本机装有，但项目刻意不引用）
```

- 本机装有 SF Pro 字体族，命中栈首；未装的典型 Windows 机器落到 Microsoft YaHei——
  **两条路径都是中西文一体字体**，PERCLOS / EAR / MAR / GPU / FPS 等英文缩写
  与中文混排观感统一。
- **不采用 DESIGN.md 字面的 Inter 建议**：Inter 是纯拉丁字体、不含中文字形，
  照抄会让中文二次回落到末位字体，中西文割裂。该建议是给英文正文写的，
  对全中文界面不适用。
- 截图证据：`docs-evidence/design-audit/font-check-pro-{light,dark}.png`
  （专业模式指标卡，含英文缩写混排）。

## 五、与角色六的对比度裁决（任务 15.6）

原则：**安全相关信息优先 WCAG AA，装饰性文字可贴近 DESIGN.md 原值**。
逐条裁决表见《UI设计说明.md》"与无障碍（WCAG）的对比度裁决记录"一节
（6 个冲突点：4 项 WCAG 优先改令牌、1 项保留 DESIGN 选择、1 项安全最高优先级）。
