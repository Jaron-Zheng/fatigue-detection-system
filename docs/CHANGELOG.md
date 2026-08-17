# CHANGELOG

本文件逐项记录「系统优化提示词」任务的真实修改内容。
每一项均可在 `system-delivery/comparison/文件变更清单.md` 中找到对应文件，
在 `docs/代码审计报告.md` 中找到问题编号。

## [3.3.0] — 需求变更：HTML 报告统一导出专业版

### 行为变更（export-report.js）

- **无论专业模式开/关，HTML 报告统一导出专业版详细内容**（用户 2026-08
  需求变更）：删除「普通模式剥离 `.pro-only`」的分流路径，统一保留专业
  区块；导出文件 `<body>` 强制携带 `pro-mode` 类，使内联 CSS 的
  `body.pro-mode .pro-only` 复活规则生效——开关只影响在线浏览口径，
  导出物（归档/交付文件）始终给最完整数据。空壳折叠逻辑保留：未运行的
  三张专业分析卡仍折为一行紧凑说明，不出大白板。
- **副标题统一详细口径**：普通模式下在线页面副标题省略采样点数
  （report.js 按模式分流），导出时在克隆中补齐，保证导出文件口径一致。
- **CSV / JSON 与专业模式无关**（原状保持并新增实证）：只依赖
  SessionRecorder 数据，toggle-chaos 新增 T10 断言两种模式下 CSV
  字节级一致、JSON samples/events 一致。

### 测试同步

- `toggle-chaos-test.mjs`：T3/T4/T5 断言反转为新口径（普通导出必须含
  专业区块 + body 强制 pro-mode + 副标题补采样点 + 复活规则在），
  新增 T10（CSV/JSON 模式无关），24/24 通过。
- `final-acceptance.mjs`：现象 A 复测口径更新——A1/A1b/A2/A3 改为
  「两模式导出统一专业版、字节级一致」，8/8 通过。
- `batch4-consistency-test.mjs`：角色 10 四组合断言改为统一专业版口径，
  22/22 通过；回归 chaos 20/20、ui-audit 56/56、eslint 0 error。

## [3.2.0] — 第五轮遗留项清零：数值钳制、测试防抖、跨内核实测

### 安全加固

- **数值参数范围钳制（config.js）**：新增 `NUMERIC_LIMITS` 区间表（47 条
  路径，支持 `*` 通配段），`deepMerge` 落值前按「配置路径 → {min,max}」
  钳制。此前 localStorage 写入同类型越界值（如 `durationSec: -999`）会被
  原样接受；现收到最近合法边界，正常调参不受影响（区间宽于 UI 滑块）。
  回归测试 [1.1] 新增 8 条钳制断言；security-test 浏览器端断言同步升级。

### 测试工具链

- **ui-audit 防抖（tools/ui-audit.mjs）**：新增 `waitUntil` 轮询断言，
  「演示会话进入 running」与「三种导出产生下载」从固定 sleep 后立即
  断言改为等待式（总回归连跑第 55 步下载计数抖动的根因修复）。
- **跨内核实测套件（tools/cross-browser-test.mjs）**：Firefox(Juggler
  153) + WebKit(26.5，Safari 同引擎) 各 12 项断言：启动/三视图/演示
  全流程/三种导出/专业模式/主题/控制台零报错。实测 24/24 通过。
  过程中定位并记录 WebKit 特有行为：祖先 display:none 时后代
  getComputedStyle().display 也返回 none，断言已按激活视图过滤。

### 清理

- 删除无引用的遗留临时服务器 `_serve.js`（lint no-undef error 清零，
  full-verify 门禁恢复全绿：静态 + 回归 137 + 集成 41 + typecheck + lint）。

## [3.2.1] — 第六轮开关混沌：专业/普通报告同质 bug 根修

### Bug 修复（export-report.js）

- **专业模式导出报告与普通模式一样（用户实测报告）**：根因是「空壳折叠」
  逻辑不区分模式——普通模式导出时，未运行的三张专业分析卡被折成可见的
  「本次会话未运行」说明文字（专业术语泄漏给普通用户）；专业模式导出时
  同样折成这行文字，两份文件肉眼一模一样。修复为按模式分流：
  普通模式从导出克隆中整体剥离全部 `.pro-only` 元素（页面上看不到的，
  报告里就不该有）；专业模式保持空壳折叠为一行紧凑说明。

### 测试工具链

- 新增 `tools/toggle-chaos-test.mjs`（21 项断言）：开关状态一致性混沌——
  开→关→开×5 状态真伪、专业/普通导出 body 类与内容互斥、导出与切换
  竞态下的文件状态自洽、深色主题+专业导出、刷新后 localStorage 持久化、
  无数据导出按钮禁用、网格/镜像/HUD 乱切后 aria/class/CONFIG 三方一致、
  设置改后不保存等于没改。修复后 21/21 通过；混沌 20/20、数据对账、
  探索 19/19、`verify:full`（137+41）全部复跑通过。

