/**
 * recorder.js — 会话记录与报告生成
 *
 * 记录内容（全部留在本地内存，可导出为文件）：
 *   · 按固定间隔（默认 500ms）采样的指标时序，用于绘制趋势与写论文附图；
 *   · 全部离散事件（眨眼/哈欠/点头/微睡眠/分心/报警）；
 *   · 会话汇总统计（各等级驻留时长、峰值分数、事件计数等）。
 *
 * 导出格式：
 *   JSON —— 完整结构化数据，便于二次分析（Python/MATLAB 都能直接读）
 *   CSV  —— 指标时序表，可直接拖进 Excel 画图
 *   报告 —— 屏幕内可视化摘要 + 打印为 PDF
 */

import { CONFIG } from '../config.js';
import { fmtDuration } from '../util/math.js';
import { SAMPLE_COLUMNS, LEVEL_KEY_TO_ZH } from './csv-schema.js';

/**
 * 事件中文名。
 * 用日常说法而不是术语：时间轴是普通用户看的地方，
 * 「视线偏离」不如「注意力分散」直观，「数据质量不足」不如「画面看不清」。
 */
const EVENT_LABEL = {
  blink: '眨眼',
  microsleep: '长时间闭眼',
  critical_closure: '危险闭眼',
  yawn: '打哈欠',
  yawn_end: '哈欠结束',
  nod: '点头',
  distraction: '注意力分散',
  face_lost: '没看到人脸',
  face_found: '重新看到人脸',
  quality_low: '画面看不清',
  quality_ok: '画面恢复正常',
  alarm: '疲劳提醒',
  calibrated: '校准完成',
  session_start: '开始检测',
  session_end: '结束检测',
};

export const eventLabel = (t) => EVENT_LABEL[t] || t;

export class SessionRecorder {
  constructor() {
    this.reset();
  }

  reset() {
    this.samples = [];
    this.events = [];
    this.startedAt = null;
    this.startedPerf = null;
    this.endedAt = null;
    this.calib = null;
    this.deviceInfo = null;
    this._lastSampleTs = -1e9;
  }

  begin(calib, deviceInfo) {
    this.reset();
    this.startedAt = new Date();
    this.startedPerf = performance.now();
    this.calib = calib ? JSON.parse(JSON.stringify(calib)) : null;
    this.deviceInfo = deviceInfo || null;
    this.addEvent({ type: 'session_start', ts: this.startedPerf, level: 'info', message: '本次检测开始' });
  }

  end() {
    this.endedAt = new Date();
    this.addEvent({ type: 'session_end', ts: performance.now(), level: 'info', message: '本次检测结束' });
  }

  addEvent(ev) {
    this.events.push({ ...ev, wallClock: ev.wallClock || Date.now() });
    if (this.events.length > CONFIG.record.maxEvents) this.events.shift();
  }

  addEvents(list) {
    for (const e of list) this.addEvent(e);
  }

  /**
   * 样本容量控制采用「批量驱逐 + 摊销」：
   * 逐条 shift() 在长会话里是每采样一次就 O(n) 拷贝一次整个数组
   * （maxSamples=7200，超过 1 小时后每次采样都触发）。
   * 改为容忍 64 条溢出后一次性截掉，把数组拷贝从每 500ms 一次
   * 降为约每 32 秒一次，且对外的 samples 数组语义不变。
   */
  _trimSamples() {
    const over = this.samples.length - CONFIG.record.maxSamples;
    if (over > 64) this.samples.splice(0, over);
  }

  /** 按采样间隔节流写入指标 */
  sample(ind, fusion, feat) {
    const ts = ind.ts;
    if (ts - this._lastSampleTs < CONFIG.record.sampleIntervalMs) return;
    this._lastSampleTs = ts;

    this.samples.push({
      t: Math.round(ts - (this.startedPerf || 0)),
      score: round(fusion.score, 2),
      raw: round(fusion.raw, 2),
      level: fusion.level,
      perclos: round(ind.perclos, 4),
      perclosReady: ind.perclosReady !== false,
      dataValid: ind.dataValid === false ? 0 : 1,
      closure: round(ind.closure, 3),
      maxClosureMs: Math.round(ind.maxClosureMs),
      /**
       * 当前正在进行的闭眼时长。
       * 必须与 maxClosureMs（窗口内峰值）分开记录：
       * 安全兜底 override 判据用的是"此刻是否正在持续闭眼"，
       * 若离线重算时误用窗口峰值，一次长闭眼会让 override 在整个窗口内
       * 持续触发，把分数永久钉在高位，导致敏感性分析完全失效。
       */
      currentClosureMs: Math.round(ind.currentClosureMs || 0),
      blinkRate: round(ind.blinkRate, 2),
      avgBlinkMs: Number.isFinite(ind.avgBlinkMs) ? Math.round(ind.avgBlinkMs) : null,
      yawnRate: round(ind.yawnRate, 3),
      nodRate: round(ind.nodRate, 3),
      headDevRatio: round(ind.headDevRatio, 3),
      ear: feat && Number.isFinite(feat.ear) ? round(feat.ear, 4) : null,
      mar: feat && Number.isFinite(feat.mar) ? round(feat.mar, 4) : null,
      pitch: feat && Number.isFinite(feat.pitch) ? round(feat.pitch, 2) : null,
      yaw: feat && Number.isFinite(feat.yaw) ? round(feat.yaw, 2) : null,
      roll: feat && Number.isFinite(feat.roll) ? round(feat.roll, 2) : null,
      facePresent: ind.facePresent ? 1 : 0,
    });
    this._trimSamples();
  }

