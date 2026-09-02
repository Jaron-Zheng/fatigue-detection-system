# 基于面部多特征融合的 Web 端驾驶员疲劳检测系统

本科毕业设计。在浏览器内完成全部人脸关键点推理与疲劳判定，采用**几何-语义双通道融合**方案，
融合 PERCLOS、眨眼动力学、哈欠、点头与头部姿态五类面部特征，实时输出 0–100 疲劳指数与四级预警。

**无需安装、无需联网、无需上传任何画面。** 所有视频帧只在本机浏览器内处理，
既不经过服务器，也不写入磁盘。

---

## 快速开始

双击 **`一键启动.bat`**。脚本会启动本地服务器并自动打开浏览器。

首次运行需要授权摄像头。页面加载后点「开始检测」，系统会先花 5 秒记录你睁眼时的
样子（个人校准），然后进入实时检测。

### 前置条件

- **Node.js 18 或更高**（只用内置模块，**不需要 `npm install`**）
- Chrome / Edge 等支持 WebAssembly + WebGL 的现代浏览器
- 摄像头

### 手动启动

```bash
npm start          # 启动并自动打开浏览器
npm run serve      # 启动但不打开浏览器
```

默认地址 `http://127.0.0.1:5180`。

> 必须通过 `http://127.0.0.1` 访问，不能用 `file://` 直接打开 `index.html`。
> 浏览器只在安全上下文（HTTPS 或 localhost）里授予摄像头权限，
> 且 ES Module 与 WebAssembly 也受同源策略限制。

---

## 界面说明

### 简洁模式与专业模式

顶栏有一个「**专业模式**」开关，默认关闭。

- **关闭时**：只显示普通人能直接读懂的内容——疲劳指数、六个中文指标卡、
  趋势图、检测记录、报告结论与建议。
- **打开时**：额外展开原始特征值（EAR / MAR / 三个欧拉角）、疲劳分数构成明细、
  个人基准值、全部算法参数滑块，以及三套实验分析工具。

这样分层而不是删除，是因为技术面板是毕业设计的实验数据来源，写论文与答辩时需要，
但日常使用时会造成认知负担。开关状态会记住。

### 三套实验工具（专业模式，报告页）

| 工具 | 用途 |
|---|---|
| **参数敏感性分析** | 把本次会话的指标序列在多组参数下离线重算，找出"稳定平台区"，回答"为什么阈值取这个值" |
| **权重消融实验** | 逐项扣除某指标的贡献，量化每个特征的实际作用 |
| **视频离线评测** | 导入录制好的视频 + 人工标注，输出混淆矩阵、灵敏度、特异度与响应延迟 |

视频评测的完整操作流程见 [`docs/视频评测指南.md`](docs/视频评测指南.md)。

### 演示模式

设置面板里的「演示模式」不使用摄像头，按预设剧本合成一段由清醒到重度疲劳的
完整过程。用于答辩现场演示报警链路——不可能要求答辩时真的睡着一次。

---

## 目录结构

