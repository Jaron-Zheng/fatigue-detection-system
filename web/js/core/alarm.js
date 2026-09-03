/**
 * alarm.js — 分级声光报警
 *
 * 设计取舍：
 * 1. 不引入任何音频素材文件，用 Web Audio API 实时合成蜂鸣音。
 *    好处是零资源依赖（离线可用）、音量/音调/节奏可按等级动态调节。
 * 2. 采用「等级驱动 + 冷却时间」策略：等级越高，提示越急促、冷却越短。
 *    避免持续疲劳时报警声连成一片，反而干扰驾驶。
 * 3. 语音播报走浏览器 SpeechSynthesis，同样零依赖。
 * 4. AudioContext 必须在用户手势后创建/恢复（浏览器自动播放策略），
 *    因此在"开始检测"按钮里显式 resume。
 */

import { CONFIG } from '../config.js';

export class AlarmSystem {
  constructor() {
    this.ctx = null;
    this.masterGain = null;
    this.lastFireAt = { awake: 0, mild: 0, moderate: 0, severe: 0 };
    this.lastLevel = 'awake';
    this.enabled = true;
    this.muted = false;
    this.fireCount = 0;
    /** 各等级累计触发次数（B1：通知文案"第 N 次"用，不受 suppressed 影响） */
    this.fireCountByLevel = { mild: 0, moderate: 0, severe: 0 };
    /** 报警段追踪（B2）：第一次报警时刻 → 回落清醒时刻，用于恢复通知的持续时长 */
    this.activeSince = null;
    /** 首次回到清醒的时刻（恢复驻留计时起点，边沿置位） */
    this._awakeSince = null;
    /** 恢复通知回调（由 UI 注入）：参数 (durationMs, worstLevelThisSegment) */
    this.onRecovery = null;
    this.onVisualAlarm = null; // 由 UI 注入：触发视觉闪烁
    this._speakingUntil = 0;
  }

