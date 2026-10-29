/**
 * indicators.js — 指标层：把逐帧特征聚合为具有生理意义的疲劳指标
 *
 * 特征（EAR/MAR/角度）是瞬时量，不能直接判定疲劳；
 * 真正与嗜睡程度相关的是它们在时间维度上的统计量：
 *   PERCLOS(P80)       单位时间内眼睛闭合程度超过 80% 的时间占比
 *   最长持续闭眼时长   微睡眠（microsleep）的直接证据
 *   眨眼频率 / 时长    疲劳早期频率升高，深度疲劳时变慢变长
 *   哈欠频率          需与"说话"区分：靠持续时长 + 张口幅度联合判定
 *   点头频率          打盹时头部下沉再猛抬，表现为俯仰角速度尖峰
 *   头部/视线偏离占比  分心与注意力涣散
 */

import { CONFIG } from '../config.js';
import { TimeWindow, EventWindow, TimeWeightedWindow } from '../util/ring-buffer.js';
import { clamp } from '../util/math.js';

const EyeState = { OPEN: 'open', CLOSED: 'closed' };

export class IndicatorEngine {
  constructor() {
    const w = CONFIG.window;
    // PERCLOS 主统计窗口：按真实时间加权（P80 判据）
    this.perclosWin = new TimeWeightedWindow(w.perclosSec * 1000, w.maxSampleGapMs);
    // 闭合度序列（0=完全睁开, 1=完全闭合），仅用于波形显示
    this.closureWin = new TimeWindow(w.perclosSec * 1000, 40);
    this.earWin = new TimeWindow(w.waveSec * 1000, 40);
    this.marWin = new TimeWindow(w.waveSec * 1000, 40);
    this.scoreWin = new TimeWindow(w.waveSec * 1000, 40);

    this.blinkWin = new EventWindow(w.rateSec * 1000);
    this.yawnWin = new EventWindow(w.rateSec * 1000);
    this.nodWin = new EventWindow(w.rateSec * 1000);

    this.reset();
  }

  reset() {
    this.perclosWin.clear();
    this.closureWin.clear();
    this.earWin.clear();
    this.marWin.clear();
    this.scoreWin.clear();
    this.blinkWin.clear();
    this.yawnWin.clear();
    this.nodWin.clear();

    this.eyeState = EyeState.OPEN;
    this.eyeStateSince = 0;
    this.currentClosureMs = 0;
    this.maxClosureMsInWindow = 0;
    this.closureHistory = [];
    this.lastBlinkDurations = [];

    this.mouthOpen = false;
    this.mouthOpenSince = 0;
    this.lastYawnTs = -1e9;
    this.yawnActive = false;

    this.lastNodTs = -1e9;

    this.headDeviating = false;
    this.headDeviateSince = 0;
    this.deviationAccumMs = 0;
    this.observeAccumMs = 0;
    this._distractionReported = false;

    this.faceLostSince = null;
    this.faceLostAccumMs = 0;
    this._faceLostReported = false;

    this.quality = { valid: true, reasons: [], label: '良好' };
    this.lighting = { valid: true, label: '光照良好' };
    this.qualityBadSince = null;
    this.qualityBadAccumMs = 0;

    this.startTs = null;
    this.lastTs = null;
    this.frames = 0;
    this.facePresentFrames = 0;

    this.events = [];
    this._pending = [];
    this._criticalReported = 0;
  }

  syncWindows() {
    const w = CONFIG.window;
    this.perclosWin.setWindow(w.perclosSec * 1000);
    this.perclosWin.maxGapMs = w.maxSampleGapMs;
    this.closureWin.setWindow(w.perclosSec * 1000, 40);
    this.earWin.setWindow(w.waveSec * 1000, 40);
    this.marWin.setWindow(w.waveSec * 1000, 40);
    this.scoreWin.setWindow(w.waveSec * 1000, 40);
    this.blinkWin.setWindow(w.rateSec * 1000);
    this.yawnWin.setWindow(w.rateSec * 1000);
    this.nodWin.setWindow(w.rateSec * 1000);
  }

  _emit(type, ts, detail = {}) {
    const ev = { type, ts, wallClock: Date.now(), ...detail };
    this.events.push(ev);
    if (this.events.length > CONFIG.record.maxEvents) this.events.shift();
    return ev;
  }

