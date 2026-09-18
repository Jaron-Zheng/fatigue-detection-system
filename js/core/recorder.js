/**
 * recorder.js — 会话记录与报告生成
 *
 * 记录内容（全部留在本地内存，可导出为文件）：
 *   · 按固定间隔（默认 500ms）采样的指标时序
 *   · 全部离散事件（眨眼/哈欠/点头/微睡眠/分心/报警）
 *   · 会话汇总统计（各等级驻留时长、峰值分数、事件计数等）
 *
 * 导出格式：JSON（完整结构化）、CSV（指标时序表）、报告（可视化摘要）
 */

import { CONFIG } from '../config.js';
import { fmtDuration } from '../util/math.js';
import { SAMPLE_COLUMNS, LEVEL_KEY_TO_ZH } from './csv-schema.js';

/** 事件中文名（用日常说法而非术语，时间轴是普通用户看的地方） */
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
  recovery: '状态恢复',
  calibrated: '校准完成',
  session_start: '开始检测',
  session_end: '结束检测',
};

export const eventLabel = (t) => EVENT_LABEL[t] || t;

const LEVEL_LABELS = { awake: '清醒', mild: '轻度疲劳', moderate: '中度疲劳', severe: '重度疲劳' };

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
    if (this.endedAt) return;
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

  /** 批量驱逐 + 摊销：容忍 64 条溢出后一次性截掉，减少数组拷贝 */
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
      // 当前正在进行的闭眼时长（与 maxClosureMs 分开记录，安全兜底判据用的是"此刻是否正在闭眼"）
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
    // measuredMs = 真正测到人脸、数据可信的时长；等级占比只在 measuredMs 上归一化
    const measuredMs = Object.values(ld).reduce((a, b) => a + b, 0);
    const unreliableMs = (lastFusion && lastFusion.unreliableMs) || 0;
    const total = measuredMs || 1;
    const coverage = durationMs > 0 ? measuredMs / durationMs : 0;

    // 均值只统计数据有效的采样点
    const validSamples = this.samples.filter((s) => s.dataValid !== 0 && s.facePresent !== 0);
    const statBase = validSamples.length ? validSamples : [];
    const scores = statBase.map((s) => s.score).filter((v) => Number.isFinite(v));
    const perclosArr = statBase.map((s) => s.perclos).filter((v) => Number.isFinite(v));

    // 报告结论用"本次会话达到过的最高等级"，而非结束瞬间的等级
    const ORDER = ['awake', 'mild', 'moderate', 'severe'];
    const LABELS = { awake: '清醒', mild: '轻度疲劳', moderate: '中度疲劳', severe: '重度疲劳' };
    let worstLevel = 'awake';
    for (const k of ORDER) {
      // 该等级驻留超过 1.5s 才算真正达到过（滤掉瞬时穿越）
      if ((ld[k] || 0) > 1500) worstLevel = k;
    }

    // 有效覆盖率过低时，结论本身不成立
    const insufficient = durationMs > 3000 && coverage < 0.5;

    return {
      startedAt: this.startedAt ? this.startedAt.toISOString() : null,
      endedAt: this.endedAt ? this.endedAt.toISOString() : new Date().toISOString(),
      durationMs,
      durationText: fmtDuration(durationMs),
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
      maxPerclos: perclosArr.length ? perclosArr.reduce((m, v) => (v > m ? v : m), -Infinity) : 0,
      levelDurations: ld,
      levelRatios: Object.fromEntries(Object.entries(ld).map(([k, v]) => [k, v / total])),
      counts,
      sampleCount: this.samples.length,
      validSampleCount: validSamples.length,
      calibration: this.calib,
      device: this.deviceInfo,
      engine: engineStats || null,
      trend: !insufficient ? trendOf(validSamples) : null,
      advice: buildAdvice(worstLevel, counts, durationMs, lastFusion, {
        insufficient,
        coverage,
        unreliableMs,
        measuredMs,
        samples: validSamples,
        calib: this.calib,
        levelDurations: ld,
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
   * 导出 CSV（指标时序）。表头中文带单位，BOM 保证 Excel 正确识别 UTF-8。
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

/**
 * 会话趋势：前后半程对比。
 * 按时间中位数分割，双条件（score 均值差 ≥5 且 PERCLOS 差 ≥0.05）判"显著"。
 */
function trendOf(samples) {
  if (!samples || samples.length < 8) return null;
  const mid = samples[Math.floor(samples.length / 2)].t;
  const first = samples.filter((s) => s.t < mid);
  const second = samples.filter((s) => s.t >= mid);
  if (first.length < 4 || second.length < 4) return null;
  const mean = (arr, k) => avg(arr.map((s) => s[k]).filter(Number.isFinite));
  const dScore = mean(second, 'score') - mean(first, 'score');
  const dPerclos = mean(second, 'perclos') - mean(first, 'perclos');
  const worsening = dScore >= 5 && dPerclos >= 0.05;
  const recovering = dScore <= -5 && dPerclos <= -0.05;
  return {
    direction: worsening ? 'worsening' : recovering ? 'recovering' : 'stable',
    firstHalfScore: round(mean(first, 'score'), 1),
    secondHalfScore: round(mean(second, 'score'), 1),
    firstHalfPerclos: round(mean(first, 'perclos'), 3),
    secondHalfPerclos: round(mean(second, 'perclos'), 3),
    splitAtMs: mid,
  };
}

function buildAdvice(worstLevel, counts, durationMs, lastFusion, quality = {}) {
  const minutes = durationMs / 60000;
  const lines = [];
  if (!lastFusion || durationMs < 5000) {
    return ['本次检测时长过短，数据不足以形成有效结论。建议连续检测 2 分钟以上。'];
  }

  // 有效数据不足时直接给出"没测成"的结论
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

  // 等级驻留量化
  const ld = quality.levelDurations || {};
  const levelMs = ld[level] || 0;
  const measuredMsQ = quality.measuredMs || 0;
  if (level !== 'awake' && levelMs > 0 && measuredMsQ > 0) {
    const pctStr = ((levelMs / measuredMsQ) * 100).toFixed(1);
    lines.push(`其中「${LEVEL_LABELS[level]}」状态累计 ${fmtDuration(levelMs)}，占有效检测时间的 ${pctStr}%。`);
  }

  // 会话趋势
  const trend = trendOf(quality.samples);
  if (trend) {
    const pct = (v) => (v != null ? (v * 100).toFixed(1) + '%' : '--');
    if (trend.direction === 'worsening') {
      lines.push(
        `疲劳呈加重趋势：后半小时段平均疲劳指数 ${trend.secondHalfScore}（前半 ${trend.firstHalfScore}），` +
          `PERCLOS 均值从 ${pct(trend.firstHalfPerclos)} 升至 ${pct(trend.secondHalfPerclos)}。` +
          '当前状态若持续，建议尽快安排休息，不要等下一级报警。'
      );
    } else if (trend.direction === 'recovering') {
      lines.push(
        `状态在好转：平均疲劳指数从 ${trend.firstHalfScore} 回落到 ${trend.secondHalfScore}，` +
          `PERCLOS 均值从 ${pct(trend.firstHalfPerclos)} 降至 ${pct(trend.secondHalfPerclos)}。` +
          '但仍以本次达到过的最高等级为结论口径，不要因末段好转放松。'
      );
    } else {
      lines.push(
        `全程状态稳定：前后半程平均疲劳指数 ${trend.firstHalfScore} → ${trend.secondHalfScore}，` +
          `PERCLOS 均值 ${pct(trend.firstHalfPerclos)} → ${pct(trend.secondHalfPerclos)}，无显著漂移。`
      );
    }
  }

  // 标定质量提示
  const calib = quality.calib;
  if (calib && (calib.quality === 0 || calib.skipped)) {
    lines.push(
      '注意：本次判定使用通用阈值（未完成个性化标定）。' +
        '睁眼/闭眼基准未按你本人的面部特征校准，判定的置信度低于正常会话；' +
        '建议下次检测开始时保持正视镜头 5 秒以完成标定。'
    );
  }

  if (counts.yawn >= 3 && minutes > 1) {
    lines.push(`累计哈欠 ${counts.yawn} 次（约 ${(counts.yawn / minutes).toFixed(1)} 次/分），是嗜睡的早期信号。`);
  }
  if (counts.microsleep > 0) {
    lines.push(`出现 ${counts.microsleep} 次超过 0.5 秒的长时间闭眼，需高度重视。`);
  }
  // 点头与分心按频率判定，不只看绝对次数
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
 * 处理格式正确性（含逗号/引号/换行的值加引号）与公式注入防护（= + - @ 开头加单引号）。
 * 数字字面量原样输出，不误伤负数。
 */
export function csvCell(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
  if (typeof value === 'boolean') return value ? '1' : '0';
  let s = String(value);
  if (/^-?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(s)) return s;
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/**
 * 触发浏览器下载（纯前端生成，不经过服务器）。
 * download 属性主防线 + rel="noopener" + target="_blank" 兜底。
 */
export function downloadFile(filename, content, mime = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.target = '_blank';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    if (a.parentNode) a.parentNode.removeChild(a);
  }, 0);
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

let nameSeq = 0;

export function timestampName(prefix, ext) {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  nameSeq = (nameSeq % 1000) + 1;
  return `${prefix}_${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${ms}_r${p(nameSeq, 3)}.${ext}`;
}
