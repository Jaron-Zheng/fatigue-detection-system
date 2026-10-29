# CHANGELOG

本文件逐项记录多轮优化的真实修改内容，对应问题编号见 `docs/代码审计报告.md`。

## [3.10.4] — r4 桌面/移动端适配优化（最终项）

审查方式：768/320 断点三视图截图 + 逐视图溢出检查（scrollWidth 对比
innerWidth，home/work/report × 768/320 全部无溢出）+ 390 触屏模拟实测。
桌面端 1920/1440/1366 已有 `--content-max: 1440px` 上限与既有一/二/三列
断点（1200/600），布局健康不动。

### 移动端/触屏四项

- **工具条组内横滚**（≤640px）：`.controls-group` 由组内换行改为
  nowrap + overflow-x auto（隐藏滚动条，手指横滑）——390px 下 8 个按钮
  从折行 5 行收敛为 3 行（行数=组数），控制条高度近乎减半。
- **触屏目标提升**：≤640px 全部小号按钮 min-height 32→40px；
  平板（>641px 且 pointer:coarse）的 .btn-sm/.pill-sm/.pill 同样抬到
  40px，达到触达标准（Apple HIG 44 的紧凑折中）。
- **历史会话表小屏 4 列**（≤600px）：时间列 26%→38%（原 390px 下日期
  折三行）、收紧单元格内边距、隐藏信息价值最低的"峰值分"列——实测
  390px 下"有效覆盖"表头完整显示（原被截断为"有效覆"）。
- **页边距收紧**（≤640px）：`.page` 左右 24px→16px，移动端内容宽度 +16px。

- 验证：verify:full 全绿 + 390 触屏模拟实测（工具条行高 42×3、溢出
  false、表头列宽逐项量取）+ 768/320 溢出全检查。

## [3.10.3] — r4 报告页按钮全量统一为"再次检测"格式（用户要求）

检测报告视图内全部 25 个按钮统一为 btn-secondary（白底 + 蓝框 + 蓝字），
悬停 accent-soft 底、悬停上浮/按压缩放动态全部来自 .btn 基类——与
"再次检测"完全同源：

- 头部四键：下载报告（原实心蓝）、完整数据 JSON / 指标表格 CSV（原实心蓝）、
  再次检测（本就是基准样式）；
- 锚点导航四链接（上一轮的实心蓝按用户要求回退为次级）；
- 空态引导卡：开始一次检测（原实心蓝大按钮）；看演示模式（原已次级）；
- 历史卡清空历史（原 outline 灰描边 → 蓝框）；
- 敏感性卡运行敏感性分析/导出 CSV（运行消融本就次级）；
- 视频评测卡全部按键（pill 家族结构转换：选择视频/设为起点/设为终点/
  标为正常/标为疲劳/标为忽略/清空标注/开始离线评测/取消评测/导出标注/
  导入标注）——"标为正常/标为疲劳"原有的语义色软底内联样式一并移除以
  达成统一；评测结果区三个动态导出键与标注表"删除"行按钮（evaluation-ui）
  同步转换。

语义色仍保留在非按钮处（等级徽章、占比条形图、报警通道），单强调色规则
不受影响。报告页之外（工作台/设置/首页）不在本次范围。

- 验证：verify:full 全绿 + 1920 截图（头部四键/锚点/评测卡选择视频与
  选择 CSV 均白底蓝框）。

## [3.10.2] — r4 走查二次/三次修正（补录两轮：be812f1 / b985d24）

- 三卡等高回退（用户反馈"越改越回去"）：`.report-grid` 恢复
  `align-items: stretch`，占比卡空白感改由新增 `.dist-body` 包裹
  条形图+图例并垂直居中解决（标题置顶）。
- 锚点导航两连改：先按"与 meta pills 无法区分"反馈改胶囊描边按钮；
  再按用户要求与导出键一起改实心蓝（btn-primary btn-sm），最终在本轮
  [3.10.3] 统一回次级。
- 空态两卡圆角重合修复 + 移动端头部按钮组右对齐死代码修复（caec1ce）。
- eslint ignores 补 `_gh-pages-deploy/**`（Pages 部署残留副本树会污染 lint）。

## [3.10.1] — r4 全量功能截图走查（用户反馈空态两卡圆角重合）

走查方式：不做代码推断，直接对全部功能状态截图逐张审看——空态/数据报告、
演示运行中、暂停态、错误舞台、toastConfirm 弹窗、深色数据报告、移动端
工作台与报告（390px），顺带覆盖"错误舞台→改用演示模式"恢复路径与
"无会话点结束"守卫 toast。

### 修复

- **空态两卡融合**（用户反馈）：`.report-grid` 无 margin-top，空态下
  "还没有检测记录"引导卡与"历史会话"卡间距仅 ~6px，两张白卡在浅灰底上
  视觉融成一张（圆角接缝重合）。补 `margin-top: var(--sp-5)`（与栅格内部
  gap 同值），数据态锚点导航与卡片行的紧贴同步解决。
- **移动端头部按钮组右对齐（死代码暴露）**：`.report-head-actions` 的
  窄屏 `justify-content: flex-start` 写在基础规则（flex-end）**之前**，
  同特异性下源码顺序后者胜——该断点规则自引入起从未生效。把媒体查询
  移到基础规则之后（附注释说明源码顺序陷阱），移动端按钮组与标题同侧
  左对齐。