  /** 取出并清空自上次调用以来产生的新事件 */
  drainNewEvents() {
    const out = this._pending || [];
    this._pending = [];
    return out;
  }

  _push(type, ts, detail) {
    const ev = this._emit(type, ts, detail);
    if (!this._pending) this._pending = [];
    this._pending.push(ev);
    return ev;
  }

  /**
   * 处理一帧。
   * 人脸丢失时冻结眼睛状态机、中断 PERCLOS 时间累积。
   * 数据质量不合格时同样按"观测中断"处理。
   * observeAccumMs（有效观测时钟）只在人脸在场且质量合格时累计。
   */
  update(feat, calib, quality = null) {
    const ts = feat.ts;
    if (this.startTs === null) this.startTs = ts;
    const dt = this.lastTs === null ? 0 : Math.max(0, Math.min(500, ts - this.lastTs));
    this.lastTs = ts;
    this.frames++;

    const ev = CONFIG.event;

    // 人脸丢失处理：内部状态立即反应（冻结状态机、中断 PERCLOS），事件上报做去抖
    if (!feat.ok) {
      this.faceLostAccumMs += dt;
      if (this.faceLostSince === null) this.faceLostSince = ts;
      if (!this._faceLostReported && ts - this.faceLostSince >= ev.faceLostReportMs) {
        this._faceLostReported = true;
        this._push('face_lost', ts, { level: 'info', message: '未检测到人脸' });
      }
      if (this.eyeState === EyeState.CLOSED) this._closeEyeEpisode(ts, true);
      this.perclosWin.interrupt();
      return this._snapshot(ts, feat, calib, false, false);
    }
    if (this.faceLostSince !== null) {
      if (this._faceLostReported) {
        this._push('face_found', ts, {
          level: 'info',
          message: '人脸重新捕获',
          durationMs: ts - this.faceLostSince,
        });
        this._faceLostReported = false;
      }
      this.faceLostSince = null;
    }
    this.facePresentFrames++;

    // 数据质量门控：质量不合格时不累计时间、不参与判定
    if (quality) {
      this.quality = quality.face || this.quality;
      this.lighting = quality.lighting || this.lighting;
    }
    const qualityOk = !CONFIG.quality.enabled || !CONFIG.quality.gateFatigueJudgement || this.quality.valid;
    if (!qualityOk) {
      this.qualityBadAccumMs += dt;
      if (this.qualityBadSince === null) {
        this.qualityBadSince = ts;
        this._push('quality_low', ts, {
          level: 'warn',
          message: this.quality.reasons && this.quality.reasons.length ? this.quality.reasons[0] : '数据质量不足',
        });
      }
      if (this.eyeState === EyeState.CLOSED) this._closeEyeEpisode(ts, true);
      this.perclosWin.interrupt();
      return this._snapshot(ts, feat, calib, true, false);
    }
    if (this.qualityBadSince !== null) {
      this._push('quality_ok', ts, { level: 'info', message: '数据质量恢复' });
      this.qualityBadSince = null;
    }

    // 有效观测时钟
    this.observeAccumMs += dt;

    // 眼睛闭合度（几何 + 语义双通道融合）
    const closure = this._closureDegree(feat, calib);
    this.closureWin.push(ts, closure);
    this.perclosWin.push(ts, closure >= CONFIG.event.eyeCloseOn);
    this.earWin.push(ts, Number.isFinite(feat.ear) ? feat.ear : 0);
    this.marWin.push(ts, Number.isFinite(feat.mar) ? feat.mar : 0);

    // 眼睛状态机（带滞回 + 语义否决）
    const CLOSE_ON = CONFIG.event.eyeCloseOn;
    const CLOSE_OFF = CONFIG.event.eyeCloseOff;

    // 语义否决：当语义通道明确表示"睁着"时，提前结束闭眼片段
    // （仰头时 EAR 投影压缩导致几何通道饱和为 1，语义通道可纠偏）
    const semOpenVeto =
      Number.isFinite(feat.blinkScore) &&
      this._semClosure(feat, calib) < CONFIG.quality.semanticOpenVeto;

    if (this.eyeState === EyeState.OPEN && closure >= CLOSE_ON) {
      this.eyeState = EyeState.CLOSED;
      this.eyeStateSince = ts;
    } else if (this.eyeState === EyeState.CLOSED && (closure <= CLOSE_OFF || semOpenVeto)) {
      this._closeEyeEpisode(ts, false);
    }
    this.currentClosureMs = this.eyeState === EyeState.CLOSED ? ts - this.eyeStateSince : 0;

    // 持续闭眼达到危险时长 → 立即上报
    if (this.eyeState === EyeState.CLOSED && this.currentClosureMs >= ev.criticalClosureMs) {
      if (!this._criticalReported || ts - this._criticalReported > 3000) {
        this._criticalReported = ts;
        this._push('critical_closure', ts, {
          level: 'danger',
          durationMs: this.currentClosureMs,
          message: `持续闭眼 ${(this.currentClosureMs / 1000).toFixed(1)}s`,
        });
      }
    }

    // 哈欠检测
    this._updateYawn(feat, calib, ts);

    // 点头检测
    this._updateNod(feat, ts);

    // 头部偏离 / 分心
    this._updateHeadDeviation(feat, calib, ts, dt);

    return this._snapshot(ts, feat, calib, true);
  }

