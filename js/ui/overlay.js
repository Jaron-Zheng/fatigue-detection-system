/**
 * overlay.js — 关键点可视化叠加层（v4：单色纪律）
 *
 * 设计原则（Apple 式的克制，三条硬规则）：
 *   1. 颜色即语义——常态只有白系线稿（安静的 Face ID 质感）；
 *      红色只属于闭眼，黄色只属于张嘴。颜色出现的那一刻，
 *      就是注意力该去的地方。
 *   2. 线宽有体系——三档：1.25（次体：眉/虹膜）/ 1.5（主体：
 *      脸廓/唇/常态眼线）/ 2.5（事件强调）。
 *   3. 点云退成薄霜——478 点地标是论文证据，但证据不需要喊叫：
 *      156 个 0.9px 圆点、16% 透明度，铺在皮肤上像一层薄霜，
 *      证明模型在工作，而不抢主体的戏。
 *
 * 在视频上方用 Canvas 绘制：
 *   · 稀疏面部点云（薄霜质感，证明模型逐帧在工作）
 *   · 脸廓 / 眉 / 唇 / 眼轮廓（单色线稿）
 *   · 事件语义色：闭眼变红、张嘴变黄（含收敛的柔光）
 *   · 头部姿态三轴（精修的 gizmo 风格，非调试工具风）
 *
 * 渲染性能：每帧只画约 250 个点 + 若干路径，
 * 在 1080p 下开销约 1~2ms，不会拖慢推理主循环。
 */

import { CONFIG } from '../config.js';
import { fitCanvas, cssVar } from '../util/dom.js';
import {
  MESH_SPARSE,
  CONTOUR_LEFT_EYE,
  CONTOUR_RIGHT_EYE,
  CONTOUR_LIPS_INNER,
  CONTOUR_LIPS_OUTER,
  CONTOUR_FACE_OVAL,
  CONTOUR_LEFT_BROW,
  CONTOUR_RIGHT_BROW,
  IRIS_LEFT,
  IRIS_RIGHT,
  IRIS_LEFT_CENTER,
  IRIS_RIGHT_CENTER,
  NOSE_TIP,
} from '../core/landmarks.js';
import { DEG2RAD, clamp } from '../util/math.js';