### 走查结论（无其他问题）

演示运行态（合成脸/HUD/检测记录）、暂停遮罩、错误舞台按钮、确认弹窗
（danger 样式）、深色数据报告（图表重绘）、移动端工作台 pill 换行——均正常。

- 验证：verify:full 全绿 + 修复前后截图对照（空态 1920/390、数据态 1920）。

## [3.10.0] — r4 布局重排（全站卡片/布局/按钮评审后用户确认全项执行）

评审方式：11 张截图取证（有数据报告页 5 滚动位 / pro 与基础工作台 / 移动端
390 / 窄桌面 1024 / 设置抽屉 / 深浅主题）+ 栅格 CSS 逐条核对。评审结论与
重排方案经用户逐项确认后实施。

### P1 结构性失衡（4 项）

- 报告页首行三卡高度失衡：`.report-grid` `align-items: stretch` 把内容最矮的
  "各状态时长占比"卡拉出 ~200px 空白 → 改 `start`，各卡贴合内容高度。
- 三列断点 960→1200px：实测 1024 宽下三等分列仅 ~300px，行为表名称列折行、
  行高参差；1200 以下降两列 + 行为卡独占整行。
- 报告头部堆叠断点 900→1200px，与栅格对齐：修复 1024 下按钮组挤压
  meta pills 的 3+1 参差折行。
- 历史会话表 `table-layout: fixed` + 明确列宽（时间 26% / 时长 13% /
  结论自适应 / 峰值 15% / 覆盖 14%）：修复 auto 布局下"结论→峰值分"
  之间的整段空白。

### P2 观感改进（6 项）

- 检测参数与环境表限宽 880px：键值表不再拉满 1920（每行右半全空），
  长值行（融合权重/事件阈值）限宽内自然折行。
- 敏感性分析卡文案归位：静态说明与选中参数的动态描述（sensDesc）连成
  一段，之后才是按钮行与结果区——原按钮行把说明劈成上下两截。
- 设置抽屉分组层级：组间 hairline 分隔线 + 组标题 tertiary→secondary，
  分组节奏与扫描性修复。
- 设置抽屉"更快的进入方式"纵向化（is-stacked）：无控件条目不再横挤在
  field-row 里，与其他条目"标题上/描述下"方向一致。
- 视频评测卡删除孤立"视频"文字标签（组内仅一个自明按钮）。
- 图表 X 轴刻度改"等距整秒"：从候选步长 [1,2,5,10,15,30,60,120,300,600]s
  选最接近 span/4 的整步长，标签不再出现 -15/-11/-8/-4 的参差数字
  （网格线仍严格等距）。

### 不动项（评审结论记录）

首页 hero、工作台双列（视频+指标 / 图表区左右列）、深色主题、移动端单列、
"分析与建议"条块——评审通过，未改动。

- 验证：verify:full 全绿 + 重排前后截图对照（1920/1024/390 + 设置抽屉）
  逐项确认 + 零控制台错误。

## [3.9.0] — r4 图标风格统一 + 空态守卫加固（用户走查反馈两轮）

### 按钮图标全面统一（44 控件逐个审计）

- **规范落地 DESIGN.md 硬规则 9**：图标语言 24 viewBox / stroke 2px / 圆端点
  （Lucide 系，符号库本已统一）；尺寸家族化——`.btn` 16px、`.btn-lg` 18px、
  `.pill` 15px、`.gn-icon`/`.btn-icon` 18px，语义家族配对（导出 i-download /
  导入 i-upload / 运行 i-play / 取消 i-close / 清空 i-trash / 重置
  i-rotate-ccw / 保存 i-check）。
- **根因修复（用户实测"图标尺寸过大撑爆布局"）**：HTML 内联 svg 无
  width/height 时默认按 300×150 渲染——首版锚点导航四链接因此崩坏。
  新增 `.btn svg` / `.btn-lg svg` / `.report-anchors a svg` CSS 统一兜底
  （显式属性降级为同值冗余），动态创建的按钮（stage 遮罩、评测结果区）
  同步受约束。DOM 实测全部落位 15/16/18px。
- **补齐 20 处图标缺失**：报告页锚点四链接（图标与目标卡标题一一对应）、
  导出家族（btnExportJson/Csv/Analysis/Annot + 评测结果三导出）、
  导入家族（btnImportAnnot/btnPickReplay 用新符号 i-upload）、
  标注工具条（起点 i-target / 终点 i-stop / 正常 i-check / 疲劳 i-warn /
  忽略 i-close / 清空 i-trash）、评测运行 i-play / 取消 i-close、
  设置抽屉（试听 i-sound / 恢复默认 i-rotate-ccw / 保存 i-check）、
  再次检测 i-play、仅看异常 i-filter（新符号）、看演示模式 i-eye、
  清空历史 i-trash、stage 遮罩（开始检测 i-play / 重试 i-rotate-ccw /
  改用演示 i-eye / 跳过直接开始 i-play，经 `util/dom.js` 新增的
  `svgIcon()` createElementNS 助手构建）。
- **语义错配修正**：btnPickVideo（选择视频文件）原误用 i-download → i-video。
- 新符号 3 个：i-history（历史会话）、i-filter（筛选）、i-upload（导入，
  i-download 的镜像配对）。
