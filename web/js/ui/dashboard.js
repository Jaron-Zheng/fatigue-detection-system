/**
 * dashboard.js — 仪表盘刷新
 *
 * 性能约束：主循环 20~30Hz，若每帧无条件重写全部 DOM，
 * 低配机器上会出现明显掉帧。因此：
 *   · 数值写入统一走 setText / setStyle（值未变化则跳过写 DOM）；
 *   · 高频文本（HUD）与低频文本（指标卡）分别按 ~15Hz / ~6Hz 节流；
 *   · 环形仪表用 stroke-dashoffset 变换，由合成器处理，不触发重排。
 */

import { setText, setStyle, setAttr, el, clear } from '../util/dom.js';
import { fmt, fmtDuration, clamp } from '../util/math.js';
import { INDICATOR_META } from '../core/fusion.js';
import { CONFIG } from '../config.js';

const GAUGE_CIRC = 2 * Math.PI * 50; // r=50
const LEVEL_COLOR = {
  awake: 'var(--lv-awake)',
  mild: 'var(--lv-mild)',
  moderate: 'var(--lv-moderate)',
  severe: 'var(--lv-severe)',
};

/**
 * 展示层方向阈值：仅用于指标卡 sub 文案与迷你条颜色，不参与算法判定。
 * 与各卡 sub 文案中的区间同源（改文案里的区间数字时必须同步改这里）：
 *   「正常区间 12–22」 → BLINK_RATE_LOW / BLINK_RATE_HIGH
 *   「清醒约 100–200」 → BLINK_DUR_MAX_MS
 */
const BLINK_RATE_LOW = 12;
const BLINK_RATE_HIGH = 22;
const BLINK_DUR_MAX_MS = 200;

/** 迷你条填充色跟随卡片状态色条（与左侧色条双重编码，色盲友好） */
const SPARK_COLOR = {
  normal: 'var(--accent)',
  caution: 'var(--caution)',
  danger: 'var(--danger)',
};

export class Dashboard {
  constructor() {
    this.q = {};
    this.lastHud = 0;
    this.lastMetric = 0;
    this.contribRows = null;
    this._bind();
  }

  _bind() {
    const ids = [
      'navDot', 'navStatusText',
      'hudEar', 'hudMar', 'hudClosure', 'hudPitch', 'hudYaw', 'hudRoll', 'hud',
      'stageDot', 'stageLevel', 'stageFps', 'stageFaceText', 'stagePill',
      'stageQuality', 'stageQualityText',
      'gaugeBar', 'gaugeNum', 'levelChip', 'levelText', 'scoreReason',
      'metaDuration', 'metaPeak', 'metaAvg',
      'vPerclos', 'sPerclos', 'kPerclos', 'mPerclos',
      'vClosure', 'sClosure', 'kClosure', 'mClosure',
      'vBlink', 'sBlink', 'kBlink', 'mBlink',
      'vBlinkDur', 'sBlinkDur', 'kBlinkDur', 'mBlinkDur',
      'vYawn', 'sYawn', 'kYawn', 'mYawn',
      'vNod', 'sNod', 'kNod', 'mNod',
      'vHeadDev', 'sHeadDev', 'kHeadDev', 'mHeadDev',
      'vMicro', 'sMicro', 'kMicro', 'mMicro',
      'contribList', 'fusionSum',
      'calibQuality', 'cbEarBase', 'cbEarClose', 'cbMarOpen', 'cbPose', 'cbInfer',
    ];
    for (const id of ids) this.q[id] = document.getElementById(id);
  }

  /** 顶部导航状态 */
  setStatus(text, color = 'var(--text-quaternary)', pulse = false) {
    setText(this.q.navStatusText, text);
    if (this.q.navDot) {
      setStyle(this.q.navDot, 'background', color);
      this.q.navDot.classList.toggle('dot-pulse', pulse);
    }
  }

  /** 高频：视频上的数值浮层 */
  updateHud(feat, ind, fps, now) {
    if (now - this.lastHud < 66) return; // ~15Hz
    this.lastHud = now;
    const q = this.q;
    setText(q.hudEar, fmt(feat && feat.ear, 3));
    setText(q.hudMar, fmt(feat && feat.mar, 3));
    setText(q.hudClosure, ind ? fmt(ind.closure * 100, 0) + '%' : '--');
    setText(q.hudPitch, feat && Number.isFinite(feat.pitch) ? fmt(feat.pitch, 1) + '°' : '--');
    setText(q.hudYaw, feat && Number.isFinite(feat.yaw) ? fmt(feat.yaw, 1) + '°' : '--');
    setText(q.hudRoll, feat && Number.isFinite(feat.roll) ? fmt(feat.roll, 1) + '°' : '--');
    setText(q.stageFps, Number.isFinite(fps) ? `${fps.toFixed(0)} FPS` : '-- FPS');
  }