## [3.1.0] — 真人反馈修复：导航高亮、首页主题化、插画重做

### 缺陷修复

- **导航当前页高亮不可见（layout.css）**：导航三入口的激活态原来只改
  透明度 0.78→1，用户看不出点击后已跳转；改为 Electric Blue 文字高亮
 （hero 融合态下自动换亮蓝），一眼可辨。
- **视图切换滚动改瞬时（view-router.js）**：`scrollTo smooth` 与视图重排
  叠加会产生一段"看着没反应"的过渡，改为立即归顶，切换手感干脆。

### 首页跟随主题（默认亮色，暗色模式才变暗）

- **tokens.css**：新增 `--hero-*` 与 `--feat-*` 两套主题令牌
 （浅色：白底 hero + Light Ash 卡；深色：Carbon Dark hero + 微亮面板）。
- **layout.css / index.html**：hero 从固定 Carbon Dark 改为跟随主题；
  导航融合态同步跟随 hero 底色；能力卡/收尾段两套底色。

### 首页插画重做

- 原来的人脸线稿（大圆脸+关键点）整张移除，重做为 Tesla 车机 HUD 风格的
  「驾驶舱预览」：透视路面 + Electric Blue 车道线 + 220° 疲劳仪表弧 +
  状态芯片与微型指标；全部颜色走 `--hero-*` 令牌，浅/深主题自动适配。

### 其他

- **app.js**：启动控制台日志颜色从 Apple 蓝 #0071e3 换为 Electric Blue。
- **tools/design-audit.mjs**：R8 允许 hero 融合态下的白色导航底。
- 图注颜色升到 --hero-muted（白底 5.9:1，修复 axe serious）。
- 全套验证重跑：check / ui-smoke 14 / a11y 14（serious 清零）/
  design-audit 14 / lint / typecheck 全部通过；浏览器 MCP 真实点击
  走通导航、演示检测、报告、设置抽屉、专业模式、主题切换全流程。

## [3.0.0] — UI 全量重构：Apple 设计语言 → Tesla 设计语言

以 `awesome-design-md-main/design-md/tesla/DESIGN.md` 为基准，图标、颜色、
布局、交互全部推翻重做（非换肤）：图标库替换为 Lucide、三个视图骨架重排、
导航/抽屉/报警/动效全部重写。CSS 变量名、元素 ID、测试锚点全部保留，
检测算法层（web/js/core）零改动。

### 设计令牌与样式（web/css/*，全量重写）

- **tokens.css**：色板换为 Tesla（Electric Blue `#3E6AE1` 唯一交互色、
  Carbon Dark `#171A20`、Graphite/Pewter/Silver Fog、Light Ash/Cloud Gray）；
  字阶压缩到 14px 体系、字重只留 400/500、圆角只留 4/12px、阴影全归零、
  动效统一 `0.33s cubic-bezier(0.5,0,0,0.75)` 且只过渡颜色。变量名全部不变。
- **base.css / components.css / layout.css / motion.css**：胶囊按钮改 4px 矩形、
  卡片靠底色差分层、零投影、删除按压 scale/悬停位移/视差/模糊进场，
  进场动效改为纯淡入。

### 图标系统（web/index.html）

- 22 个自绘 SVG 全部替换为 Lucide 官方 path（MIT，24×24/2px 描边），
  新增 8 个布局所需图标；symbol id 沿用旧命名，JS 动态换图零改动。

### 布局骨架重排（web/index.html + layout.css）

- 导航：Apple 双层（44px 黑条 + 52px 毛玻璃）→ Tesla 单层 56px；
  首页 hero 上与 Carbon Dark 画幅融合，滚动后切实底（motion.js 同步适配）。
- 首页：磁贴交替结构 → Tesla 全幅段落（Carbon Dark hero + 白底能力段 +
  大数字段 + Light Ash 收尾 CTA），hero 内容居中、CTA 双按钮 200/176px 定宽。
- 工作台：新增横贯全宽的「仪表条」（等级/原因 + 128px 细环大数字 +
  时长峰值均值）；右侧指标改为单块白面板内 2 列发丝线分行。
- 报告：头部改 Tesla 订单页模式（左标题摘要/右 CTA 组），概要数字放大。
- 报警横幅：Carbon Dark 底 + 左侧等级色条 + 4px 圆角。

### 工具与文档