- 豁免口径（写入规范）：纯图标钮、GN 分段芯片（GPU/CPU）、gn-toggle、
  link-btn、toastConfirm 继续/取消、表格行内"删除"微动作。

### 空态守卫（用户反馈"按钮不要写死"，同类问题全面审查）

- 历史会话卡改两态切换而非整体显隐：无历史时卡片保留、显示
  "暂无历史会话记录"提示、清空按钮禁用——锚点跳转永不落空，按钮不再
  写死可点；清空处理器另加空态守卫（竞态下 toast "暂无历史会话"）。
- 同类排查：导出三键空态禁用（已有）、标注导出/敏感性分析/消融/添加区间
  均有 toastWarn 守卫（已有）；补齐唯一缺口——清空标注在零标注时如实
  提示"暂无标注可清空"（原误导性输出"已清空标注"）。
- 验证：verify:full 全绿 + 截图 13 张零控制台错误 + DOM 计算样式逐项
  实测（锚点 15×15、卡标题/按钮 16×16、空态大按钮 18×18、空态提示
  可见、清空按钮 disabled）。

## [3.8.0] — r4 批次二/三（产品小项：防误关 + PWA 图标 + 历史会话 + 报告页锚点）

### P1 检测中防误关

- app.js：会话进行中（RUNNING/CALIBRATING/PAUSED）注册 `beforeunload`
  关闭/刷新确认——会话数据只在内存，此前误触关闭整场数据无提示即丢。
  BOOTING（瞬态）与报告态（会话已结束）不拦，导出不受影响。
  此处必须用浏览器原生对话框：页面即将卸载时 toast/DOM 来不及呈现。

### E1 PWA 图标补 PNG

- 旧 manifest 只有 SVG 图标，部分浏览器的安装入口/桌面快捷方式图标退化。
  新工具 `tools/gen-icons.mjs` 用 cdp-util 无头浏览器把矢量母版
  brand/app-icon.svg 栅格化到 canvas，全自动产出 web/icons/icon-192.png /
  icon-512.png（校验 IHDR 尺寸，替代 build-icons.cjs 的人工 dataURL 流程）；
  manifest icons 补两条 PNG；SW 预缓存随之 54→57 项（含后续源码变更）。

### E2 内存复测（回归性质）

- `perf-profile --mode memory --minutes 3 --keep-visible`：全程 running、
  152 采样，堆 2.11→2.85MB（峰值 3.63MB）、长任务 0、剧本轻→中→重度
  正常走完——无泄漏无回归。数据入 docs-evidence/perf-memory-*.json。

### P2 历史会话列表（第四轮产品遗留项 #11）

- 新模块 `web/js/core/history.js`：localStorage `fatigue.history.v1` 保存
  最近 10 次会话的文字摘要（结束时间/时长/最高等级/峰值均分/有效覆盖率/
  等级构成/事件计数/演示标记），**不含影像与逐帧数据**；上限截断、
  损坏内容清空重建、形状非法条目过滤、存储不可用静默降级（与
  config.loadUserConfig 同一防御思路）。
- `summaryToEntry` 显式挑字段（分数按展示精度舍入），session-actions 的
  stopSession 在 report.render 前入库，刚结束的一场立即出现在列表中。
- 报告页新增「历史会话」卡（非 .rp-data：空态下同样可回看），
  清空走 toastConfirm（danger 样式）；隐私口径在 README 与卡片说明中
  明示"文字摘要、不含影像，可一键清空"。

### P3 报告页锚点导航（第四轮产品遗留项 #12）

- 专业模式下报告页很长（三张实验工具卡 + 历史会话），页头新增 pill 家族
  视觉的锚点导航条（pro-only、no-print），拦截为 scrollIntoView 平滑滚动、
  不写 location.hash（本应用深链全靠 query 参数，hash 留在 URL 里是噪声）。

### D1 文档与测试

- UI设计说明.md：报告页结构补历史会话卡与锚点导航；主题三态与
  toastConfirm/beforeunload 的反馈交互口径补充成节。
- regression-test.mjs 新增 [20] 会话历史存储（截断/排序/精度/演示标记/
  损坏重建/非法过滤/清空，8 条断言，187→195）。
- 验证：verify:full 全绿（静态含 SW 指纹门禁 + 回归 195/195 + 集成 41/41
  + typecheck + lint 0 error）。

### 线上验证（gh-pages 628de58 部署后实测）

- curl 确认：index.html 含 cardHistory/rpAnchors、sw.js 指纹
  e12a76212155 与本地一致、icons/icon-192.png 与 js/core/history.js 均 200。
- demo-url-test 26 探针跑线上两轮各 24/26：全部探针**控制台零错误**；
  2 个失败均为固定秒数等数据的时序断言，且失败点随缓存预热从
  "等待检测数据…"推进到"闭眼占比预热中（1/5 秒）"——引擎真实启动并推理，
  判定为线上冷启动（11MB WASM + 模型首次下载）超探针窗口的环境性差异，
  非回归（本地同套件 26/26）。

## [3.7.0] — r4 批次一（正确性：时间账目口径统一 + 双真相源根治）

全量代码审查（算法层 22 文件 ~6500 行逐文件通读）产出的正确性修复批次。
影响论文实验数据可信度的两项 P1 优先。

### A1（P1）人脸丢失时段被记为"清醒/有效测量"