  /**
   * 闭合度归一化：EAR 映射到 [0,1]（0=完全睁开，1=完全闭合），
   * 再与语义通道 eyeBlink 系数线性融合：closure = 0.6·geo + 0.4·sem
   *
   * 几何通道： closure_geo = (EAR_open − EAR) / (EAR_open − EAR_close)
   * 语义通道： closure_sem = eyeBlink 系数（去个体基线偏移后归一化）
   *
   * 原来的 max(geo, sem) 偏置项已去掉：实测发现它在仰头/点头时
   * 产生严重姿态假阳性（EAR 投影压缩 → geo 饱和为 1 → 语义通道形同虚设）。
   * 改用 0.6geo + 0.4sem 后，触发闭眼需要 sem ≥ 0.50，真闭眼与姿态假阳性的
   * 语义值分离得很干净（真闭眼 0.61~0.75，假阳性 0.24~0.43）。
   */
  _closureDegree(feat, calib) {
    const open = calib.earBaseline;
    const close = calib.earCloseThresh;
    let geo = NaN;
    if (Number.isFinite(feat.ear) && open > close) {
      geo = clamp((open - feat.ear) / (open - close), 0, 1.25);
      geo = Math.min(1, geo);
    }
    const sem = this._semClosure(feat, calib);
    if (!Number.isFinite(geo) && !Number.isFinite(sem)) return 0;
    if (!Number.isFinite(geo)) return sem;
    if (!Number.isFinite(sem)) return geo;
    return clamp(0.6 * geo + 0.4 * sem, 0, 1);
  }

  /**
   * 语义通道闭合度：eyeBlink 系数去个体基线偏移后归一化到 [0,1]。
   * 眼睛状态机的语义否决也用同一个量，两处口径一致。
   */
  _semClosure(feat, calib) {
    if (!Number.isFinite(feat.blinkScore)) return NaN;
    const b0 = calib.blinkScoreBaseline || 0.05;
    return clamp((feat.blinkScore - b0) / (0.92 - b0), 0, 1);
  }

  /** 结束一次闭眼片段：判定是"眨眼"还是"微睡眠" */
  _closeEyeEpisode(ts, aborted) {
    const dur = ts - this.eyeStateSince;
    this.eyeState = EyeState.OPEN;
    this.currentClosureMs = 0;
    this._criticalReported = 0;
    if (aborted) return;

    const ev = CONFIG.event;
    this.closureHistory.push({ ts, dur });
    const cutoff = ts - CONFIG.window.perclosSec * 1000;
    while (this.closureHistory.length && this.closureHistory[0].ts < cutoff) this.closureHistory.shift();

    if (dur >= ev.blinkMinMs && dur <= ev.blinkMaxMs) {
      this.blinkWin.push(ts, dur);
      this.lastBlinkDurations.push(dur);
      if (this.lastBlinkDurations.length > 60) this.lastBlinkDurations.shift();
      this._push('blink', ts, { level: 'info', durationMs: dur });
    } else if (dur > ev.microsleepMs) {
      // 超过 500ms 的闭合不再算眨眼，而是"长闭眼/微睡眠"
      // 不推进 blinkWin：避免污染平均眨眼时长与掩盖频率下降趋势
      this._push('microsleep', ts, {
        level: dur >= ev.criticalClosureMs ? 'danger' : 'warn',
        durationMs: dur,
        message: `长时闭眼 ${(dur / 1000).toFixed(2)}s`,
      });
    }
  }

