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
    this.onVisualAlarm = null; // 由 UI 注入：触发视觉闪烁
    this._speakingUntil = 0;
  }

  /** 在用户手势中调用，解锁音频 */
  async unlock() {
    try {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
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
   * @returns {object|null} 本次触发的报警信息（用于写入事件时间轴）
   */
  update(level, ts, reason = '') {
    const cfg = CONFIG.alarm;
    const levelChanged = level !== this.lastLevel;
    const prevLevel = this.lastLevel;
    this.lastLevel = level;

    if (!cfg.enabled || !this.enabled) return null;
    if (level === 'awake') return null;

    const spec = cfg.byLevel[level];
    if (!spec) return null;

    const last = this.lastFireAt[level] || 0;
    const escalated = levelChanged && this._idx(level) > this._idx(prevLevel);
    // 等级升高时立即报警；否则遵守该等级的冷却时间
    if (!escalated && ts - last < spec.cooldownMs) return null;

    this.lastFireAt[level] = ts;
    this.fireCount++;

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
      message: `${level === 'severe' ? '重度' : level === 'moderate' ? '中度' : '轻度'}疲劳报警${reason ? ' · ' + reason : ''}`,
    };
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
    this._speakingUntil = 0;
    try {
      if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    } catch {
      /* noop */
    }
  }
}