- 旧实现：不可靠门控只看全会话累计丢失比（`faceLostAccumMs/observed > 0.5`）。
  "先正常追踪数分钟、中途离座/遮挡几十秒"的常见模式下，分母里堆着此前的
  有效观测，数学上长期达不到 0.5——丢失期间指标衰减后分数 ≈8，该时段全部
  计入 `awake` 等级与 coverage，甚至把丢脸前的疲劳等级记在离座时段上
  （注释声称防住的"空椅子 90 秒"场景实际防不住）。
- 修复（fusion.js + indicators.js）：判定抽为共享函数 `assessUnreliable`，
  双臂——①连续丢失超过 `CONFIG.fusion.faceLostGateMs`（新增，默认 3000ms，
  与事件层丢脸上报去抖同量级，转头抖动实测 100ms 量级远达不到）；
  ②累计丢失比 > 0.5 兜碎片化丢失。快照新增 `faceLostMs`（连续丢失时长）。
- 丢失占比分母显式改为 `faceLostAccumMs + observed`（旧分母在丢失期间
  被稀释，见 A3）。

### A2（P1）离线重算与在线融合失同步（双真相源根治）

- 旧实现：analysis.js 的 replaySession 手抄融合层打分循环，趋势加速器
  参数硬编码改动前的旧值（乘数 1.5/上限 -2~5，在线已从 CONFIG 读
  trendMaxBoost=8），且不剔除无效样本——敏感性分析/消融实验/CSV 跨会话
  复现的结论与实时报告口径不一致，此项无上界。
- 修复（fusion.js + analysis.js）：趋势推进抽为共享纯函数 `advanceTrend`
  （参数一律读 CONFIG），replay 改为调用；可靠性判定复用 `assessUnreliable`
  ——连续丢失/不合格时长从相邻 CSV 行时间戳重建（采样 500ms，误差不放大），
  不可靠时段计入新增返回字段 `unreliableMs`，从等级时长/均值/峰值/报警
  统计中剔除（与在线层同口径）；曲线保留全部采样点维持图表连续性。
- 回归锚定：新增"同一指标序列在线/离线逐点一致"断言（构造 perclos
  0→0.9→0.2 剧烈跳变放大趋势项差异），修复前该断言 maxDiff>3 分必失败。

### A3（P2）有效观测时钟

- observeAccumMs（频率类指标与偏离占比的分母、rateReady 就绪门控的基准）
  从"无条件累计"改为"人脸在场且质量合格才累计"——丢失/质量差期间分子
  冻结而分母增长的稀释效应消除，EventWindow「按实际观测时长归一」的
  注释语义与实现一致。

### A4–A7（P2 小项）

- alarm.js：`beep(gain≤0)` 直接短路不创建音频节点。gain=0 是钳制表放行的
  合法配置意图（该等级静音），但 `exponentialRampToValueAtTime(0)` 会抛
  RangeError 并沿 `alarm.update → _frame` 炸掉整帧处理链。
- features.js：人脸丢失分支对 6 个中值滤波器一并复位（原只复位 prevPitch/
  prevTs），重捕获后前几帧 EAR/角度不再被丢失前的陈旧缓冲跨间断平滑污染。
- evaluation.js：ROC/PR 阈值点列显式补 0 端点（步长不整除 100 时旧循环
  到不了"全判正"端点，AUC/AP 偏小）；`computeBaseline` 的 perclosReady
  判定改 `Number(...)===0` 统一布尔/0-1 两种来源（字段缺失仍视为已就绪，
  保持旧行为）。
- sim-driver.js：`START_OFFSETS` 补 `severe: 102000`（此前 `setStartStage('severe')`
  静默落 awake）；recorder.js 删除 `calib.state === 'failed'` 死条件
  （CalibrationResult 无 state 字段）；calibration.js 的 `MIN_EAR_BASELINE`
  迁入 `CONFIG.calibration.minEarBaseline`（全项目唯一 TODO 清零），
  NUMERIC_LIMITS 同步新增 `fusion.faceLostGateMs` 与 `calibration.minEarBaseline`。

### 测试与文档

- regression-test.mjs 新增 [17] 可靠性门控双臂判定、[18] 趋势共享实现与
  在线/离线一致性、[19] ROC 端点/观测时钟/蜂鸣防护/滤波器复位/演示档位，
  共 22 条断言（165→187）。
- eslint.config.mjs ignores 补 `_scratch/_论文工作区/_eval-cache/_dataset/`
  （3a28785 工作区整理后归档目录被 lint 扫到，9 个 error 均非运行代码）。
- README/系统测试报告 测试数对齐实际（175→187、138→187）。
- sw.js 预缓存指纹重刷（源码变更触发，gen-sw-precache 自动）。
- 验证：verify:full 全绿（静态 6 项含 SW 指纹门禁 + 回归 187/187 + 集成
  41/41 + typecheck + lint 0 error）。

## [3.6.0] — 质量加固 r3 合入（外部优化包，SW 预缓存重设计 + 体验修复九项）

来源：外部模型（Claudefable5.1）基于 3.5.0（7eb662d）产出的优化包。因与 L-01
（399ca69，推理运行时全同源 + CSP 收紧）并行改动，合入时以 main 为基逐文件
三方合并：L-01 的同源加载、CSP、SW v5-r2 语义全部保留。合并审查中剔除：
包内模型文件哈希与同源 inventory.json 不符（导出损坏，保留仓库版本，否则引擎
完整性校验必失败）、fixture CSV 仅 BOM/换行伪差异、README/CHANGELOG/
regression-quality-r2 无实质改动。