  setFaceState(present, lostMs = 0) {
    const q = this.q;
    if (present) {
      setText(q.stageFaceText, '人脸已锁定');
      setStyle(q.stageFaceText, 'color', '#30d158');
    } else {
      setText(q.stageFaceText, lostMs > 1500 ? '未检测到人脸' : '搜索人脸…');
      setStyle(q.stageFaceText, 'color', '#ff9f0a');
    }
  }

  /**
   * 数据质量与光照提示。
   * 质量不合格时如实显示原因，而不是让系统悄悄给出不可信的结论。
   */
  setQualityState(ind) {
    const pill = this.q.stageQuality;
    const txt = this.q.stageQualityText;
    if (!pill || !txt) return;

    const quality = ind.quality || { valid: true, reasons: [] };
    const lighting = ind.lighting || { valid: true, label: '' };
    let msg = null;
    let color = '#ff9f0a';

    // 没有人脸时整条胶囊都不显示：此刻的 quality 是丢失前的旧值，
    // 拿它提示「侧转过大」之类的原因会指向一个已经不成立的问题；
    // 真正的原因由旁边的人脸状态胶囊负责说。
    if (ind.facePresent === false) {
      if (!pill.hidden) {
        pill.hidden = true;
        setText(txt, '');
      }
      return;
    }

    if (ind.dataValid === false && quality.reasons && quality.reasons.length) {
      msg = quality.reasons[0];
      color = '#ff453a';
    } else if (!lighting.valid && lighting.label) {
      msg = lighting.label;
    } else if (ind.perclosReady === false && ind.facePresent) {
      // 只在真的看到人脸时才提示"正在积累数据"。
      // 没有人脸时观测时长根本不会推进，显示"正在积累数据 0s"会让人
      // 误以为在正常预热，而实际原因是画面里没人——那件事由人脸状态胶囊负责说。
      const sec = (ind.perclosObservedMs || 0) / 1000;
      msg = `正在积累数据 ${sec.toFixed(0)}s`;
      color = '#64d2ff';
    }

    if (msg) {
      pill.hidden = false;
      setText(txt, msg);
      setStyle(txt, 'color', color);
    } else if (!pill.hidden) {
      pill.hidden = true;
      // 清空文本，避免下次显示前旧内容一闪而过
      setText(txt, '');
    }
  }

  /**
   * 疲劳总览（环形仪表 + 等级 + 理由）。
   *
   * fusion.unreliable 时（人脸丢失、画面不合格）不显示分数与等级。
   * 之前的实现会在这种情况下照常显示"10 分 · 清醒"，
   * 同时下面的理由写着"无法评估疲劳状态"——两者互相矛盾，
   * 而用户只会记住那个看起来很安全的数字。测不准就该显示测不准。
   */
  updateScore(fusion, ind, reason) {
    const q = this.q;
    const blind = fusion.unreliable === true;
    const score = fusion.score;
    const color = blind ? 'var(--text-quaternary)' : LEVEL_COLOR[fusion.level];

    setText(q.gaugeNum, blind ? '--' : Math.round(score));
    const shown = blind ? 0 : clamp(score / 100, 0, 1);
    setStyle(q.gaugeBar, 'stroke-dashoffset', (GAUGE_CIRC * (1 - shown)).toFixed(2));
    setStyle(q.gaugeBar, 'stroke', color);

    setAttr(q.levelChip, 'data-level', blind ? 'unknown' : fusion.level);
    setText(q.levelText, blind ? '无法评估' : fusion.levelLabel);
    setText(q.scoreReason, reason);

    setAttr(q.stagePill, 'data-level', blind ? 'unknown' : fusion.level);
    setText(q.stageLevel, blind ? '无法评估' : fusion.levelLabel);
    setStyle(q.stageDot, 'background', color);

    const noData = !fusion.scoreCount;
    setText(q.metaDuration, fmtDuration(ind.sessionMs));
    setText(q.metaPeak, noData ? '--' : Math.round(fusion.peakScore));
    // 均值保留一位小数，与报告页口径一致
    setText(q.metaAvg, noData ? '--' : fusion.avgScore.toFixed(1));
  }