  /** 在用户手势中调用，解锁音频 */
  async unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || /** @type {any} */ (window).webkitAudioContext;
        if (!AC) return false;
        this.ctx = new AC();
        this.masterGain = this.ctx.createGain();
        this.masterGain.gain.value = 1;
        this.masterGain.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') {
        // 无用户手势时（如 CDP 自动化驱动），部分浏览器里 resume() 的
        // Promise 会永不 settle，会把 start() 永久卡死在 await 上。
        // 加 1.5s 超时保护：解锁失败只意味着无声，视觉报警不受影响。
        await Promise.race([
          this.ctx.resume(),
          new Promise((resolve) => setTimeout(resolve, 1500)),
        ]);
      }
      return this.ctx.state === 'running';
    } catch {
      return false;
    }
  }

  get audioReady() {
    return !!this.ctx && this.ctx.state === 'running';
  }

  setMuted(m) {
    this.muted = m;
    if (this.masterGain) this.masterGain.gain.value = m ? 0 : 1;
  }

  /**
   * 合成一次蜂鸣。用三角波 + 指数包络，听感比正弦更"警示"但不刺耳。
   */
  beep({ freq = 880, durMs = 180, gain = 0.25, delayMs = 0 } = {}) {
    if (!this.ctx || this.muted) return;
    const t0 = this.ctx.currentTime + delayMs / 1000;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t0);
    // 轻微上滑，增强"警报"感
    osc.frequency.linearRampToValueAtTime(freq * 1.06, t0 + durMs / 1000);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(t0);
    osc.stop(t0 + durMs / 1000 + 0.02);
  }

  /** 播放一组蜂鸣（按等级决定次数与间隔） */
  beepPattern(spec) {
    const gap = spec.times > 2 ? 150 : 220;
    for (let i = 0; i < spec.times; i++) {
      this.beep({ freq: spec.freq, gain: spec.gain, durMs: spec.times > 2 ? 130 : 180, delayMs: i * gap });
    }
  }

  speak(text) {
    if (!CONFIG.alarm.speechEnabled || this.muted || !text) return;
    if (!('speechSynthesis' in window)) return;
    const now = performance.now();
    if (now < this._speakingUntil) return; // 上一句还没说完，不叠加
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 1.05;
      u.pitch = 1.0;
      u.volume = 1.0;
      // 用 onend 精确追踪结束时间；fallback 用保守估算（280ms/字）
      this._speakingUntil = now + Math.max(2000, text.length * 280);
      u.onend = () => { this._speakingUntil = 0; };
      window.speechSynthesis.speak(u);
    } catch {
      /* 语音不可用则静默降级 */
    }
  }

  /**
   * 由主循环调用：根据当前等级决定是否报警。
   * @returns {object|null} 本次触发/恢复的报警事件（用于写入事件时间轴）
   *
   * B2 恢复闭环：报警触发后记录 activeSince；等级回落 awake 且驻留
   * 足够（回到清醒并保持 recoveryHoldMs）时发出 recovery 事件（写时间轴
   * + onRecovery 通知），一段疲劳的"发生→持续→恢复"全程可追溯。
   * 驻留门槛防抖：清醒判定本身有滞回，但等级在临界值附近仍可能单帧抖回，
   * 1.2s 保持才确认恢复（与分心判据 distractionMinMs 同量级）。
   */
  update(level, ts, reason = '') {
    const cfg = CONFIG.alarm;
    const levelChanged = level !== this.lastLevel;
    const prevLevel = this.lastLevel;
    this.lastLevel = level;
    // 首次回到清醒记时刻（B2 恢复驻留计时的起点，只在边沿置位）
    if (levelChanged && level === 'awake') this._awakeSince = ts;

    if (!cfg.enabled || !this.enabled) return null;
    if (level === 'awake') return this._maybeRecover(ts);

    const spec = cfg.byLevel[level];
    if (!spec) return null;

    const last = this.lastFireAt[level] || 0;
    // B3 双字段语义：
    //   escalated（宽）= 等级上行跨越（含从清醒进入疲劳）——绕过冷却立即
    //   报警的历史语义，awake→mild 是"新一段疲劳开始"，必须立即提醒；
    //   escalating（窄）= 疲劳等级之间的进一步上行（mild→moderate、
    //   moderate→severe）——只有这才配"疲劳在加重"文案，首次触发说
    //   "加重"是误导（之前没有任何疲劳）。
    const escalated = levelChanged && this._idx(level) > this._idx(prevLevel);
    const escalating = levelChanged && this._idx(prevLevel) >= 1 && this._idx(level) > this._idx(prevLevel);
    // 等级升高时立即报警；否则遵守该等级的冷却时间。
    // 冷却期内的重复事件不静默丢弃：返回带 suppressed 标记的记录供时间轴
    // 留痕（验收 TC-B5-02：抑制打扰不等于抹去痕迹，事后复盘能看到"冷却
    // 期内还发生过一次"），但不响铃、不弹提示、不增加报警计数。
    if (!escalated && ts - last < spec.cooldownMs) {
      const zh = level === 'severe' ? '重度' : level === 'moderate' ? '中度' : '轻度';
      return {
        type: 'alarm',
        level: level === 'severe' ? 'danger' : 'warn',
        alarmLevel: level,
        ts,
        escalated: false,
        suppressed: true,
        message: `${zh}疲劳重复事件（冷却期内，抑制提醒）${reason ? ' · ' + reason : ''}`,
      };
    }

    this.lastFireAt[level] = ts;
    this.fireCount++;
    this.fireCountByLevel[level] = (this.fireCountByLevel[level] || 0) + 1;
    if (this.activeSince == null) this.activeSince = ts;

    if (spec.beep) this.beepPattern(spec.beep);
    if (spec.speak) this.speak(spec.speak);
    if (cfg.flashEnabled && typeof this.onVisualAlarm === 'function') {
      this.onVisualAlarm(level);
    }

    return {
      type: 'alarm',
      level: level === 'severe' ? 'danger' : 'warn',
      alarmLevel: level,
      ts,
      escalated,
      /** B3 窄升级标志（疲劳等级间上行），通知文案"疲劳在加重"专用 */
      escalating,
      /** B1：本会话该等级第几次提醒（含本次），供通知文案与时间轴使用 */
      count: this.fireCountByLevel[level],
      message: `${level === 'severe' ? '重度' : level === 'moderate' ? '中度' : '轻度'}疲劳报警${reason ? ' · ' + reason : ''}`,
    };
  }

  /** B2：等级回落清醒且驻留超门槛 → 恢复事件。 */
  _maybeRecover(ts) {
    if (this.activeSince == null) return null;
    const RECOVERY_HOLD_MS = 1200;
    if (ts - this._awakeSince < RECOVERY_HOLD_MS) return null;
    const durationMs = this._awakeSince - this.activeSince;
    this.activeSince = null;
    this._awakeSince = null;
    if (durationMs < 500) return null; // 抖动残留段不足 0.5s，不值得打扰
    const ev = {
      type: 'recovery',
      level: 'ok',
      ts,
      durationMs,
      message: `状态已恢复清醒，本次疲劳段持续 ${Math.round(durationMs / 100) / 10} 秒`,
    };
    if (typeof this.onRecovery === 'function') this.onRecovery(ev);
    return ev;
  }

  _idx(level) {
    return ['awake', 'mild', 'moderate', 'severe'].indexOf(level);
  }

  /** 测试音（设置面板里的"试听"按钮） */
  test(level = 'moderate') {
    const spec = CONFIG.alarm.byLevel[level];
    if (spec && spec.beep) this.beepPattern(spec.beep);
  }

  reset() {
    this.lastFireAt = { awake: 0, mild: 0, moderate: 0, severe: 0 };
    this.lastLevel = 'awake';
    this.fireCount = 0;
    this.fireCountByLevel = { mild: 0, moderate: 0, severe: 0 };
    this.activeSince = null;
    this._awakeSince = null;
    this._speakingUntil = 0;
    try {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    } catch {
      /* noop */
    }
  }
}