### SW 离线链路重做（P2/P8，改动最大）

- `sw.js`：install 阶段一次性预缓存首页与全部同源源码（旧方案"运行时自动填充"
  在"开启 ?pwa=1 后立刻断网"场景必 503——首次加载永远发生在 SW 接管前）；
  预缓存带 `cache:'reload'` 绕过 GitHub Pages max-age=600 的旧文件；任一核心
  文件失败即 install 失败（宁可没有 SW 也不要缺文件的半成品缓存）。
- 缓存版本改内容指纹：`CACHE_NAME` 前缀 + 全部预缓存文件 SHA-256 指纹
  （新工具 `tools/gen-sw-precache.mjs` 生成，任何源码改动自动换缓存名）。
- `vendor/inventory.json` 从 cache-first 改 network-first：它是模型哈希清单，
  被 cache-first 锁死时"换模型 → 老清单验新模型 → 误报篡改"且无法自救。
- `app.js`：离线就绪全程用户可见（准备中 → 就绪（N 个文件）/ 失败给出重试指引），
  SW 以 postMessage SW_READY / 响应 GET_STATUS 汇报版本与 vendor 就绪度。
- 门禁与部署：`project-check` 新增静态检查——sw.js 清单/指纹与 web/ 实际文件
  不一致即 fail；两个 deploy 脚本部署前自动重刷清单。

### 体验修复（P1/P5/P6/P7）

- 报告页空态（P1）：只隐藏依赖会话数据的卡片（`.rp-data`），实验工具卡
  （`.rp-lab`：离线复现/视频评测/敏感性）空态保持可达——"无摄像头演示完整
  判定链路"的产品承诺重新成立；空态新增专业模式引导入口。
- 主题三态（P6）：跟随系统 → 深色 → 浅色循环（旧实现点过一次后永远回不到
  跟随系统）；监听系统深浅色变化同步图标；修复 storage 事件跨窗口回写环；
  图标语义显示当前态，title/aria-label 同步。
- `toastConfirm`（P7）：应用内行内二次确认替代原生 confirm（主题一致、可自动
  化、不阻塞），alertdialog 语义 + Esc 取消 + 确认键聚焦 + 单实例互斥；
  视频评测"未标注区间仍继续"确认已迁移。
- 视频评测两阶段进度（P5）：标定段此前不回报进度，长视频下状态文字停留
  "正在初始化推理引擎"实测 54 秒（假死感）；现在标定/评测两阶段各自 0→100%
  并明确"阶段 1/2"。

### 正确性与工具链

- 摄像头启动竞态补两处防护：等首帧期间被新一轮 start() 接管时，复核代次
  （返回新流尺寸配旧轨道 label 的张冠李戴结果）；catch 中被接管时按
  SUPERSEDED 静默出局，不再误杀新流。
- `cdp-util.findBrowser` 跨平台（Linux/macOS/PATH/Playwright 缓存/CHROME_PATH
  环境变量），screenshot.mjs 统一走该实现（P9）。
- 测试适配：pwa-offline 新增"冷开启即断网"回归（预缓存 ≥50 条、激活后不刷新
  直接离线重载）与 inventory 回源断言；cross-browser/toggle-chaos 适配三态主题。
- 工具修复（合并验证时发现）：cdp-util `close()` 在 Windows 上按 proc.pid 杀
  进程树会扑空——Edge"兼容层重启"后真正持有调试端口的浏览器是其子进程且
  启动器已退出，残留进程占住端口导致同端口高频启停的测试工具（demo-url 每
  探针重启浏览器）连锁失败；改为按调试端口找监听进程 `taskkill /T /F` 并等待
  端口真正释放，launchHeadless 端口探测加短重试窗口。修复 zip 包内
  pwa-offline 的 2 处 lint error（evalJs 模板串内正则转义）。
- 验证：verify:full 全绿（静态检查含新预缓存门禁 + 回归 165/165 + 集成 41/41
  + typecheck + lint）+ quality-r2 10/10 + demo-url 26/26 + pwa-offline 16/16。

## [3.5.1] — L-01 决策落地：推理运行时全同源加载 + CSP 收紧（第三方可执行代码面归零）

fable5 审计台账最高优先级遗留项的决策与实施。决策：**可执行代码（vision_bundle.mjs
与 WASM）本地与线上统一从本仓库 vendor 目录同源加载**；模型文件保留 jsdelivr
镜像链加速，但每个候选均经同源 inventory.json 的 SHA-256 校验（安全等价同源）。

依据：实测 GitHub Pages 同源下载 11MB WASM 约 3.6s（≈3MB/s），历史"国内
20KB/s"的顾虑已不成立；SW 缓存后离线免重载（pwa-offline 12/12 实证）。

- `face-engine.js`：删除 npmmirror CDN 分支（CDN_BASE/CDN_BUNDLE/CDN_WASM/
  importWithTimeout），init() 统一 `import(LOCAL_BUNDLE)` +
  `FilesetResolver.forVisionTasks(LOCAL_WASM)`；模型镜像链与哈希校验保持不变。