  /** 指标卡（约 6Hz 刷新足够，人眼看不出差别，却能省下大量 DOM 写入） */
  updateMetrics(ind, fusion, now) {
    if (now - this.lastMetric < 160) return;
    this.lastMetric = now;
    const q = this.q;
    const mu = fusion.memberships;

    // PERCLOS
    setText(q.vPerclos, (ind.perclos * 100).toFixed(1));
    const stPerclos = this._state(q.mPerclos, ind.perclos, 0.15, 0.30);
    setText(q.sPerclos, this._withHigh(stPerclos, `最近 ${CONFIG.window.perclosSec} 秒`));
    this._spark(q.kPerclos, mu.perclos, stPerclos);

    // 当前闭眼
    const closed = ind.eyeState === 'closed';
    setText(q.vClosure, (ind.currentClosureMs / 1000).toFixed(2));
    setText(q.sClosure, closed ? '闭眼中' : `最长 ${(ind.maxClosureMs / 1000).toFixed(2)}s`);
    this._spark(q.kClosure, mu.closureDur, this._state(q.mClosure, ind.currentClosureMs, 500, CONFIG.event.criticalClosureMs));

    // 眨眼频率（反向指标：过低与过高都危险，方向词区分两种偏离）
    setText(q.vBlink, ind.blinkRate.toFixed(1));
    let blinkSub;
    if (ind.observedMs < 15000) blinkSub = '统计中…';
    else if (ind.blinkRate < BLINK_RATE_LOW) blinkSub = '低于正常区间 ↑ 危险';
    else if (ind.blinkRate > BLINK_RATE_HIGH) blinkSub = '高于正常区间（疲劳早期代偿）';
    else blinkSub = `正常区间 ${BLINK_RATE_LOW}–${BLINK_RATE_HIGH}`;
    setText(q.sBlink, blinkSub);
    this._spark(q.kBlink, mu.blinkRate, this._stateByMu(q.mBlink, mu.blinkRate));

    // 平均眨眼时长（反向指标：疲劳时单次变长）
    setText(q.vBlinkDur, Number.isFinite(ind.avgBlinkMs) ? ind.avgBlinkMs.toFixed(0) : '--');
    setText(
      q.sBlinkDur,
      Number.isFinite(ind.avgBlinkMs) && ind.avgBlinkMs > BLINK_DUR_MAX_MS
        ? '偏长 ↑ 危险'
        : `清醒约 100–${BLINK_DUR_MAX_MS}`
    );
    this._spark(q.kBlinkDur, mu.blinkDur, this._stateByMu(q.mBlinkDur, mu.blinkDur));

    // 哈欠
    setText(q.vYawn, ind.totals.yawn);
    const stYawn = this._stateByMu(q.mYawn, mu.yawn);
    setText(q.sYawn, this._withHigh(stYawn, `${ind.yawnRate.toFixed(1)} 次/分`));
    this._spark(q.kYawn, mu.yawn, stYawn);

    // 点头
    setText(q.vNod, ind.totals.nod);
    const stNod = this._stateByMu(q.mNod, mu.nod);
    setText(q.sNod, this._withHigh(stNod, `${ind.nodRate.toFixed(1)} 次/分`));
    this._spark(q.kNod, mu.nod, stNod);

    // 视线偏离
    setText(q.vHeadDev, (ind.headDevRatio * 100).toFixed(1));
    const stHeadDev = this._stateByMu(q.mHeadDev, mu.headDev);
    setText(
      q.sHeadDev,
      this._withHigh(stHeadDev, ind.headDeviateMs > 0 ? `已偏离 ${(ind.headDeviateMs / 1000).toFixed(1)}s` : '头部朝向前方')
    );
    this._spark(q.kHeadDev, mu.headDev, stHeadDev);

    // 长时闭眼
    const micro = ind.totals.microsleep + ind.totals.criticalClosure;
    setText(q.vMicro, micro);
    const stMicro = this._state(q.mMicro, micro, 1, 3);
    setText(
      q.sMicro,
      this._withHigh(
        stMicro,
        ind.totals.criticalClosure > 0 ? `其中 ${ind.totals.criticalClosure} 次很危险` : '超过 0.5 秒算一次'
      )
    );
    this._spark(q.kMicro, clamp(micro / 5, 0, 1), stMicro);

    this._updateContrib(fusion);
  }