  /** 生成会话汇总 */
  summary(lastInd, lastFusion, engineStats) {
    const durationMs = lastInd ? lastInd.sessionMs : 0;
    const counts = countEvents(this.events);
    const ld = (lastFusion && lastFusion.levelDurations) || {};
    /**
     * measuredMs 是真正测到人脸、数据可信的时长；
     * unreliableMs 是人脸丢失或画面不合格、系统无法判断的时长。
     * 等级占比只在 measuredMs 上归一化，否则"没测到"会被摊进各等级里。
     */
    const measuredMs = Object.values(ld).reduce((a, b) => a + b, 0);
    const unreliableMs = (lastFusion && lastFusion.unreliableMs) || 0;
    const total = measuredMs || 1;
    const coverage = durationMs > 0 ? measuredMs / durationMs : 0;

    // 均值只统计数据有效的采样点：无人脸时各指标全为 0，
    // 一并平均会把"测不到"稀释成"分数很低"，也就是假阴性。
    const validSamples = this.samples.filter((s) => s.dataValid !== 0 && s.facePresent !== 0);
    const statBase = validSamples.length ? validSamples : [];
    const scores = statBase.map((s) => s.score).filter((v) => Number.isFinite(v));
    const perclosArr = statBase.map((s) => s.perclos).filter((v) => Number.isFinite(v));

    /**
     * 报告结论用「本次会话达到过的最高等级」，而不是结束瞬间的等级。
     * 原因：若驾驶员在检测末尾恰好清醒了一会儿，用结束时的等级作结论会得出
     * "本次检测：清醒"，完全掩盖中途出现过的重度疲劳——这是危险的误导。
     * 体检报告应该反映最严重的发现，结束状态另行列出。
     */
    const ORDER = ['awake', 'mild', 'moderate', 'severe'];
    const LABELS = { awake: '清醒', mild: '轻度疲劳', moderate: '中度疲劳', severe: '重度疲劳' };
    let worstLevel = 'awake';
    for (const k of ORDER) {
      // 该等级驻留超过 1.5s 才算真正达到过（滤掉瞬时穿越）
      if ((ld[k] || 0) > 1500) worstLevel = k;
    }

    /**
     * 有效覆盖率过低时，结论本身不成立。
     * 与其给出"清醒"这种看似安心的判断，不如明确告诉用户这次没测成。
     */
    const insufficient = durationMs > 3000 && coverage < 0.5;

    return {
      startedAt: this.startedAt ? this.startedAt.toISOString() : null,
      endedAt: this.endedAt ? this.endedAt.toISOString() : new Date().toISOString(),
      durationMs,
      durationText: fmtDuration(durationMs),
      /** 真正测到人脸的时长与占比，报告必须展示，否则无法判断结论可不可信 */
      measuredMs,
      measuredText: fmtDuration(measuredMs),
      unreliableMs,
      unreliableText: fmtDuration(unreliableMs),
      coverage,
      insufficient,
      worstLevel,
      worstLevelLabel: insufficient ? '数据不足' : LABELS[worstLevel],
      finalLevel: lastFusion ? lastFusion.level : 'awake',
      finalLevelLabel: lastFusion ? lastFusion.levelLabel : '清醒',
      avgScore: scores.length ? avg(scores) : 0,
      peakScore: lastFusion ? lastFusion.peakScore : 0,
      avgPerclos: perclosArr.length ? avg(perclosArr) : 0,
      maxPerclos: perclosArr.length ? Math.max(...perclosArr) : 0,
      levelDurations: ld,
      levelRatios: Object.fromEntries(Object.entries(ld).map(([k, v]) => [k, v / total])),
      counts,
      sampleCount: this.samples.length,
      validSampleCount: validSamples.length,
      calibration: this.calib,
      device: this.deviceInfo,
      engine: engineStats || null,
      /** 综合建议：按本次达到过的最高等级与事件给出可执行结论 */
      advice: buildAdvice(worstLevel, counts, durationMs, lastFusion, {
        insufficient,
        coverage,
        unreliableMs,
        measuredMs,
      }),
    };
  }