- `index.html` CSP：script-src/worker-src 移除全部第三方域（仅 'self'
  'wasm-unsafe-eval'）；connect-src 保留 jsdelivr 三域（模型镜像，fetch 不执行）。
- `sw.js`：CACHE_VERSION v5-r1 → v5-r2（线上强制刷新）。
- 回归守护：`regression-quality-r2.mjs` 新增 Q-08 静态断言——运行时代码禁止
  npmmirror import、bundle/wasm 必须同源、CSP script-src 无第三方域、
  jsdelivr 仅存于 connect-src（10/10 通过）。
- README 隐私声明补充资源加载策略。
- 验证：verify:full 全绿 + demo-url 26/26 + pwa-offline 12/12（本地服务器实测）。
- 线上验证（gh-pages 1be06fa 部署后实测）：curl 确认 CSP 已收紧（script-src
  仅 'self' 'wasm-unsafe-eval'，jsdelivr 仅存于 connect-src）、index 无第三方
  script/link 引用、bundle/WASM/模型均 200 且字节级与仓库一致
  （.mjs→text/javascript、.wasm→application/wasm MIME 正确）；无头浏览器走
  真实 UI + 假摄像头实测线上引擎：vision_bundle.mjs 与 WASM 仅同源加载、模型
  走 gcore 镜像并经同源 inventory.json 的 SHA-256 校验通过，GPU 委托
  （WebGL 2.0）真实推理 20 FPS、约 13s 完成启动，控制台除 MediaPipe 原生
  INFO 日志（与 e2e 白名单同款噪声）外零错误；PWA ?pwa=1 线上注册 SW
  （v5-r2）成功，install 不预缓存属设计（运行时缓存按需填充）。

## [3.5.0] — 深度代码质量加固 r2（外部审计补丁合入，8 项修复 + 1 个回归测试文件）

来源：外部模型（fable5）对 main@c0c590e 的深度质量审计交付（纯补丁形态，基线核对一致后按 9 个独立提交合入）。

### Q-01 启动竞态根修：取消后立即重开 → 幽灵流 + 流程串线（高）

- `startAbort` 全局布尔改为「启动代次」：app 层 `_startGen`、CameraSource 层
  `_startSeq`，每个 `await` 之后校验代次，过期流程静默退出并回收本轮流。
- 复现路径：开始 → 授权弹窗期间点结束 → 立即再点开始 → 允许。
  旧现象：会话能跑但摄像头指示灯常亮，部分设备下次启动 `NotReadableError`。
- 旧一轮迟到落定后会替新一轮 `send(BEGIN_CALIBRATION)` / `failStart(FAIL)`
  造成状态串线（新一轮事件反被拒绝静默返回）。

### Q-02 switchCamera 失败死路（中）

- 切换新设备失败原先只 toast，停留在「RUNNING 但 srcObject 为空」：
  `detect()` 恒 null、看门狗两分支都不触发，画面永久空白无出口。
- 现在失败后回滚原设备；仍失败走 `_onTrackLost` 语义（有数据收束成报告，
  无数据进错误舞台）。演示模式空 camera 直接早退（原先 TypeError）。

### Q-03 标定基线下限（中）

- 标定期间闭眼/眯眼时 `earBase≈0.05`，闭眼线派生为 ≈0.036，整场检测不出
  闭眼且标定仍报「成功」。新增 `MIN_EAR_BASELINE = 0.12` 校验（低于最窄
  眼型睁眼 EAR 下界 0.16，不误伤目标人群），失败给通用阈值回退与可操作提示。

### Q-04 Service Worker 缓存加固（高·线上）

- `cache.put` 改 `safePut`（配额不足/隐私模式 reject 不再变 SW 内
  unhandledrejection）+ `event.waitUntil` 延寿。
- 导航离线回退加 `ignoreSearch`（`?pwa=1`/`?demo=1` 入口原先命不中缓存），
  首页回退兼容 `./index.html`。
- `CACHE_VERSION` v4-r1 → v5-r1。

### Q-05 recorder 三处（中）

- `end()` 幂等（轨道丢失自动收束与手动结束并发不再写两条 session_end）；
- `Math.max(...arr)` 改 reduce（maxSamples 调大后不再栈溢出）；
- blob URL 撤销延后 1500ms（Firefox/Safari 大文件导出不再 0 字节）。

### Q-06 HTML 报告导出加固（中）

- 重入锁：双击导出不再让主题翻转时序错乱（深色 canvas 复发的另一条路径）；
- 双 rAF 加 300ms 兜底（后台窗口 rAF 不触发时不再卡在浅色无下载）；
- `<title>` 出口转义（与 csvCell 同属数据出口统一防护）。

### Q-07 状态机监听器隔离（中）

- `send()` 中单个 onChange 钩子抛错不再跳过后续钩子（UI 与状态机脱节
  即用户感知「卡死」）；错误收集后仍重抛第一个（不吞错）。

### Q-08 模型完整性校验失败显式报错（中）

- 同源模型文件哈希不匹配（vendor 损坏/被篡改）原先静默回退未校验加载，
  仅 console warn。现在抛可读错误进错误舞台，提示重新运行 fetch-vendor.js。
  镜像/网络类失败保持原回退行为。

### 新增回归测试 `tools/regression-quality-r2.mjs`