  /**
   * 哈欠判定：MAR 超阈值 且 持续 ≥1.2s 且 jawOpen 系数 >0.45。
   * 持续时长是区分哈欠与说话的关键。
   */
  _updateYawn(feat, calib, ts) {
    const ev = CONFIG.event;
    const marOpen = Number.isFinite(feat.mar) && feat.mar >= calib.marOpenThresh;
    const jawOpen = Number.isFinite(feat.jawOpen) ? feat.jawOpen > 0.45 : true;
    const isOpen = marOpen && jawOpen;

    if (isOpen && !this.mouthOpen) {
      this.mouthOpen = true;
      this.mouthOpenSince = ts;
      this.yawnActive = false;
    } else if (!isOpen && this.mouthOpen) {
      const dur = ts - this.mouthOpenSince;
      this.mouthOpen = false;
      if (this.yawnActive) {
        this._push('yawn_end', ts, { level: 'info', durationMs: dur });
      }
      this.yawnActive = false;
    } else if (isOpen && this.mouthOpen && !this.yawnActive) {
      const dur = ts - this.mouthOpenSince;
      if (dur >= ev.yawnMinMs && ts - this.lastYawnTs >= ev.yawnRefractoryMs) {
        this.yawnActive = true;
        this.lastYawnTs = ts;
        this.yawnWin.push(ts, dur);
        this._push('yawn', ts, {
          level: 'warn',
          durationMs: dur,
          mar: feat.mar,
          message: '检测到哈欠',
        });
      }
    }
    this.mouthOpenMs = isOpen ? ts - this.mouthOpenSince : 0;
  }

  /**
   * 点头判定：俯仰角速度超阈值，设不应期避免一次点头被计数多次。
   * 打盹时头部先缓慢下沉、随后猛然回抬，表现为 |dPitch/dt| 尖峰。
   */
  _updateNod(feat, ts) {
    const ev = CONFIG.event;
    if (!Number.isFinite(feat.pitchVel)) return;
    if (Math.abs(feat.pitchVel) >= ev.nodPitchVelDegPerSec && ts - this.lastNodTs >= ev.nodRefractoryMs) {
      this.lastNodTs = ts;
      this.nodWin.push(ts, Math.abs(feat.pitchVel));
      this._push('nod', ts, {
        level: 'warn',
        pitchVel: feat.pitchVel,
        message: `点头动作 ${Math.abs(feat.pitchVel).toFixed(0)}°/s`,
      });
    }
  }

  /** 头部偏离：相对标定零点的角度超阈值并持续一段时间 → 分心 */
  _updateHeadDeviation(feat, calib, ts, dt) {
    const ev = CONFIG.event;
    const dPitch = Math.abs((Number.isFinite(feat.pitch) ? feat.pitch : calib.pitch0) - calib.pitch0);
    const dYaw = Math.abs((Number.isFinite(feat.yaw) ? feat.yaw : calib.yaw0) - calib.yaw0);
    const deviating = dPitch > ev.headDeviationDeg || dYaw > ev.headDeviationDeg;

    if (deviating) this.deviationAccumMs += dt;

    if (deviating && !this.headDeviating) {
      this.headDeviating = true;
      this.headDeviateSince = ts;
      this._distractionReported = false;
    } else if (!deviating && this.headDeviating) {
      this.headDeviating = false;
    } else if (deviating && this.headDeviating && !this._distractionReported) {
      if (ts - this.headDeviateSince >= ev.distractionMinMs) {
        this._distractionReported = true;
        this._push('distraction', ts, {
          level: 'warn',
          pitch: dPitch,
          yaw: dYaw,
          message: `头部偏离正前方 ${((ts - this.headDeviateSince) / 1000).toFixed(1)}s`,
        });
      }
    }
    this.headDeviateMs = this.headDeviating ? ts - this.headDeviateSince : 0;
  }