  /**
   * 迷你条：宽度表示当前值相对预警阈值的位置，
   * 填充色与左侧状态色条同色（色盲友好的双重编码）。
   * @param {HTMLElement} node spark 的 <i> 元素
   * @param {number} mu 隶属度 0~1
   * @param {string} state 卡片状态（normal/caution/danger），由 _state/_stateByMu 给出
   */
  _spark(node, mu, state = 'normal') {
    if (!node) return;
    const pct = clamp((mu || 0) * 100, 0, 100);
    setStyle(node, 'width', pct.toFixed(1) + '%');
    setStyle(node, 'background', SPARK_COLOR[state] || SPARK_COLOR.normal);
    setAttr(node, 'title', `当前值相对预警阈值的位置：${pct.toFixed(0)}%`);
  }

  /** 正向指标超阈时在 sub 文案追加方向词，与色条同源 */
  _withHigh(state, base) {
    return state === 'normal' ? base : `${base} · ↑ 偏高`;
  }

  _state(node, v, warnAt, dangerAt) {
    if (!node) return 'normal';
    const s = v >= dangerAt ? 'danger' : v >= warnAt ? 'caution' : 'normal';
    setAttr(node, 'data-state', s);
    return s;
  }

  _stateByMu(node, mu) {
    if (!node) return 'normal';
    const s = mu > 0.66 ? 'danger' : mu > 0.33 ? 'caution' : 'normal';
    setAttr(node, 'data-state', s);
    return s;
  }

  /** 融合贡献度明细：首次建行，之后只更新宽度与数字 */
  _updateContrib(fusion) {
    const host = this.q.contribList;
    if (!host) return;
    const keys = Object.keys(INDICATOR_META);

    if (!this.contribRows) {
      clear(host);
      this.contribRows = {};
      for (const k of keys) {
        const meta = INDICATOR_META[k];
        const fill = el('div.contrib-fill', { style: { width: '0%' } });
        const val = el('div.contrib-val', { text: '0.0' });
        const row = el('div.contrib', { title: meta.desc }, [
          el('div.contrib-name', { text: meta.label }),
          el('div.contrib-track', {}, [fill]),
          val,
        ]);
        host.appendChild(row);
        this.contribRows[k] = { fill, val };
      }
    }

    let sum = 0;
    for (const k of keys) {
      const c = fusion.contributions[k];
      if (!c) continue;
      const row = this.contribRows[k];
      const maxPoints = c.weight * 100; // 该项满贡献时的分值
      const pct = maxPoints > 0 ? clamp((c.points / maxPoints) * 100, 0, 100) : 0;
      setStyle(row.fill, 'width', pct.toFixed(1) + '%');
      setText(row.val, `${c.points.toFixed(1)} / ${maxPoints.toFixed(0)}`);
      sum += c.points;
    }
    setText(this.q.fusionSum, `合计 ${sum.toFixed(1)} 分`);
  }

  /** 标定结果表 */
  updateCalibration(calib, engine) {
    const q = this.q;
    if (!calib) return;
    const badge = q.calibQuality;
    if (badge) {
      const label = calib.skipped ? '未测个人基准' : `校准质量 ${calib.qualityLabel}`;
      setText(badge, label);
      badge.className = 'badge ' + (calib.skipped ? 'badge-warn' : calib.quality > 0.5 ? 'badge-ok' : 'badge-warn');
    }
    setText(q.cbEarBase, fmt(calib.earBaseline, 4));
    setText(q.cbEarClose, fmt(calib.earCloseThresh, 4));
    setText(q.cbMarOpen, fmt(calib.marOpenThresh, 3));
    setText(q.cbPose, `${fmt(calib.pitch0, 1)}° / ${fmt(calib.yaw0, 1)}° / ${fmt(calib.roll0, 1)}°`);
    if (engine) setText(q.cbInfer, `${engine.avgMs.toFixed(1)} ms · ${engine.delegate}`);
  }

  updateEngineInfo(engine) {
    if (engine) setText(this.q.cbInfer, `${engine.avgMs.toFixed(1)} ms · ${engine.delegate}`);
  }
}