- Q-01~Q-07 的可自动化断言（9 用例：并发启动迟到流回收、end 幂等、
  标定下限三态、钩子隔离、SW 静态守护、大数组 summary），零依赖 Node 18+。

### 验证记录（合入方执行）

- 修前/修后 `npm run verify:full` 均全绿（静态 + 回归 165 + 集成 41 +
  typecheck/lint 0 错误）；`regression-quality-r2.mjs` 9/9；
  `demo-url-test.mjs` 26/26；`pwa-offline-test.mjs` 12/12（对本地服务器实测）。
- 遗留决策项：线上版 vision_bundle/WASM 走 CDN 无完整性校验（L-01，
  属既有设计决策，待作者择一：同源加载 / fetch+integrity / 文档声明局限）。
  → 已决策落地于 [3.5.1]（同源加载方案）。

## [3.4.1] — 安全审计四项修复（CSP meta / 模型哈希校验 / 部署令牌根修 / 测试钩子收口）

### 修复 1：GitHub Pages 线上版补 CSP（web/index.html）

- server.js 的全套安全响应头（CSP/COOP/CORP/COEP 等）只覆盖本地；
  Pages 是纯静态托管不带任何头，线上版此前零 CSP 防护。
- 新增 CSP `<meta>`，规则与本地响应头逐条对齐，另放行线上加载链
  CDN 域（registry.npmmirror.com / gcore+fastly+cdn.jsdelivr.net）。
  两层 CSP 并存取交集（更严者生效）：本地行为不变，线上获得防护。
- 已知边界：frame-ancestors 在 meta 中被规范忽略，防嵌点击劫持
  仍仅由本地响应头承担。

### 修复 2：模型文件 SHA-256 完整性校验（防 CDN 投毒）

- `vendor/inventory.json`：每个文件补 `sha256` 字段（fetch-vendor.js
  生成时写入，随仓库版本化）。
- `face-engine.js fetchModelBuffer`：期望哈希从同源 inventory.json
  读取（攻击者控制镜像也无法让哈希对上），每个下载源完成后校验，
  失败按「源失败」切换下一候选，最终回退同源；非安全上下文
  （局域网 http 无 crypto.subtle）自动跳过校验并告警。
- 已知边界：vision_bundle.mjs 与 wasm 走 MediaPipe 内部加载无法
  拦截校验，防护依赖版本锁定路径 + CSP 域白名单 + 同源兜底。

### 修复 3：deploy-github.cjs 令牌泄漏根修

- 旧版向本仓库 `git remote add deploy <token-url>` 且失败路径直接
  `process.exit(1)` 跳过清理——令牌随 git 输出泄漏进日志（已发生一次）。
- 现令牌只经 push 参数传递、从不写入任何 git config；临时部署目录
  try/finally 无条件清理；所有输出经 `redact()` 脱敏；令牌优先经
  `GH_TOKEN` 环境变量传入（argv 兼容保留）。
- 残余已接受风险：push 参数在进程列表秒级瞬时可见（本机窗口期）。

### 修复 4：测试钩子线上不安装（test-hooks.js）

- `window.__fatigue` 可驱动模拟启停，属测试面而非产品面。现复用
  `face-engine.js isLocalEnv()`（已导出）分流：localhost/局域网安装
  （测试工具链不受影响），GitHub Pages 等线上环境不暴露。

## [3.4.0] — 真实标注数据评测与 R5 参数调优

### 真实数据评测工具链（tools/，新增）

- **realdata-collect.mjs**：无头 Edge 驱动生产同源推理链路
  （FaceEngine → FeatureExtractor），把公开标注数据集（NTHU-DDD /
  UTA-RLDD）逐帧特征缓存为 JSON——推理一次、回放多次。
- **realdata-eval.mjs**：Node 回放完整 Calibrator → IndicatorEngine →
  FusionEngine 管线，输出 clip 级二分类指标（三种判定规则）、场景分解、
  逐被试/逐 clip 明细、UTA 帧级三通道 AUC、单参数扫描。
- **realdata-diagnose.mjs**：单 clip 逐秒隶属度诊断（误差归因工具）。
- **server.js 新增 `--dataset-dir` 开关**（默认关闭）：数据集以同源
  `/dataset/` 路径供页面推理（CSP connect-src 'self' 不放松，扩展名
  白名单 + 路径越界防护）。

### 算法修复（web/js/，两处硬编码魔法数参数化 + 一处门控对称性缺陷）

- **indicators.js**：眼睛状态机闭合度阈值 0.80/0.60 硬编码抽出为
  `CONFIG.event.eyeCloseOn / eyeCloseOff`（补齐 NUMERIC_LIMITS 钳制）。
- **fusion.js**：yawn/nod 频率隶属度补就绪门控（原来只有 blinkRate 有
  15s 门控；实测开局 1 次点头 ÷ 1s 观测 = 60 次/分的荒谬频率），
  统一为 `CONFIG.fusion.rateReadyMs`。

### 默认参数调优（config.js，R5 轮，NTHU-DDD 真实数据驱动）

- `event.eyeCloseOn` 0.80 → **0.75**（真实眨眼峰值闭合度≈0.78，
  0.8 时差 0.02 漏检 → 眨眼率虚低 → 伪"低频嗜睡"信号）
- `calibration.marOpenDelta` 0.35 → **0.25**（低幅压抑型哈欠可注册，
  与说话分布的分离点）
