# CHANGELOG

本文件逐项记录「系统优化提示词」任务的真实修改内容。
每一项均可在 `system-delivery/comparison/文件变更清单.md` 中找到对应文件，
在 `docs/代码审计报告.md` 中找到问题编号。

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