  /** 汇总当前所有指标 */
  _snapshot(ts, feat, calib, facePresent, dataValid = true) {
    const observed = this.observeAccumMs;
    const w = CONFIG.window;

    // PERCLOS 就绪门控：累计有效观测时长与样本数都达标后才参与判定
    const perclosObservedMs = this.perclosWin.observedMs(ts);
    const perclosSamples = this.perclosWin.sampleCount;
    const perclosReady =
      perclosObservedMs >= w.perclosMinObservationSec * 1000 && perclosSamples >= w.perclosMinSamples;
    const perclos = this.perclosWin.ratio(ts);

    // 窗口内最长单次闭眼时长（含当前正在进行的闭眼）
    const windowStart = ts - w.perclosSec * 1000;
    let maxClosure = 0;
    for (const h of this.closureHistory) {
      const start = Math.max(h.ts - h.dur, windowStart);
      const effective = Math.max(0, h.ts - start);
      if (effective > maxClosure) maxClosure = effective;
    }
    if (this.currentClosureMs > maxClosure) maxClosure = this.currentClosureMs;

    const blinkRate = this.blinkWin.ratePerMinute(ts, observed);
    const yawnRate = this.yawnWin.ratePerMinute(ts, observed);
    const nodRate = this.nodWin.ratePerMinute(ts, observed);
    const avgBlinkMs = this.blinkWin.meanPayload(ts);
    const headDevRatio = observed > 0 ? clamp(this.deviationAccumMs / observed, 0, 1) : 0;
    // 丢失占比 = 累计丢失 / (有效观测 + 累计丢失)
    const lostDenom = this.faceLostAccumMs + observed;
    const faceLostRatio = lostDenom > 0 ? clamp(this.faceLostAccumMs / lostDenom, 0, 1) : 0;

    return {
      ts,
      facePresent,
      dataValid,
      quality: this.quality,
      lighting: this.lighting,
      qualityBadMs: this.qualityBadSince === null ? 0 : ts - this.qualityBadSince,
      observedMs: observed,
      sessionMs: this.startTs === null ? 0 : ts - this.startTs,
      faceLostMs: this.faceLostSince === null ? 0 : Math.max(0, ts - this.faceLostSince),

      closure: this.closureWin.latest() ? this.closureWin.latest().v : 0,
      eyeState: this.eyeState,
      currentClosureMs: this.currentClosureMs,

      perclos,
      perclosReady,
      perclosObservedMs,
      perclosSamples,
      maxClosureMs: maxClosure,
      blinkRate,
      avgBlinkMs,
      yawnRate,
      nodRate,
      headDevRatio,
      faceLostRatio,

      mouthOpenMs: this.mouthOpenMs || 0,
      headDeviateMs: this.headDeviateMs || 0,

      counts: {
        blink: this.blinkWin.count(ts),
        yawn: this.yawnWin.count(ts),
        nod: this.nodWin.count(ts),
      },
      totals: this._totals(),
    };
  }

  _totals() {
    const t = {
      blink: 0, microsleep: 0, yawn: 0, nod: 0, distraction: 0,
      criticalClosure: 0, faceLost: 0, qualityLow: 0,
    };
    for (const e of this.events) {
      if (e.type === 'blink') t.blink++;
      else if (e.type === 'microsleep') t.microsleep++;
      else if (e.type === 'yawn') t.yawn++;
      else if (e.type === 'nod') t.nod++;
      else if (e.type === 'distraction') t.distraction++;
      else if (e.type === 'critical_closure') t.criticalClosure++;
      else if (e.type === 'face_lost') t.faceLost++;
      else if (e.type === 'quality_low') t.qualityLow++;
    }
    return t;
  }

  /** 波形数据（供图表绘制） */
  waveforms() {
    return {
      ear: this.earWin.toArray(),
      mar: this.marWin.toArray(),
      score: this.scoreWin.toArray(),
    };
  }

  pushScore(ts, score) {
    this.scoreWin.push(ts, score);
  }
}