- **tools/design-audit.mjs**：审计规则从 Apple 十条改写为 Tesla 十条
  （单一强调色/零投影/14px 正文/无 600-700 字重/无缩放按压/圆角阶梯/
  零装饰渐变/导航底色/行高/无大写），实测 14/14 通过。
- **docs/DESIGN.md**：重写为 Tesla 规范映射与项目裁定（含硬规则清单）。
- 截图证据：`docs-evidence/tesla-redesign/`（浅/深/1366/390 全套 13 张）
  与 `docs-evidence/design-audit/`。

### 验证

- `npm run check` 静态检查全过；回归测试 125/125；
- `ui-smoke` 14/14（演示模式全链路无控制台错误）；
- `a11y-test` 14/14（全部场景 critical/serious 清零，含深色实心按钮改用
  `--btn-bg` 保证 AA）；`design-audit` 14/14；`lint`/`typecheck` 无错误。

## [2.1.0] — 按《项目优化提示词》十阶段执行：补测试 + 局部优化

本轮严格按「先侦察、再基线、后改动、强验证」执行。先建立基线
（静态检查 5/5、回归 31/31、集成 41/41 全部通过），再针对审计发现的
测试盲区与性能热点做局部、可回退、可验证的修改。**未做任何无证据的大规模重写。**

### 测试补强（新增 49 条断言，回归测试 31→80 通过）

- **tools/regression-test.mjs**：新增 7 组回归测试，补齐此前无保护的
  关键路径：
  - `[8] TimeWindow` 滑动窗口：驱逐/回绕/缩短扩容；
  - `[9] TimeWeightedWindow` PERCLOS 时间加权：间断丢弃/interrupt/收敛性；
  - `[10] EventWindow` 事件频率：驱逐/归一化；
  - `[11] AlarmSystem` 报警策略：冷却/升级立即/等级语义；
  - `[12]` 数值工具：角度归一/隶属函数/时长/欧拉角；
  - `[13]` 服务端非法端口校验（子进程实测退出码与报错）；
  - `[14] SessionRecorder` 长会话容量控制（受控时钟精确断言驱逐位置）。

### 性能优化（证据驱动）

- **web/js/core/recorder.js**：样本容量控制由逐条 `shift()`（长会话下每次采样
  O(n) 拷贝 7200 元素数组）改为「批量驱逐 + 摊销」（容忍 64 条溢出后一次性截除），
  把数组拷贝从每 500ms 一次降为约每 32 秒一次。接口语义不变，新增回归测试 `[14]` 保护。

### 缺陷修复

- **web/js/ui/chart.js**：`ctx.font` 原写成 `'10px var(--font-sans, ...)'`，
  Canvas 2D 的 font 解析器不支持 `var()`，被判为非法值静默忽略，刻度文字
  回退到默认 sans-serif、与全站 SF Pro 字族脱节。改为具体字族栈常量 `CHART_FONT`。

### Apple 设计规范对齐（DESIGN.md）

- **web/css/layout.css**：舞台遮罩由 `linear-gradient(180deg, 0.86→0.94)` 改为
  均一的 `rgba(10,10,11,0.90)`，消除一处不必要的装饰性渐变（上下差异肉眼不可辨）。
  全站其余渐变仅为滑块轨道填充（iOS 原生控件样式）与图表面积填充，属功能性用法，保留。

### 运行时适配（本机无独立 Node 时的验证手段）

- 本机未安装独立 Node.js。验证通过 IDE 内置 Electron（`ELECTRON_RUN_AS_NODE=1`）
  作为 Node v24.15 运行时驱动全部检查与测试，结论不受影响。
  交付物本身仍要求 Node ≥18（见 README）。

### DevOps：一条命令全量质量门禁

- **tools/full-verify.mjs**（新增）：静态检查 → 回归测试 → 自动起临时服务器
  （默认 127.0.0.1:5210）跑集成/安全测试 → 自动关闭，任一步失败即非零退出，
  可直接接入 CI。实测全链路 5 + 80 + 41 全部通过。
- **package.json**：新增 `verify:full` 脚本；README 测试章节同步更新。

### 回退策略

- 整项目回退点：`system-delivery/original/system/`（基线完整快照）与
  `system-delivery/final/system/`（第一轮交付快照）均不受本轮改动影响。
- 本轮仅触及 6 个文件，逐项可单独回退：
  `web/js/core/recorder.js`（恢复逐条 shift）、`web/js/ui/chart.js`（恢复原 font 字符串）、
  `web/css/layout.css`（恢复渐变）、`tools/regression-test.mjs`、
  `tools/full-verify.mjs`（新增，删除即可）、`package.json`（移除 verify:full）。
- 回退后验证：`npm run verify`（或 `npm run verify:full`）。

## [2.0.0] — 全项目审计、加固与交付整理

### 安全加固

