/**
 * indicators.js — 指标层：把逐帧特征聚合为具有生理意义的疲劳指标
 *
 * 特征（EAR/MAR/角度）是瞬时量，不能直接判定疲劳；
 * 真正与嗜睡程度相关的是它们在时间维度上的统计量：
 *
 *   PERCLOS(P80)      单位时间内眼睛闭合程度超过 80% 的时间占比  ← 最核心
 *   最长持续闭眼时长   微睡眠（microsleep）的直接证据
 *   眨眼频率 / 时长    疲劳早期频率升高，深度疲劳时变慢变长
 *   哈欠频率          需与"说话"区分：靠持续时长 + 张口幅度联合判定
 *   点头频率          打盹时头部下沉再猛抬，表现为俯仰角速度尖峰
 *   头部/视线偏离占比  分心与注意力涣散
 */

import { CONFIG } from '../config.js';
import { TimeWindow, EventWindow, TimeWeightedWindow } from '../util/ring-buffer.js';
import { clamp } from '../util/math.js';

/** 眼睛状态机 */
const EyeState = { OPEN: 'open', CLOSED: 'closed' };

export class IndicatorEngine {
  constructor() {
    const w = CONFIG.window;
    /**
     * PERCLOS 主统计窗口：按真实时间加权（详见 TimeWeightedWindow 的说明）。
     * 判据为 P80，即闭合度 ≥ 0.8 的时间占比。
     */
    this.perclosWin = new TimeWeightedWindow(w.perclosSec * 1000, w.maxSampleGapMs);
    /** 闭合度序列（0=完全睜开, 1=完全闭合），仅用于波形显示 */
    this.closureWin = new TimeWindow(w.perclosSec * 1000, 40);
    /** EAR 原始序列，用于波形图 */
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
    this.closureHistory = []; // {ts, dur} 用于窗口内最长闭眼
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

    this.faceLostSince = null;
    this.faceLostAccumMs = 0;
    /** 是否已就本次丢失上报过事件（去抖用，见 update 里的说明） */
    this._faceLostReported = false;

    /** 数据质量状态 */
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

  /** 取出并清空自上次调用以来产生的新事件（供 UI 消费） */
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
   * @param {import('./features.js').FeatureSample} feat FeatureExtractor.extract 的结果
   * @param {import('./calibration.js').CalibrationResult|null} calib Calibrator.result
   * @param {{face:{valid:boolean,reasons:string[],label:string}|null, lighting:{valid:boolean,label:string}|null}|null} [quality]
   */
  update(feat, calib, quality = null) {
    const ts = feat.ts;
    if (this.startTs === null) this.startTs = ts;
    const dt = this.lastTs === null ? 0 : Math.max(0, Math.min(500, ts - this.lastTs));
    this.lastTs = ts;
    this.frames++;
    this.observeAccumMs += dt;

    const ev = CONFIG.event;

    /* ---------- 人脸丢失处理 ----------
     * 【为什么事件上报要去抖，内部状态却不能】
     * 头部侧转到检测器的能力边界时（实测约 ±45° 以上），关键点会逐帧
     * 时有时无。实测转头 6 秒期间产生了 8 组 face_lost / face_found，
     * 其中多对间隔不足 100ms —— 时间轴被刷满，报告里"没看到人脸"的
     * 次数也被虚增成 8 次，而实际只是一次持续的大角度侧转。
     *
     * 但内部状态必须在**第一个**丢帧就反应：冻结眼睛状态机、中断
     * PERCLOS 的时间累积、累计丢失时长。这些关系到"不要把丢失误算成闭眼"
     * 与"不要把中断期当作状态延续"，属于数据完整性，不能为了少写几条
     * 日志而延迟。所以这里只延迟**上报**，不延迟**处理**。 */
    if (!feat.ok) {
      this.faceLostAccumMs += dt;
      if (this.faceLostSince === null) this.faceLostSince = ts;
      if (!this._faceLostReported && ts - this.faceLostSince >= ev.faceLostReportMs) {
        this._faceLostReported = true;
        this._push('face_lost', ts, { level: 'info', message: '未检测到人脸' });
      }
      // 人脸丢失时冻结眼睛状态机，避免把"丢失"误算成"闭眼"
      if (this.eyeState === EyeState.CLOSED) this._closeEyeEpisode(ts, true);
      // 观测中断：丢弃未闭合的时间区间，绝不把丢失期间当作状态延续
      this.perclosWin.interrupt();
      // dataValid 显式置 false：没有人脸就谈不上"数据有效"。
      // 之前这里走默认值 true，导出的 CSV 里人脸丢失的行会标成有效数据，
      // 拿去做统计的人会把这些行当成正常观测。
      return this._snapshot(ts, feat, calib, false, false);
    }
    if (this.faceLostSince !== null) {
      // 只有真的报过"丢失"才配一条"恢复"，避免出现没头没尾的恢复事件
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

    /* ---------- 数据质量门控 ----------
     * 质量不合格时，关键点精度不足以支撑 PERCLOS 统计。
     * 此时同样按"观测中断"处理：不累计时间，也不参与疲劳判定，
     * 由 UI 明确显示"数据质量不足"，而不是给出一个不可信的正常结论。 */
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

    /* ---------- 眼睛闭合度（几何 + 语义双通道融合） ---------- */
    const closure = this._closureDegree(feat, calib);
    this.closureWin.push(ts, closure);
    // 按真实时间加权累计闭眼占比（P80 判据）
    this.perclosWin.push(ts, closure >= 0.8);
    this.earWin.push(ts, Number.isFinite(feat.ear) ? feat.ear : 0);
    this.marWin.push(ts, Number.isFinite(feat.mar) ? feat.mar : 0);

    /* ---------- 眼睛状态机（带滞回 + 语义否决） ---------- */
    // 闭合度 > 0.8 视为"闭"（对应 PERCLOS 的 P80 定义）；< 0.6 视为"开"。
    const CLOSE_ON = 0.80;
    const CLOSE_OFF = 0.60;

    /**
     * 【语义否决：为什么必须有这一条】
     *
     * 真人实测抓到一个纯逻辑缺陷：闭眼状态一旦进入，在头部后仰时**出不来**。
     *
     * 机理：几何通道 geo = (EAR_open − EAR)/(EAR_open − EAR_close) 在 EAR 跌破
     * 闭眼线后就饱和为 1。融合式 closure = 0.6·geo + 0.4·sem 的下界因此是 0.60，
     * 而退出条件是 closure ≤ 0.60 —— 数学上刚好不可达。于是只要头一直仰着
     * （投影缩短把 EAR 压在闭眼线以下），状态机就永久停在"闭眼"。
     *
     * 实测记录（单被试，EAR_open=0.2521 / EAR_close=0.1815 / 语义基线=0.249）：
     *   仰头 > +5° 时 60 帧里 56 帧 EAR 低于闭眼线（低头 −37° 时是 0/53，
     *   即低头完全不受影响，只有仰头会）。
     *   一次 ~300ms 的正常眨眼在头仰到 +23° 后被拉成 3.9 秒「持续闭眼」，
     *   触发重度报警；期间语义通道从 0.745 一路回落到 0.296（≈睁眼水平），
     *   全程都在说眼睛是开的，但在原式里它的权重不足以把总分压到 0.60 以下。
     *
     * 判据：真实的持续闭眼会让 blendshape 的 eyeBlink 系数**保持**高位；
     * 姿态造成的假闭眼则会看到它回落。因此当语义通道明确表示"睁着"时，
     * 直接结束闭眼片段，不管几何通道说什么。
     *
     * 注意这是单向否决：只用来提前结束闭眼，不用来阻止进入。
     * 进入仍由几何主导——几何更灵敏，漏掉闭眼的**开始**代价更高。
     */
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

    // 持续闭眼达到危险时长 → 立即上报（安全优先，不等状态机结束）
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

    /* ---------- 哈欠检测 ---------- */
    this._updateYawn(feat, calib, ts);

    /* ---------- 点头检测 ---------- */
    this._updateNod(feat, ts);

    /* ---------- 头部偏离 / 分心 ---------- */
    this._updateHeadDeviation(feat, calib, ts, dt);

    return this._snapshot(ts, feat, calib, true);
  }

  /**
   * 闭合度归一化：把 EAR 映射到 [0,1]（0=完全睜开，1=完全闭合），
   * 再与语义通道 eyeBlink 系数线性融合。
   *
   * 几何通道： closure_geo = (EAR_open − EAR) / (EAR_open − EAR_close)
   *   其中 EAR_open 为个体睁眼基线，EAR_close 为闭眼阈值。
   * 语义通道： closure_sem = eyeBlink 系数（模型直接回归，去个体基线偏移）
   *
   * 融合规则： closure = 0.6·geo + 0.4·sem
   *
   * ┌──────────────────────────────────────────────────────────────┐
   * │ 为什么去掉了原来的 max(geo, sem) 偏置项                       │
   * └──────────────────────────────────────────────────────────────┘
   * 原式为 0.7·(0.6geo + 0.4sem) + 0.3·max(geo, sem)，理由是"漏报代价高于
   * 误报，倾向判更闭"。真人实测（单被试，标定后 EAR_open=0.2533、
   * EAR_close=0.1824）发现它带来了严重的姿态假阳性：
   *
   *   · 抬头约 9° → EAR 均值从 0.238 掉到 0.197，几乎压在闭眼线上；
   *   · 连续点头 85 秒 → 记录到 10 次 0.5~1.6s「长闭眼」并触发 6 次报警，
   *     而被试全程没有闭眼超过半秒。
   *
   * 根因是：EAR 一旦跌破闭眼线，geo 就饱和为 1，在这个区间内它对
   * 「真闭眼 vs 姿态导致的投影缩短」完全没有区分能力。原式里
   * 0.6·geo + 0.3·max ≥ 0.9 已经几乎独占阈值 0.8，语义通道只要
   * sem ≥ 0.286 就会被判为闭眼——等于形同虚设。
   *
   * 实测两类事件的语义通道值分离得很干净：
   *   真闭眼（含刻意闭眼与点头时的真实闭眼）  sem 0.613 ~ 0.753
   *   姿态假阳性                              sem 0.241 ~ 0.427
   * 改用 0.6geo + 0.4sem 后，触发闭眼需要 sem ≥ 0.50，正落在空档中间，
   * 两侧各留约 0.1 的余量。
   *
   * 原式的另一个理由「大角度侧脸时几何不可靠，需要 sem 主导」并未丢失：
   * 侧转超限的帧已由数据质量门控（quality.js）判为无效、不参与统计，
   * 因此这里不必再为那种情形加偏置。
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
    // 单通道可用时只能靠它，此时无法交叉验证（blendshape 关闭或关键点缺失）
    if (!Number.isFinite(geo)) return sem;
    if (!Number.isFinite(sem)) return geo;
    return clamp(0.6 * geo + 0.4 * sem, 0, 1);
  }

  /**
   * 语义通道闭合度：blendshape 的 eyeBlink 系数，去个体基线偏移后归一化到 [0,1]。
   * 单独抽成方法，是因为眼睛状态机的「语义否决」也要用同一个量，
   * 两处若各算一遍、口径不同就会出现互相矛盾的判断。
   */
  _semClosure(feat, calib) {
    if (!Number.isFinite(feat.blinkScore)) return NaN;
    // eyeBlink 在完全闭眼时接近 1，睁眼时接近 0（含个体基线偏移，做去偏）
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
    // 只保留 PERCLOS 窗口内的记录
    const cutoff = ts - CONFIG.window.perclosSec * 1000;
    while (this.closureHistory.length && this.closureHistory[0].ts < cutoff) this.closureHistory.shift();

    if (dur >= ev.blinkMinMs && dur <= ev.blinkMaxMs) {
      this.blinkWin.push(ts, dur);
      this.lastBlinkDurations.push(dur);
      if (this.lastBlinkDurations.length > 60) this.lastBlinkDurations.shift();
      this._push('blink', ts, { level: 'info', durationMs: dur });
    } else if (dur > ev.microsleepMs) {
      /**
       * 超过 500ms 的闭合不再算眨眼，而是"长闭眼/微睡眠"，
       * 并且**不能**推进 blinkWin。原因有两条，都是实测踩出来的：
       *
       * ① 污染平均眨眼时长：blinkWin 同时供 blinkRate 与 avgBlinkMs 使用，
       *    一次 4.4s 的闭眼混进去会把"平均眨眼时长"抬到 741ms
       *    （同期真实眨眼只有 166~375ms），blinkDur 隶属度直接饱和。
       *    而这次长闭眼已经被 PERCLOS(0.30) 与最长闭眼(0.20) 计过分了，
       *    再走 blinkDur(0.08) 属于同一事件重复计分。
       *
       * ② 掩盖眨眼频率的下降：嗜睡的典型表现是眨眼变少、单次变长。
       *    把微睡眠计入眨眼次数会把下降趋势填平，
       *    偏偏是在最需要这个信号的深度嗜睡阶段失效。
       *
       * 文献对 blink 的定义本身也限于短时闭合，长闭合另行归类为 microsleep。
       * 长闭眼的频次与时长由 closureHistory / totals.microsleep 单独记录，信息没有丢。
       */
      this._push('microsleep', ts, {
        level: dur >= ev.criticalClosureMs ? 'danger' : 'warn',
        durationMs: dur,
        message: `长时闭眼 ${(dur / 1000).toFixed(2)}s`,
      });
    }
  }

  /**
   * 哈欠判定：MAR 超阈值 **且** 持续 ≥1.2s。
   * 说话时 MAR 高频振荡、单次张口时长短，因此持续时长是区分哈欠与说话的关键。
   * 同时结合 jawOpen 语义系数交叉验证，降低"大声说话"造成的误报。
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
   * 点头判定：俯仰角速度超过阈值。
   * 打盹时头部先缓慢下沉、随后因肌肉惊醒而猛然回抬，
   * 表现为 |dPitch/dt| 的尖峰。设置不应期避免一次点头被计数多次。
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

    /* ---------- PERCLOS（按真实时间加权，P80 判据） ----------
     * 就绪门控：累计有效观测时长与样本数都达标后才允许参与疲劳判定。
     * 未就绪时对外报告 perclosReady=false，由融合层把该项贡献置 0，
     * UI 显示"采样中"——避免开局分母过小导致的虚警。 */
    const perclosObservedMs = this.perclosWin.observedMs(ts);
    const perclosSamples = this.perclosWin.sampleCount;
    const perclosReady =
      perclosObservedMs >= w.perclosMinObservationSec * 1000 && perclosSamples >= w.perclosMinSamples;
    const perclos = this.perclosWin.ratio(ts);

    /* 窗口内最长单次闭眼时长（含当前正在进行的闭眼）。
     * 跨窗口边界的闭眼片段只计入落在窗口内的那一部分，
     * 否则一次已经滑出窗口大半的长闭眼会长期虚高这个指标。 */
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
    const faceLostRatio = observed > 0 ? clamp(this.faceLostAccumMs / observed, 0, 1) : 0;

    return {
      ts,
      facePresent,
      dataValid,
      quality: this.quality,
      lighting: this.lighting,
      qualityBadMs: this.qualityBadSince === null ? 0 : ts - this.qualityBadSince,
      observedMs: observed,
      sessionMs: this.startTs === null ? 0 : ts - this.startTs,

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