- `fusion.weights`：yawn 0.14→**0.21**、nod 0.10→0.08、
  blinkRate 0.10→0.08、blinkDur 0.05→0.04、headDev 0.04→0.02

### 效果（数字与 tools/ 脚本输出强绑定，复现命令见实验报告 8.5 节）

- 真实数据（NTHU-DDD 48 clips）：灵敏度 81.0%→**85.7%**，
  特异度 92.6% 持平，MCC 0.746→0.788；无眼镜场景灵敏度 100%。
- 模拟数据（10 种子）：灵敏度 86.4%→**92.6%**，特异度 100% 持平，
  平均延迟 15.3s→**8.7s**。
- UTA-RLDD 帧级 AUC：双通道融合 0.7178 > 几何 0.7151 > 语义 0.7030
  （双通道设计价值实证）。
- 全量回归：静态检查 / 138 回归 / 41 集成 / 20 混沌 / typecheck / lint
  全绿；对抗场景 6/6 零误报保持。

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

- 原来的人脸线稿（大圆脸+关键点）整张移除，重做为 Apple HUD 风格的
  「驾驶舱预览」：透视路面 + Action Blue 车道线 + 220° 疲劳仪表弧 +
  状态芯片与微型指标；全部颜色走 `--hero-*` 令牌，浅/深主题自动适配。

### 其他

- **app.js**：启动控制台日志颜色从 Apple 蓝 #0071e3 换为 Electric Blue。
- **tools/design-audit.mjs**：R8 允许 hero 融合态下的白色导航底。
- 图注颜色升到 --hero-muted（白底 5.9:1，修复 axe serious）。
- 全套验证重跑：check / ui-smoke 14 / a11y 14（serious 清零）/
  design-audit 14 / lint / typecheck 全部通过；浏览器 MCP 真实点击
  走通导航、演示检测、报告、设置抽屉、专业模式、主题切换全流程。

## [3.0.0] — UI 全量重构：图标库替换 + 布局骨架重排（设计语言仍为 Apple）

> **2026-09-08 更正**：本条目原记录"Apple→Tesla 全量迁移"，但经代码审计，
> 实际 CSS 代码仍为 Apple 设计语言（强调色 `#0071e3`、六级双光源阴影、
> 负字距、胶囊圆角、弹簧缓动曲线等均保留）。`tokens.css` 头部注释
> 声称的"Tesla 设计语言"与实际取值不符，已更正为"Apple 设计语言"。
> 图标库确实替换为 Lucide，布局骨架重排也确实执行了。
> 详见 `docs/DESIGN.md` 和 `docs/UI设计说明.md`（已以代码为准重写）。

以 `awesome-design-md-main/design-md/` 为参考基准，图标、布局、交互全部重做（非换肤）：
图标库替换为 Lucide、三个视图骨架重排、导航/抽屉/报警/动效全部重写。CSS 变量名、
元素 ID、测试锚点全部保留，检测算法层（web/js/core）零改动。

### 设计令牌与样式（web/css/*，全量重写）

- **tokens.css**：色板保持 Apple 设计语言（Action Blue `#0071e3` 唯一交互色、
  Carbon Dark `#171A20`、四级灰字体系、Light Ash `#f4f4f4`）；
  字阶压缩到 14px 体系、字重只留 400/500、圆角阶梯 4/8/12/18/胶囊、五级双光源阴影（xs~xl）+ 辅助阴影（focus/card/nav）、弹簧缓动曲线。变量名全部不变。
- **base.css / components.css / layout.css / motion.css**：胶囊 CTA 保持 9999px 圆角、
  卡片靠底色差分层与双光源阴影、按压 scale/悬停位移/视差/模糊进场、弹簧缓动曲线、
  进场动效保持淡入+位移组合。

### 图标系统（web/index.html）

- 22 个自绘 SVG 全部替换为 Lucide 官方 path（MIT，24×24/2px 描边），
  新增 8 个布局所需图标；symbol id 沿用旧命名，JS 动态换图零改动。

### 布局骨架重排（web/index.html + layout.css）

- 导航：Apple 双层（44px 黑条 + 52px 毛玻璃）→ 单层 56px；
  首页 hero 上与 Carbon Dark 画幅融合，滚动后切实底（motion.js 同步适配）。
- 首页：磁贴交替结构 → 全幅段落（Carbon Dark hero + 白底能力段 +
  大数字段 + Light Ash 收尾 CTA），hero 内容居中、CTA 双按钮定宽。
- 工作台：新增横贯全宽的「仪表条」（等级/原因 + 128px 细环大数字 +
  时长峰值均值）；右侧指标改为单块白面板内 2 列发丝线分行。
- 报告：头部改 Tesla 订单页模式（左标题摘要/右 CTA 组），概要数字放大。
- 报警横幅：Carbon Dark 底 + 左侧等级色条 + 4px 圆角。

### 工具与文档

- **tools/design-audit.mjs**：审计规则重写为 Apple 设计十条
  （单一强调色/双光源阴影/14px 正文/无 600-700 字重/胶囊圆角/圆角阶梯/
  零装饰渐变/导航底色/行高/无大写），实测 14/14 通过。
- **docs/DESIGN.md**：重写为 Apple 设计规范映射与项目裁定（含硬规则清单）。
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
