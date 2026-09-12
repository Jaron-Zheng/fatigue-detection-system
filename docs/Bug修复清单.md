# Bug 修复清单

分两部分：**一**为本轮审计中发现并修复的问题；
**二**为基线版本之前已修复、在代码注释中有完整实测记录的缺陷（列出以供追溯，非本轮工作）。

## 一、本轮审计修复

### B-01 非法端口参数被静默吞掉

- **现象**：`node server/server.js --port abc` 不报错，直接使用默认 5180。
- **复现**：`node server/server.js --port 99999 --no-open`
- **根因**：`Number(process.env.PORT) || 5180` 只读环境变量，
  且 NaN 被 `||` 静默回退，`--port` 参数完全未接入。
- **修复**：新增 `resolvePort()`，支持 `--port` 参数与 PORT 环境变量，
  非 1~65535 整数时输出中文报错并以退出码 1 终止。
- **测试**：实测 `--port abc` 与 `--port 99999`，均输出
  「服务器启动失败：端口必须是 1 到 65535 的整数」并退出码 1。

### B-02 本地配置可注入 NaN / 原型污染

- **现象**：手工把 localStorage `fatigue.config.v1` 改为
  `{"window":{"perclosSec":"abc"},"__proto__":{"polluted":true}}`，
  旧代码会把字符串写入数字参数，后续窗口计算产生 NaN。
- **复现**：回归测试 `[1.1]` 用 mock storage 重放该输入。
- **根因**：`deepMerge` 只判断 `k in target`，无类型校验、无危险键过滤。
- **修复**：类型校验（数字字段必须为有限数）、忽略
  `__proto__`/`constructor`/`prototype`、仅覆盖已存在字段、
  patch 非纯对象时整体放弃。
- **测试**：`[1.1]` 4 条断言全部通过。

### B-03 目录穿越校验不完整

- **现象**：`resolveSafe()` 只拒绝空字节与越界解析结果，
  未拒绝不以 `/` 开头或含反斜杠的解码路径。
- **复现**：集成测试 `[3]` 用原始 HTTP 请求发送
  `/../package.json`、`/%2e%2e/package.json`、`/..%2fserver%2fserver.js`。
- **根因**：Windows 下 `path.resolve` 对反斜杠路径的行为与 POSIX 不同，
  仅靠「解析后仍在 ROOT 内」一道防线不够稳。
- **修复**：入口处直接拒绝 `!startsWith('/')` 与含 `\` 的路径。
- **测试**：集成测试 `[3]` 10 条断言全部通过（含空字节注入、
  POST 405、404 不泄露磁盘路径）。

### B-04 视频评测文件无校验 + video 元素残留

- **现象**：任意大小、任意类型的文件都会直接进入 blob URL 解码流程；
  释放时只 revoke URL，video 元素仍挂着已失效的 src。
- **根因**：`load()` 无前置校验；`release()` 未清理 media 元素。
- **修复**：空文件/超 1GB/非 video MIME 拒绝并给出中文提示；
  release() 增加 pause + removeAttribute('src') + load()。
- **测试**：静态检查与语法检查通过；真实超大文件浏览器端表现需人工复核。

### B-05 CSV / JSON 导入无大小限制

- **现象**：离线复现 CSV 与标注 JSON 一次性 `file.text()` 读入，
  无大小与格式前置校验。
- **修复**：CSV 限 32MB、标注 JSON 限 2MB，均校验空文件与格式。
- **测试**：静态检查与语法检查通过；浏览器端拦截行为需人工复核。

### B-06 两处 innerHTML 注入面

- **现象**：`web/js/util/dom.js` 的 `el()` 保留 `html:` 属性直通 innerHTML；
  `web/js/ui/report.js` 摘要 pill 用模板字符串拼 innerHTML。
- **根因**：早期快速实现遗留。当前数据来源可信，属纵深防御修复。
- **修复**：`html:` 改走 textContent；pill 改为 DOM API 构建。
- **测试**：project-check 安全基线扫描 + 报告页截图渲染正常。

### B-07 设置抽屉焦点逃逸

- **现象**：抽屉打开时按 Tab，焦点可移出抽屉到达被遮罩的页面元素。
- **修复**：keydown 监听中对 Tab 做焦点陷阱，在抽屉可见可聚焦元素间循环。
- **测试**：代码审查 + 语法检查通过；键盘/读屏实测需人工复核。

### B-08 图表刻度字体未生效（第二轮审计发现）

- **现象**：趋势图 / 波形图的坐标轴刻度文字用的是浏览器默认 sans-serif，
  与全站 SF Pro 字族不一致；深色主题下观感尤其突兀。
- **根因**：`web/js/ui/chart.js` 把 `ctx.font` 写成
  `'10px var(--font-sans, -apple-system), sans-serif'`。Canvas 2D 的
  font 属性是一个独立的 CSS 解析器，**不支持 `var()`**，整个值被判为
  非法而静默忽略，字体停留在默认值。这类错误不会抛异常、不进控制台，
  因此静态检查与之前的截图取证都未能暴露。
- **修复**：改为具体字族栈常量 `CHART_FONT`（与 tokens.css 的
  `--font-sans` 保持一致）。
- **测试**：project-check 语法/安全基线通过；回归测试全量复跑 0 失败；
  字体渲染的最终视觉效果需人工开页确认。

## 二、基线中已含的历史修复（代码注释可追溯，非本轮工作）

| 缺陷 | 根因与修复（详见对应文件注释） |
|---|---|
| 仰头时闭眼状态机出不来 | 几何通道饱和导致退出条件数学不可达；增加语义否决单向提前结束（indicators.js） |
| 0.7/0.3 融合式姿态假阳性 | 实测点头 85s 误报 6 次；改为 0.6geo+0.4sem 并将闭眼触发线移到语义空档中点（indicators.js） |
| 微睡眠重复计入眨眼窗口 | 长闭眼污染平均眨眼时长并掩盖频率下降；微睡眠单独归类（indicators.js） |
| 端口重试重复打印横幅 | listening 监听器未移除；改为成对注册/移除（server/server.js） |
| 人脸丢失被算作闭眼 | 丢失时冻结眼睛状态机 + 中断 PERCLOS 时间累积（indicators.js） |
| 空椅子报告「状态良好」 | unreliable 期间停止等级/均值/峰值累计，报告披露未测时长（fusion.js） |
| PERCLOS 开局虚警 | 就绪门控：观测时长与样本数达标前贡献置 0（fusion.js/indicators.js） |
| CSV 公式注入 | csvCell 对 `=` `+` `-` `@` 开头加单引号（csv-schema.js，回归测试 [1]） |