  /** 导出 JSON（完整数据） */
  toJSON(lastInd, lastFusion, engineStats) {
    return {
      meta: {
        product: '基于面部多特征融合的Web端驾驶员疲劳检测系统',
        version: '1.0.0',
        exportedAt: new Date().toISOString(),
        userAgent: navigator.userAgent,
        note: '所有视频帧均在浏览器本地处理，本文件不含任何图像数据。',
      },
      config: {
        window: CONFIG.window,
        event: CONFIG.event,
        fusion: CONFIG.fusion,
        calibration: CONFIG.calibration,
      },
      summary: this.summary(lastInd, lastFusion, engineStats),
      samples: this.samples,
      events: this.events.map((e) => ({
        type: e.type,
        label: eventLabel(e.type),
        tMs: Math.round(e.ts - (this.startedPerf || 0)),
        level: e.level || 'info',
        message: e.message || '',
        durationMs: e.durationMs || null,
      })),
    };
  }

  /**
   * 导出 CSV（指标时序）。
   *
   * 表头用中文并带上单位，直接双击就能在 Excel 里看懂；
   * 列顺序与 SAMPLE_COLUMNS 一致，离线复现按同一份定义读回来。
   */
  toCSV() {
    const lines = [SAMPLE_COLUMNS.map((c) => c.zh).map(csvCell).join(',')];
    for (const s of this.samples) {
      const row = {
        t: s.t,
        score: s.score,
        raw: s.raw,
        level: LEVEL_KEY_TO_ZH[s.level] || s.level,
        perclos: s.perclos,
        perclosReady: s.perclosReady ? 1 : 0,
        closure: s.closure,
        maxClosureMs: s.maxClosureMs,
        currentClosureMs: s.currentClosureMs ?? 0,
        blinkRate: s.blinkRate,
        avgBlinkMs: s.avgBlinkMs ?? '',
        yawnRate: s.yawnRate,
        nodRate: s.nodRate,
        headDevRatio: s.headDevRatio,
        ear: s.ear ?? '',
        mar: s.mar ?? '',
        pitch: s.pitch ?? '',
        yaw: s.yaw ?? '',
        roll: s.roll ?? '',
        facePresent: s.facePresent,
        dataValid: s.dataValid ?? 1,
      };
      lines.push(SAMPLE_COLUMNS.map((c) => csvCell(row[c.key])).join(','));
    }
    // BOM 保证 Excel 正确识别 UTF-8
    return '\ufeff' + lines.join('\r\n');
  }
}

function countEvents(events) {
  const c = {};
  for (const e of events) c[e.type] = (c[e.type] || 0) + 1;
  return {
    blink: c.blink || 0,
    microsleep: c.microsleep || 0,
    criticalClosure: c.critical_closure || 0,
    yawn: c.yawn || 0,
    nod: c.nod || 0,
    distraction: c.distraction || 0,
    faceLost: c.face_lost || 0,
    qualityLow: c.quality_low || 0,
    alarm: c.alarm || 0,
  };
}