/** #rrggbb + alpha → rgba() 字符串（示意脸的状态色需要不同透明度分层） */
function hexA(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return `rgba(255,255,255,${a})`;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export class Overlay {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.colors = this._readColors();
    this.w = 0;
    this.h = 0;
    /* 稀疏网格边表（Face ID 式线框）：首次绘制时从 MediaPipe 官方
     * 拓扑表 FACE_LANDMARKS_TESSELATION（2556 条边）中筛出两端点
     * 都落在稀疏采样集里的 256 条边，缓存后逐帧复用。
     * 拓扑静态不变，只需加载一次；加载失败则降级回点云。 */
    this.meshEdges = null;
    this._meshEdgesFailed = false;
  }

  /**
   * 加载稀疏网格边表（异步，一次性）。
   * 只读取 FaceLandmarker 的静态常量，不会触发 wasm/模型下载；
   * 失败（如 vendor 路径异常）时静默降级为点云，不阻塞渲染。
   */
  async _loadMeshEdges() {
    try {
      const base = new URL('../../vendor', import.meta.url).href;
      const mod = await import(`${base}/tasks-vision/vision_bundle.mjs`);
      const tess = mod.FaceLandmarker.FACE_LANDMARKS_TESSELATION;
      if (!Array.isArray(tess) || !tess.length) throw new Error('empty tessellation');
      const sparse = new Set(MESH_SPARSE);
      const edges = [];
      for (const c of tess) {
        if (sparse.has(c.start) && sparse.has(c.end)) edges.push([c.start, c.end]);
      }
      this.meshEdges = edges;
    } catch {
      this._meshEdgesFailed = true; // 永久降级点云，不再重试
    }
  }

  _readColors() {
    return {
      mesh: cssVar('--mesh', 'rgba(255,255,255,0.25)'),
      meshLine: cssVar('--mesh-line', 'rgba(255,255,255,0.14)'),
      eye: cssVar('--mesh-eye', 'rgba(255,255,255,0.92)'),
      eyeClosed: cssVar('--mesh-eye-closed', '#ff453a'),
      mouth: cssVar('--mesh-mouth', '#ffd60a'),
      oval: cssVar('--mesh-oval', 'rgba(255,255,255,0.62)'),
      iris: cssVar('--mesh-iris', 'rgba(255,255,255,0.5)'),
    };
  }

  refreshTheme() {
    this.colors = this._readColors();
  }

  resize() {
    const r = fitCanvas(this.canvas);
    this.w = r.w;
    this.h = r.h;
    this.ctx = r.ctx;
  }

  clear() {
    if (!this.w) this.resize();
    this.ctx.clearRect(0, 0, this.w, this.h);
  }

  /**
   * 绘制一帧。
   * @param {object} feat FeatureExtractor 结果
   * @param {object} state { closed:boolean, mouthOpen:boolean, level:string }
   * @param {object} videoSize { vw, vh } 视频原始尺寸，用于 object-fit:cover 的坐标映射
   */
  draw(feat, state, videoSize) {
    if (!this.w) this.resize();
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.w, this.h);
    if (!feat || !feat.ok || !feat.landmarks) return;

    const lm = feat.landmarks;
    const map = this._makeMapper(videoSize);
    const c = this.colors;
    const r = CONFIG.render;

    // ---- 稀疏网格：Face ID 式淡线框 ----
    if (r.showMesh) {
      if (this.meshEdges) {
        /* 256 条稀疏边（拓扑来自 MediaPipe 官方 FACE_LANDMARKS_TESSELATION）
         * 收进单个 Path2D 一次 stroke——Apple Face ID 扫描网格的密度观感，
         * 证明模型逐帧在工作，而安静得像背景。
         * 裁剪到脸廓内：网格是"脸上的证据"，不允许溢出到发际之外。 */
        ctx.save();
        this._path(ctx, lm, CONTOUR_FACE_OVAL, map, true);
        ctx.clip();
        ctx.strokeStyle = c.meshLine;
        ctx.lineWidth = 1;
        const net = new Path2D();
        for (const [a, b] of this.meshEdges) {
          const pa = map(lm[a]);
          const pb = map(lm[b]);
          net.moveTo(pa.x, pa.y);
          net.lineTo(pb.x, pb.y);
        }
        ctx.stroke(net);
        ctx.restore();
      } else {
        /* 降级/待加载：薄霜点云（E4 批量绘制——单个 Path2D 收拢全部
         * 圆弧后一次 fill，每段弧前 moveTo 到圆心右侧避免补出连线）。 */
        ctx.fillStyle = c.mesh;
        const dots = new Path2D();
        for (const i of MESH_SPARSE) {
          const p = map(lm[i]);
          dots.moveTo(p.x + 0.9, p.y);
          dots.arc(p.x, p.y, 0.9, 0, Math.PI * 2);
        }
        ctx.fill(dots);
        if (!this._meshEdgesFailed) this._loadMeshEdges();
      }
    }

    // ---- 轮廓：单色线稿 ----
    if (r.showContours) {
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      // 脸廓（主体）
      ctx.lineWidth = 1.5;
      this._path(ctx, lm, CONTOUR_FACE_OVAL, map, true);
      ctx.strokeStyle = c.oval;
      ctx.stroke();

      // 眉毛（次体）
      ctx.strokeStyle = 'rgba(255,255,255,0.4)';
      ctx.lineWidth = 1.25;
      this._path(ctx, lm, CONTOUR_LEFT_BROW, map, false);
      ctx.stroke();
      this._path(ctx, lm, CONTOUR_RIGHT_BROW, map, false);
      ctx.stroke();

      // 眼睛：常态白线；闭眼变红加粗——颜色即语义
      /* E4：shadowBlur 只在闭眼（异常告警）时开启——常态睁眼每帧
       * 给两条眼轮廓开高斯模糊是纯开销（GPU 按像素扩散），
       * 且常态白线无需强调；闭眼时的 9px 红色柔光是
       * 告警视觉强调，语义保留。 */
      const eyeColor = state && state.closed ? c.eyeClosed : c.eye;
      ctx.strokeStyle = eyeColor;
      ctx.lineWidth = state && state.closed ? 2.5 : 1.5;
      ctx.shadowColor = eyeColor;
      ctx.shadowBlur = state && state.closed ? 9 : 0;
      this._path(ctx, lm, CONTOUR_LEFT_EYE, map, true);
      ctx.stroke();
      this._path(ctx, lm, CONTOUR_RIGHT_EYE, map, true);
      ctx.stroke();
      ctx.shadowBlur = 0;

      // 嘴：张口时变黄——事件色
      const mouthOpen = state && state.mouthOpen;
      ctx.strokeStyle = mouthOpen ? c.mouth : 'rgba(255,255,255,0.5)';
      ctx.lineWidth = mouthOpen ? 2.1 : 1.5;
      if (mouthOpen) {
        ctx.shadowColor = c.mouth;
        ctx.shadowBlur = 8;
      }
      this._path(ctx, lm, CONTOUR_LIPS_OUTER, map, true);
      ctx.stroke();
      this._path(ctx, lm, CONTOUR_LIPS_INNER, map, true);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    // ---- 虹膜 ----
    if (r.showIris && lm.length > IRIS_LEFT_CENTER) {
      ctx.strokeStyle = c.iris;
      ctx.fillStyle = c.iris;
      ctx.lineWidth = 1.25;
      for (const ring of [IRIS_LEFT, IRIS_RIGHT]) {
        this._path(ctx, lm, ring, map, true);
        ctx.stroke();
      }
      for (const idx of [IRIS_LEFT_CENTER, IRIS_RIGHT_CENTER]) {
        const p = map(lm[idx]);
        ctx.beginPath();
        ctx.arc(p.x, p.y, 1.8, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // ---- 头部姿态三轴 ----
    this._drawPoseAxes(ctx, feat, map(lm[NOSE_TIP]), feat.scale);
  }

  /**
   * 模拟模式下的示意脸绘制（v4：减法重设计）。
   *
   * v3 的问题不是画得不够多，而是画得太多：头发、耳朵、肩颈、红晕、
   * 眼袋、鼻翼、下巴阴影——每一处都在往一张半透明脸上叠笔画，叠出
   * 一团浑浊的"幽灵"。它努力想"像人"，却忘了自己的任务：
   * **清楚地演示眼睛在闭、嘴在张、头在转。**
   *
   * v4 的设计纪律（Apple 式克制）：
   *   · 线稿语言——头是干净的一笔鹅蛋描边，不再堆半透明填充；
   *   · 删掉全部装饰部件（发/耳/肩/颈/红晕/眼袋/鼻翼/下巴阴影/大光晕）；
   *   · 眼睛是唯一的主角，值得抠细节：真实解剖的上睑遮虹膜、单一
   *     光源高光、外高内低的眼角；闭眼 = 红线下弯（事件色）；
   *   · 嘴保留下颌旋转语义，哈欠开口 + 黄色描边（事件色）；
   *   · 状态环改为连续细线——Apple 从不用虚线环。
   *
   * 它同时也是算法教学演示——观众能直观看到 EAR / MAR / 头部角度
   * 与面部状态的对应关系。
   */
  drawSynthetic(feat, state) {
    if (!this.w) this.resize();
    const ctx = this.ctx;
    const { w, h } = this;
    ctx.clearRect(0, 0, w, h);
    if (!feat) return;

    const cx = w / 2;
    const cy = h * 0.46;
    const R = Math.min(w, h) * 0.26;

    const yaw = (feat.yaw || 0) * DEG2RAD;
    const roll = (feat.roll || 0) * DEG2RAD;
    const pitch = (feat.pitch || 0) * DEG2RAD;

    /* ---- 派生量 ----
     * EAR 0.30=全睁 0.055=全闭 → 归一化开合度；哈欠用 jawOpen（0..1）。
     * breathing：3.8s 周期的轻微起伏，让静息状态也不是一张死脸。 */
    const openRatio = clamp((feat.ear - 0.055) / (0.3 - 0.055), 0, 1);
    const jaw = clamp(feat.jawOpen ?? clamp((feat.mar - 0.06) / (0.85 - 0.06), 0, 1), 0, 1);
    const level = (state && state.level) || 'awake';
    const LV = {
      awake: cssVar('--lv-awake', '#1fa355'),
      mild: cssVar('--lv-mild', '#a87705'),
      moderate: cssVar('--lv-moderate', '#f2680c'),
      severe: cssVar('--lv-severe', '#e02b2b'),
    };
    const lvColor = LV[level] || LV.awake;
    const fatigueK = level === 'severe' ? 1 : level === 'moderate' ? 0.6 : level === 'mild' ? 0.3 : 0;
    const breath = Math.sin((feat.ts || 0) / 1900) * R * 0.012;

    /* 头部整体变换：yaw 平移 + roll 旋转 + pitch 下沉 + 呼吸 */
    ctx.save();
    ctx.translate(cx + Math.sin(yaw) * R * 0.55, cy + Math.sin(pitch) * R * 0.38 + breath);
    ctx.rotate(roll);
    const persp = Math.cos(yaw); // 侧转时脸宽轻微压缩（透视暗示）

    /* ---- 状态环：连续细线（Apple 不用虚线环） ---- */
    ctx.strokeStyle = hexA(lvColor, 0.55);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(0, 0, R * 1.28, 0, Math.PI * 2);
    ctx.stroke();

    /* ---- 头：一笔鹅蛋线稿 ---- */
    this._synHead(ctx, R, persp);

    /* ---- 面部器官（眼/眉/鼻/嘴，画在头变换内） ---- */
    this._synFace(ctx, R, persp, openRatio, jaw, fatigueK, state, Math.sin(yaw));

    ctx.restore();

    /* ---- 底部说明：阶段胶囊 + 副标题（不随头动） ---- */
    const phase = feat.phase || '--';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const pillW = Math.max(150, ctx.measureText(`演示模式 · ${phase}`).width + 64);
    const pillH = 28;
    const pillY = h - 52;
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.strokeStyle = hexA(lvColor, 0.55);
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    ctx.roundRect(w / 2 - pillW / 2, pillY, pillW, pillH, pillH / 2);
    ctx.fill();
    ctx.stroke();
    // 指示点
    ctx.fillStyle = lvColor;
    ctx.beginPath();
    ctx.arc(w / 2 - pillW / 2 + 16, pillY + pillH / 2, 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = '600 13px Inter, system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillText(`演示模式 · ${phase}`, w / 2 + 8, pillY + pillH / 2 + 0.5);
    ctx.font = '400 11px Inter, system-ui, -apple-system, "PingFang SC", "Microsoft YaHei", sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.textBaseline = 'alphabetic';
    // 专业模式下说明信号来源；简洁模式只说这是模拟的，避免抛术语
    const sub = document.body.classList.contains('pro-mode')
      ? '示意脸由 EAR / MAR / 头部角度直接驱动，用于演示与自动化测试'
      : '这是模拟出来的脸，不使用摄像头';
    ctx.fillText(sub, w / 2, h - 14);
  }

  /* ============ 示意脸 v4 的分部件绘制（坐标以头部中心为原点、R 为半径） ============ */

  /**
   * 头（v4）：一笔鹅蛋线稿。
   * 颅顶圆 → 颞部 → 颊部收窄 → 圆下巴，1.6px 白描边 + 一档极淡填充
   * 给出体量。不再有发、耳和多层皮肤渐变——那些是 v3 浑浊的来源。
   */
  _synHead(ctx, R, persp) {
    const hw = R * 0.72 * Math.max(0.72, persp); // 半宽
    const hh = R * 1.02; // 半高
    ctx.beginPath();
    ctx.moveTo(0, -hh);
    ctx.bezierCurveTo(hw * 0.82, -hh, hw, -hh * 0.55, hw * 0.98, -hh * 0.08);
    ctx.bezierCurveTo(hw * 0.96, hh * 0.4, hw * 0.5, hh * 0.9, 0, hh * 0.98);
    ctx.bezierCurveTo(-hw * 0.5, hh * 0.9, -hw * 0.96, hh * 0.4, -hw * 0.98, -hh * 0.08);
    ctx.bezierCurveTo(-hw, -hh * 0.55, -hw * 0.82, -hh, 0, -hh);
    ctx.closePath();
    ctx.fillStyle = 'rgba(255,255,255,0.035)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.lineWidth = 1.6;
    ctx.stroke();
  }

  /**
   * 面部器官（v4）：眼睛是主角 / 一笔眉 / 一笔鼻 / 下颌嘴。
   * 删掉了 v3 的红晕、眼袋、鼻翼、下巴阴影——装饰笔画全部退场，
   * 只留承载信息的四件：眉（疲劳下沉）、眼（开合）、鼻（中轴参照）、
   * 嘴（哈欠开口）。
   */
  _synFace(ctx, R, persp, openRatio, jaw, fatigueK, state, gaze = 0) {
    const mouthOpen = state && state.mouthOpen;

    /* ---- 眼睛：位于头部纵向中点，间距约 1 眼宽（面部比例基准） ----
     * 杏仁形 = 内外眼角之间上、下两条眼睑曲线；上睑弧随 openRatio
     * 从全开落到 0，且随疲劳基线下垂。虹膜随视线（yaw）同向偏移。 */
    const eyeY = -R * 0.02;
    const eyeDX = R * 0.33 * Math.max(0.78, persp);
    const eyeW2 = R * 0.17; // 半宽
    const lidH = R * 0.115 * (0.06 + 0.94 * openRatio) * (1 - fatigueK * 0.32); // 上眼睑弧高（含疲劳下垂）
    const lowH = R * 0.068; // 下眼睑弧高（基本不动）

    for (const s of [-1, 1]) {
      const ex = s * eyeDX;

      /* 眉毛：一笔拱形，疲劳时下沉并内倾（困倦眉） */
      const droop = fatigueK * R * 0.055 + (1 - openRatio) * R * 0.018;
      const browY = eyeY - R * 0.15 - droop;
      ctx.strokeStyle = 'rgba(255,255,255,0.6)';
      ctx.lineWidth = R * 0.024;
      ctx.lineCap = 'round';
      ctx.beginPath();
      const inner = ex - s * eyeW2 * 1.0;
      const outer = ex + s * eyeW2 * 1.18;
      ctx.moveTo(inner, browY + R * 0.012 + fatigueK * R * 0.026);
      ctx.quadraticCurveTo(ex, browY - R * 0.05, outer, browY + R * 0.014);
      ctx.stroke();
      ctx.lineCap = 'butt';

      if (lidH > R * 0.012) {
        /* 睁眼：眼睑透镜形 + 虹膜 + 瞳孔 + 高光 */
        const lens = () => {
          ctx.beginPath();
          ctx.moveTo(ex - eyeW2, eyeY);
          ctx.quadraticCurveTo(ex, eyeY - lidH * 2.0, ex + eyeW2, eyeY);
          ctx.quadraticCurveTo(ex, eyeY + lowH * 2.0, ex - eyeW2, eyeY);
          ctx.closePath();
        };
        lens();
        ctx.fillStyle = 'rgba(8,12,17,0.88)';
        ctx.fill();
        ctx.save();
        lens();
        ctx.clip();
        const irisR = R * 0.062;
        const irisX = ex + gaze * R * 0.035;
        const irisY = eyeY - lidH * 0.22 + lowH * 0.2; // 虹膜上移：上眼睑自然盖住虹膜上缘
        ctx.fillStyle = 'rgba(122,146,178,0.92)'; // 单一蓝灰，不再用主题虹膜色
        ctx.beginPath();
        ctx.arc(irisX, irisY, irisR, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = 'rgba(4,8,12,0.75)';
        ctx.beginPath();
        ctx.arc(irisX, irisY, irisR * 0.45, 0, Math.PI * 2);
        ctx.fill();
        // 单一光源高光：虹膜 10 点方向（光源一致性）
        ctx.fillStyle = 'rgba(255,255,255,0.9)';
        ctx.beginPath();
        ctx.arc(irisX - irisR * 0.32, irisY - irisR * 0.36, irisR * 0.24, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
        // 上眼睑线（清晰）、下眼睑线（轻）
        ctx.strokeStyle = 'rgba(255,255,255,0.85)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(ex - eyeW2, eyeY);
        ctx.quadraticCurveTo(ex, eyeY - lidH * 2.0, ex + eyeW2, eyeY);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(255,255,255,0.28)';
        ctx.lineWidth = 1.1;
        ctx.beginPath();
        ctx.moveTo(ex - eyeW2, eyeY);
        ctx.quadraticCurveTo(ex, eyeY + lowH * 2.0, ex + eyeW2, eyeY);
        ctx.stroke();
      } else {
        /* 闭眼：红色下弯线 + 柔光（事件色——颜色即语义） */
        ctx.strokeStyle = this.colors.eyeClosed;
        ctx.lineWidth = 2.2;
        ctx.lineCap = 'round';
        ctx.shadowColor = this.colors.eyeClosed;
        ctx.shadowBlur = 9;
        ctx.beginPath();
        ctx.moveTo(ex - eyeW2, eyeY - R * 0.012);
        ctx.quadraticCurveTo(ex, eyeY + R * 0.05, ex + eyeW2, eyeY - R * 0.012);
        ctx.stroke();
        ctx.shadowBlur = 0;
        ctx.lineCap = 'butt';
      }
    }

    /* ---- 鼻：一笔竖曲线，面部中轴参照（不再有鼻翼弧） ---- */
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 1.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(gaze * R * 0.02, R * 0.02);
    ctx.quadraticCurveTo(gaze * R * 0.045, R * 0.16, gaze * R * 0.015, R * 0.235);
    ctx.stroke();
    ctx.lineCap = 'butt';

    /* ---- 嘴：下颌旋转语义 ----
     * 上唇基本不动（哈欠时略抬），下唇随 jaw 下垂；
     * 开口内部填充深色，哈欠 (jaw>0.5) 时接近正圆；
     * 张口时黄色描边 + 柔光（事件色）。 */
    const mw = R * 0.2 * Math.max(0.8, persp);
    const my = R * 0.5;
    const lipTop = my - R * 0.026 - jaw * R * 0.05;
    const lipBot = my + R * 0.028 + jaw * R * 0.34;
    const round = clamp((jaw - 0.35) / 0.65, 0, 1); // 圆口插值
    ctx.beginPath();
    ctx.moveTo(-mw, my - R * 0.006);
    ctx.quadraticCurveTo(-mw * 0.5, lipTop, 0, lipTop);
    ctx.quadraticCurveTo(mw * 0.5, lipTop, mw, my - R * 0.006);
    const botCtrl = my + (lipBot - my) * (1 - round * 0.45);
    ctx.quadraticCurveTo(mw * (1 - round * 0.15), botCtrl, 0, lipBot - round * R * 0.02);
    ctx.quadraticCurveTo(-mw * (1 - round * 0.15), botCtrl, -mw, my - R * 0.006);
    ctx.closePath();
    ctx.fillStyle = jaw > 0.06 ? 'rgba(10,7,11,0.92)' : 'rgba(255,255,255,0.05)';
    ctx.fill();
    ctx.strokeStyle = mouthOpen ? this.colors.mouth : 'rgba(255,255,255,0.5)';
    ctx.lineWidth = mouthOpen ? 2.1 : 1.5;
    if (mouthOpen) {
      ctx.shadowColor = this.colors.mouth;
      ctx.shadowBlur = 8;
    }
    ctx.stroke();
    ctx.shadowBlur = 0;
  }

  /**
   * 生成归一化坐标 → 画布像素 的映射函数。
   * 视频用 object-fit: cover 填充，因此需要按较大缩放比裁切居中，
   * 否则关键点会与画面错位（这是实现叠加层最容易踩的坑）。
   */
  _makeMapper(videoSize) {
    const vw = (videoSize && videoSize.vw) || 4;
    const vh = (videoSize && videoSize.vh) || 3;
    const cw = this.w;
    const ch = this.h;
    const scale = Math.max(cw / vw, ch / vh);
    const dw = vw * scale;
    const dh = vh * scale;
    const ox = (cw - dw) / 2;
    const oy = (ch - dh) / 2;
    const mirror = CONFIG.render.mirror;
    return (p) => {
      const x = mirror ? 1 - p.x : p.x;
      return { x: ox + x * dw, y: oy + p.y * dh };
    };
  }

  _path(ctx, lm, idxs, map, close) {
    ctx.beginPath();
    for (let i = 0; i < idxs.length; i++) {
      const p = map(lm[idxs[i]]);
      if (i === 0) ctx.moveTo(p.x, p.y);
      else ctx.lineTo(p.x, p.y);
    }
    if (close) ctx.closePath();
  }

  /**
   * 头部姿态三轴（v4：gizmo 风格精修）。
   *
   * 保留 X/Y/Z 三色的学术语义（红=X 摆头 / 绿=Y 俯仰 / 蓝=Z 翻滚，
   * 色值即 Apple 系统色），但呈现方式从"调试工具"收敛为设计软件里
   * 的旋转操纵器：细线、圆头、原点锚点、轴端端点。三色是功能信息，
   * 允许作为语义色出现——与叠加层的单色纪律不冲突。
   */
  _drawPoseAxes(ctx, feat, origin, faceScale) {
    if (!Number.isFinite(feat.pitch)) return;
    const L = Math.max(30, Math.min(70, (faceScale || 0.2) * this.w * 0.5));
    const mirror = CONFIG.render.mirror ? -1 : 1;
    const p = feat.pitch * DEG2RAD;
    const y = feat.yaw * DEG2RAD * mirror;
    const r = feat.roll * DEG2RAD * mirror;

    const cp = Math.cos(p), sp = Math.sin(p);
    const cy = Math.cos(y), sy = Math.sin(y);
    const cr = Math.cos(r), sr = Math.sin(r);

    // R = Rz(roll)·Ry(yaw)·Rx(pitch)，只取投影到屏幕的 x、y 分量
    const axes = [
      { v: [cr * cy, sr * cy], color: '#ff453a' },
      { v: [cr * sy * sp - sr * cp, sr * sy * sp + cr * cp], color: '#30d158' },
      { v: [cr * sy * cp + sr * sp, sr * sy * cp - cr * sp], color: '#0a84ff' },
    ];

    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.lineWidth = 1.6;
    ctx.lineCap = 'round';
    for (const a of axes) {
      const ex = origin.x + a.v[0] * L;
      const ey = origin.y - a.v[1] * L;
      ctx.strokeStyle = a.color;
      ctx.beginPath();
      ctx.moveTo(origin.x, origin.y);
      ctx.lineTo(ex, ey);
      ctx.stroke();
      // 轴端点：小小的实心圆，操纵器的"把手"
      ctx.fillStyle = a.color;
      ctx.beginPath();
      ctx.arc(ex, ey, 1.7, 0, Math.PI * 2);
      ctx.fill();
    }
    // 原点锚点：白色小点，三轴从这里生长
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.beginPath();
    ctx.arc(origin.x, origin.y, 2.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}