```
一键启动.bat              Windows 启动器（纯 ASCII，中文提示由 server.js 输出）
package.json              仅声明脚本，无运行时依赖
LICENSE                   MIT 许可
app-icon.ico / .png       应用图标
brand/                    品牌素材（矢量母版、logo）

server/server.js          零依赖静态服务器（安全头 + 路径穿越防护 + 端口自选）

web/index.html            单页应用，三个视图：首屏 / 工作台 / 报告
web/css/                  tokens → base → components → layout → motion
web/favicon.svg           站点图标
web/manifest.json         PWA 清单
web/sw.js                 Service Worker（离线缓存）
web/vendor/               MediaPipe Face Landmarker 模型与 WASM（本地化，离线可用）

web/js/app.js             主控制器：状态机 + 主循环 + 模块编排
web/js/config.js          全部算法参数集中于此，含取值依据注释
web/js/test-hooks.js      测试锚点（不参与运行时）

web/js/core/              算法层（与 UI 完全解耦）
  face-engine.js            MediaPipe 封装，GPU 委托 + 自动回退 CPU
  features.js               特征层：EAR / MAR / 欧拉角 / blendshape 双通道
  calibration.js            个性化基线校准
  quality.js                数据质量门控（取景 + 光照）
  indicators.js             指标层：PERCLOS / 闭眼时长 / 眨眼 / 哈欠 / 点头 / 偏离
  fusion.js                 融合层：隶属函数 + 加权 + EMA + 四重防抖
  alarm.js                  分级声光报警 + 语音播报
  recorder.js               会话记录、报告汇总、JSON / CSV 导出
  csv-schema.js             CSV 列定义（导出与导入的唯一真相来源）
  analysis.js               敏感性分析、权重消融、CSV 离线复现
  evaluation.js             准确率指标计算（混淆矩阵、响应延迟）
  evaluator.js              视频离线评测执行器（固定步长）
  video-source.js           视频逐帧抽取与区间标注
  sim-driver.js             合成驾驶员（演示模式）
  landmarks.js              关键点索引常量
  preflight.js              启动自检
  render-loop.js            渲染循环
  session-state-machine.js  会话状态机

web/js/ui/                展示层（仪表盘 / 图表 / 覆盖层 / 报告 / 设置 / 时间线等）
web/js/util/              数学、DOM、环形缓冲工具

packager/                 打包配置
  sea-launcher.js           SEA 启动器源码（注入 node.exe 生成 launcher.exe）
  fatigue-detection.iss     Inno Setup 安装脚本

tools/                    开发与打包工具
  fetch-vendor.js           一次性拉取 MediaPipe 资源到 web/vendor
  build-sea.cjs             构建 SEA launcher（把启动逻辑注入 node.exe）
  build-installer.cjs       一键编译完整安装包（SEA + Inno Setup）
  download-tools.cjs        下载打包所需工具（Node.js portable + Inno Setup + postject）
  build-icons.cjs           从栅格化产物重建 app-icon.png / .ico
  build-copyright-docs.cjs  生成软著登记鉴别材料
  deploy-github.cjs         部署到 GitHub Pages（git push 方式）
  deploy-github-api.cjs     部署到 GitHub Pages（API 上传方式）

docs/技术文档.md           算法原理、参数依据、实测数据、评测方法论、已知局限
docs/双通道融合技术论述.md   几何-语义双通道融合的创新点、实测数据与设计决策
docs/系统测试报告.md        功能测试、对抗场景、基线对比、PWA离线、长会话稳定性
docs/视频评测指南.md        视频离线评测操作流程
docs/UI设计说明.md          Apple 风格设计系统与页面结构
docs/启动故障排查.md        常见问题处理
docs/安装包错误穷举与修复方案.md  安装包排查
docs/安装许可协议.txt        安装许可
docs/架构图.svg            系统架构图
docs/执行摘要.pdf           项目摘要
docs/DESIGN.md             设计规范

docs-evidence/准确率评估报告.md     四轮优化历程与最终指标（灵敏度86.4%/特异度100%）
docs-evidence/实验报告.md           参数敏感性、消融实验、基线对照的完整数据
docs-evidence/答辩要点与交付清单.md  答辩准备用要点索引
docs-evidence/figures/             论文实验数据与图表（CSV + SVG + PNG）
```

数据流是单向的，便于调试与论文画图：

```
摄像头帧
   ↓ FaceEngine（WASM 推理，MediaPipe Face Landmarker）
478 关键点 + 52 blendshape + 4×4 姿态矩阵
   ↓ FeatureExtractor
EAR / MAR / pitch,yaw,roll / 语义系数              ← 特征层（几何+语义双通道）
   ↓ IndicatorEngine（滑动窗口 + 状态机）
PERCLOS / 闭眼时长 / 眨眼率 / 哈欠 / 点头 …         ← 指标层
   ↓ FusionEngine（隶属函数 + 加权 + EMA + 趋势加速器 + 滞回）
疲劳指数 0–100 + 四级等级                          ← 融合层
   ↓
AlarmSystem / Dashboard / SessionRecorder
```

---

## 导出的数据

报告页可导出四类文件，CSV 均带 UTF-8 BOM、中文表头，Excel 双击即可打开：

| 文件 | 内容 |
|---|---|
| `疲劳检测指标_*.csv` | 指标时序，21 列。可再导入「离线复现」重跑 |
| `疲劳检测报告_*.json` | 完整数据：参数、汇总、采样序列、事件列表 |
| `敏感性分析_*.csv` / `权重消融实验_*.csv` | 实验结果表 |
| `视频评测逐点数据_*.csv` / `视频评测指标汇总_*.csv` | 评测明细与准确率指标 |

导出文件**不含任何图像数据**。

---

## 实验数据与论文素材

所有实验数据均可通过 `node tools/accuracy-eval.mjs` 一键复现，输出到 `docs-evidence/figures/`：

| 数据/图表 | 文件 | 说明 |
|---|---|---|
| 核心指标 | `accuracy-summary.csv` | 灵敏度86.4%/特异度100%/F1 0.927/MCC 0.702 |
| 基线对照 | `baseline-comparison.csv` | 5组PERCLOS阈值 vs 融合 |
| 参数敏感性 | `sensitivity-analysis.csv` | 5参数×多取值的稳定区间分析 |
| 权重消融 | `ablation-analysis.csv` | 逐项移除7指标后的分数变化 |
| 对抗场景 | `adversarial-summary.csv` | 6类干扰场景零误报验证 |
| 调参实验 | `param-tuning-results.csv` | 10组参数对比实验 |
| ROC/PR曲线 | `ROC曲线.svg` / `PR曲线.svg` | AUC=0.9999 |
| 基线对比图 | `基线对比.svg` | 灵敏度柱状图 |
| 消融实验图 | `消融实验.svg` | 权重贡献柱状图 |
| 检出延迟图 | `检出延迟.svg` | 10轮延迟柱状图 |
| 敏感性曲线 | `敏感性-*.svg` | 5张各参数敏感性曲线 |