function buildAdvice(worstLevel, counts, durationMs, lastFusion, quality = {}) {
  const minutes = durationMs / 60000;
  const lines = [];
  if (!lastFusion || durationMs < 5000) {
    return ['本次检测时长过短，数据不足以形成有效结论。建议连续检测 2 分钟以上。'];
  }

  /**
   * 有效数据不足时直接给出"没测成"的结论并停止后续解读。
   * 这里绝不能退回"状态良好"：整段时间都没看到人脸的会话，
   * 说"未发现明显疲劳特征"在字面上成立，在实际含义上却是彻底的误导。
   */
  if (quality.insufficient) {
    const covPct = ((quality.coverage || 0) * 100).toFixed(0);
    lines.push(
      `本次检测只有 ${covPct}% 的时间真正看到了人脸（有效 ${fmtDuration(quality.measuredMs || 0)} / ` +
        `共 ${fmtDuration(durationMs)}），不足以给出疲劳结论。`
    );
    lines.push(
      '常见原因：人不在画面里、被手或物体遮挡、坐得太偏或太远、光线太暗。' +
        '请让面部完整正对摄像头，保证光照充足后重新检测。'
    );
    if (counts.faceLost > 0) lines.push(`期间人脸丢失 ${counts.faceLost} 次。`);
    return lines;
  }
  if (quality.unreliableMs > 3000) {
    lines.push(
      `提示：其中约 ${fmtDuration(quality.unreliableMs)} 没有测到有效人脸，` +
        `这段时间未参与统计，下面的结论基于剩余的有效数据。`
    );
  }

  const level = worstLevel;
  if (level === 'severe' || counts.criticalClosure > 0) {
    lines.push('检测到重度疲劳或危险闭眼，属于高风险状态。若在实际驾驶中出现，应立即靠边停车休息 20 分钟以上。');
  } else if (level === 'moderate') {
    lines.push('处于中度疲劳。建议在 15 分钟内进入服务区休息，避免继续长时间驾驶。');
  } else if (level === 'mild') {
    lines.push('出现轻度疲劳征兆。建议开窗通风、调整坐姿，并留意后续状态变化。');
  } else {
    lines.push('本次检测全程状态良好，未发现明显疲劳特征。');
  }

  if (counts.yawn >= 3 && minutes > 1) {
    lines.push(`累计哈欠 ${counts.yawn} 次（约 ${(counts.yawn / minutes).toFixed(1)} 次/分），是嗜睡的早期信号。`);
  }
  if (counts.microsleep > 0) {
    lines.push(`出现 ${counts.microsleep} 次超过 0.5 秒的长时间闭眼，需高度重视。`);
  }
  /**
   * 点头与分心都按频率判定，不能只看绝对次数。
   * 5 分钟里 3 次点头（0.6 次/分）属于正常的看仪表、活动脖子；
   * 但 1 分钟里 3 次（3 次/分）才是打盹征兆。
   * 用绝对次数会让会话越长越容易误触发结论。
   */
  if (counts.nod >= 3 && counts.nod / minutes >= 1.5) {
    lines.push(
      `记录到 ${counts.nod} 次点头动作（约 ${(counts.nod / minutes).toFixed(1)} 次/分），可能已进入间歇性打盹。`
    );
  }
  if (counts.distraction >= 2 && counts.distraction / minutes >= 1) {
    lines.push(
      `有 ${counts.distraction} 次头部长时间偏离正前方（约 ${(counts.distraction / minutes).toFixed(1)} 次/分），注意保持对前方道路的观察。`
    );
  }
  if (counts.faceLost >= 3) {
    lines.push('人脸多次丢失，可能是坐姿偏移或光照不足，会影响检测可靠性。建议调整摄像头位置与照明。');
  }
  return lines;
}

const round = (v, d) => (Number.isFinite(v) ? Number(v.toFixed(d)) : null);
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;

/**
 * CSV 单元格安全转义。
 *
 * 两类问题必须一起处理：
 *
 * ① 格式正确性：含逗号、引号、换行的值必须整体加引号并把内部引号翻倍，
 *    否则列会错位。
 *
 * ② 公式注入（CSV Injection / Formula Injection）：
 *    Excel、WPS、LibreOffice 会把以 = + - @ 以及制表符、回车开头的单元格
 *    当作公式执行。若某个字段来自不可控来源（例如导入的 CSV 文件名、
 *    用户填写的实验备注），一个 `=HYPERLINK(...)` 或 `=cmd|...` 之类的值
 *    在打开表格时就可能触发外部请求甚至命令执行。
 *    因此在这类前缀前加一个单引号，Excel 会按纯文本显示。
 *
 * 本系统当前导出的都是自产数值，但导出函数属于"数据出口"，
 * 一旦后续加入用户备注、文件名等字段就会直接暴露风险，
 * 在出口处统一防护比逐个字段判断更可靠。
 *
 * ③ 但防护不能误伤负数：
 *    早先的实现对任何以 - 开头的值都加单引号，于是 pitch = -3.86 被写成
 *    '-3.86。Excel 会把带前置单引号的单元格当纯文本，那一整列就再也不能
 *    求平均、画折线——而抬头低头角恰恰是必须带符号分析的量。
 *    数字本身不可能构成公式，因此数值与纯数字字面量一律原样输出，
 *    只对真正的文本套用防护。
 */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  let s = String(value);
  // 纯数字字面量（含负号、小数、科学计数法）直接放行
  if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return s;
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** 触发浏览器下载（不经过服务器，纯前端生成） */
export function downloadFile(filename, content, mime = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 500);
}

export function timestampName(prefix, ext) {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${prefix}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.${ext}`;
}