- **server/server.js**：新增全套安全响应头——`Content-Security-Policy`
  （`default-src 'self'`、`frame-ancestors 'none'`、脚本仅允许同源与
  `wasm-unsafe-eval`）、`Cross-Origin-Opener-Policy: same-origin`、
  `Cross-Origin-Resource-Policy: same-origin`、
  `Permissions-Policy`（摄像头仅同源，麦克风/地理位置/支付/USB 全部禁用）、
  `Referrer-Policy: no-referrer`。已验证不破坏 WASM 流式编译与 ES Module 加载。
- **server/server.js**：`resolvePort()` 支持 `--port` 参数与 PORT 环境变量，
  并对非法端口值给出中文错误提示后退出（原先直接 `NaN || 5180` 静默吞掉非法值）。
- **server/server.js**：`resolveSafe()` 路径校验强化——新增拒绝不以 `/` 开头
  与包含反斜杠 `\` 的解码路径，堵住 Windows 分隔符与相对路径形态的
  目录穿越变体（原有仅校验空字节与越界）。
- **web/js/config.js**：重写本地配置合并（`deepMerge`）。
  新增类型校验（数字字段拒绝非数字/NaN/Infinity 覆盖）、
  原型污染防护（忽略 `__proto__`/`constructor`/`prototype` 键）、
  仅覆盖配置对象中已存在的字段。配套回归测试 `[1.1] 本地配置安全合并`。
- **web/js/util/dom.js**：`el()` 工具函数的 `html` 属性由 `innerHTML`
  改为 `textContent`，从工具层根除 DOM 注入面。
- **web/js/ui/report.js**：报告摘要 pill 条由 `innerHTML` 拼接改为
  DOM API 构建（`createTextNode` + `el()`）。
- **web/js/core/video-source.js**：视频离线评测的文件校验——
  空文件、超过 1GB、非 video MIME 均给出明确中文错误；
  `release()` 增加 video 元素清理（pause + 移除 src + load()），
  避免 blob URL 释放后视频元素仍持有解码资源。
- **web/js/ui/analysis-ui.js**：离线复现 CSV 导入校验——空文件、
  超过 32MB、非 CSV 格式拒绝。
- **web/js/ui/evaluation-ui.js**：标注 JSON 导入校验——空文件、
  超过 2MB、非 JSON 格式拒绝。

### 无障碍

- **web/js/ui/settings.js**：设置抽屉新增 Tab 焦点陷阱——
  打开期间 Tab/Shift+Tab 在抽屉内可聚焦元素间循环，
  不会跑出抽屉到被遮罩的页面；Escape 关闭保留。

### 一键启动

- **tools/launch.js**：新增 Node.js 版本检查（要求 ≥18），
  版本过低时输出中文说明并以非零码退出。
- **一键启动.ps1**（新增）：PowerShell 启动入口，支持 `-Port` 与
  `-NoBrowser` 参数，同样含 Node 版本检查。
- **package.json**：新增 `check`（静态检查）、`test`（回归测试）、
  `verify`（两者串联）脚本；`engines.node >= 18` 与启动器检查一致。

### UI 细化

- **web/index.html + web/css/motion.css**：首屏四张能力卡新增
  `data-hover-card` 悬停微交互（6px 轻推 + 1.008 缩放 + 图标跟随上浮），
  仅在 `hover:hover` 且 `pointer:fine` 且未开启减弱动效时生效，
  触屏设备保持静态。
- **web/css/tokens.css**：新增 `--dur-hover`、`--card-hover-lift`、
  `--card-hover-scale` 设计令牌。
- **web/css/layout.css**：报告摘要 pill 字重由 500 改为 400
  （遵守「Apple 字阶不用 medium」的设计规则）；feat 卡片与图标
  补充 transform 过渡。
- **web/css/components.css**：`.card-hover` 过渡补充 transform 维度。

### 测试与工具

- **tools/project-check.mjs**（新增）：静态检查——必需文件清单、
  全部 JS 语法（vm.SourceTextModule 解析）、HTML id 唯一性、
  本地资源引用完整性、安全基线（innerHTML/外部域名/上传端点扫描）。
- **tools/integration-test.mjs**（新增）：服务器集成与安全测试——
  关键资源 MIME、安全响应头、目录穿越（原始请求绕过 fetch 规范化）、
  空字节注入、405/404 行为、Range 请求与 wasm 魔数校验、首页离线可用性。
- **tools/regression-test.mjs**：新增 `[1.1] 本地配置安全合并` 测试组
  （4 条断言）。

## [1.0.0] — 基线版本

毕业设计原始功能版本：核心检测链路、三视图单页应用、
参数敏感性/权重消融/视频离线评测三套实验工具。
原始副本完整保存在 `system-delivery/original/system/`。