详细分析见 [`docs-evidence/准确率评估报告.md`](docs-evidence/准确率评估报告.md)。

---

## 测试

```bash
npm run check     # 静态检查：文件完整性 / JS 语法 / HTML id 唯一 / 安全基线
npm run test      # 回归测试：CSV 往返 / 模拟链路 / 语义否决 / 评测指标等
npm run verify    # 两者串联
npm run verify:full  # 全量质量门禁：静态 + 回归 + 自动起服务器跑集成/安全测试

# 集成/安全测试（需先启动服务器，verify:full 会自动处理）：
node tools/integration-test.mjs --port 5180
```

最近一次完整结果见 [`docs/系统测试报告.md`](docs/系统测试报告.md)（175项回归测试 + 6项静态检查 + 6类对抗场景）。

---

## 开发者工具链（可选）

以下命令仅供开发时使用，**需要先执行一次 `npm install`**（依赖全部在
`devDependencies`，不进入运行路径）。答辩 / 评审现场与普通使用者
**完全不需要**执行这一节里的任何命令：`npm start` / 一键启动保持零安装。

```bash
npm install           # 一次性安装开发依赖（typescript / eslint / prettier）
npm run typecheck     # tsc --noEmit 类型检查（仅检查，不产出编译产物）
npm run lint          # ESLint（flat config，重点拦截 == 误用/未用变量/数值陷阱）
npm run format:check  # Prettier 格式检查（存量代码未强制重排，只约束新增代码）
```

类型检查覆盖范围：`web/js/config.js` + `web/js/core/` + `web/js/util/`
（算法与数据链路；UI 层暂未纳入）。关键数据类型已 JSDoc 化：
`AppConfig`（配置形状）、`FeatureSample`（特征层输出）、`CalibrationResult`（标定结果）、
`ReplayPatch/ReplayResult`（离线重算）等。

### 打包安装包（可选）

```bash
node tools/download-tools.cjs   # 下载 Node.js portable + Inno Setup + postject
node tools/build-installer.cjs   # 一键编译完整安装包（SEA + ISCC）
```

输出：项目根目录 `疲劳检测系统_Setup_v1.0.0.exe`

---

## PWA：离线安装与演示模式（可选）

系统可"安装"为独立窗口的本地应用，并在断网时继续运行。**默认关闭**，
避免与开发模式的 `no-store` 缓存策略冲突：

| 操作 | 效果 |
|---|---|
| 访问 `/?pwa=1` | 注册 Service Worker 并记住开关；之后可经浏览器"安装应用"入口装为独立窗口 |
| 访问 `/?pwa=0` | 注销 SW、清空缓存、关闭开关（回到开发模式，改完代码刷新即生效） |

- 缓存策略：源码 network-first（在线永远拿最新代码，离线回退缓存）；
  `vendor/` 模型与 WASM cache-first（锁定版本不变，离线免下载 26MB）。
  缓存版本号在 `web/sw.js` 的 `CACHE_VERSION`，升级时改它即可自动清旧缓存。
- 断网能力已实测：`node tools/pwa-offline-test.mjs`（12/12 通过，
  含断网重载首页与断网跑演示模式）。
- 开发时若发现页面"不更新"：大概率是 SW 开着——访问 `/?pwa=0` 即可。

---

## 隐私

- 视频帧只在浏览器内存中处理，不上传、不落盘
- 本地服务器只提供静态文件，不接收任何上传
- 关闭网页后不留下任何影像数据
- 全部依赖（模型 3.6MB、WASM 22MB，合计约 26MB）已本地化，断网可用

---

## 已知局限

写论文时必须如实说明的部分，详细数据与推导见 [`docs/技术文档.md`](docs/技术文档.md)
的「实测结果」与「已知局限」两章：

1. **EAR 对头部姿态敏感，且方向不对称。** 俯仰方向会让 EAR 系统性偏低
   （实测大幅俯仰时超过 90% 的帧跌破个体闭眼线），侧转方向反而让 EAR 偏高。
   系统用 blendshape 语义通道交叉验证来抑制前者，用数据质量门控排除后者。
2. **参数为单被试标定值。** 校准逻辑本身是个性化的，但若干融合参数
   （尤其是语义否决阈值 0.40）的取值依据来自单人实测，跨人群适用性需多被试验证。
3. **准确率未经规模化验证。** 视频评测工具已就绪，但缺少多被试标注数据集，
   现有结论只能说明系统在受控条件下可用，不能外推为普适准确率。
4. **主观标注的固有噪声。** 评测采用二分类（正常 / 疲劳），标签由被试本人自评给出，
   等价于 KSS 嗜睡量表的简化。不做四级标注，因为主观自评无法可靠区分轻度与中度。

---

## 许可

MIT。MediaPipe 相关资源遵循其原始许可（Apache 2.0）。
