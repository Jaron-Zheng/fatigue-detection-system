/**
 * alarm.js — 分级声光报警系统
 *
 * 用 Web Audio API 实时合成蜂鸣音（零音频文件依赖），配合 SpeechSynthesis
 * 做语音播报。按疲劳等级驱动不同强度与冷却间隔的报警。
 * AudioContext 必须在用户手势后创建/恢复（浏览器自动播放策略）。
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
    this.fireCountByLevel = { mild: 0, moderate: 0, severe: 0 };
    this.activeSince = null;
    this._awakeSince = null;
    this.onRecovery = null;
    this.onVisualAlarm = null;
    this._speakingUntil = 0;
    if ('speechSynthesis' in window && typeof speechSynthesis.addEventListener === 'function') {
      speechSynthesis.addEventListener('voiceschanged', () => {
        this._voice = undefined;
      });
    }
  }

  /** 在用户手势中调用，解锁 AudioContext */
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

  /** 合成一次蜂鸣：三角波 + 指数包络 */
  beep({ freq = 880, durMs = 180, gain = 0.25, delayMs = 0 } = {}) {
    if (!this.ctx || !this.masterGain || this.muted || !(gain > 0)) return;
    const t0 = this.ctx.currentTime + delayMs / 1000;
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, t0);
    osc.frequency.linearRampToValueAtTime(freq * 1.06, t0 + durMs / 1000);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + durMs / 1000);
    osc.connect(g);
    g.connect(this.masterGain);
    osc.start(t0);
    osc.stop(t0 + durMs / 1000 + 0.02);
  }

  /** 按等级播放一组蜂鸣 */
  beepPattern(spec) {
    const gap = spec.times > 2 ? 150 : 220;
    for (let i = 0; i < spec.times; i++) {
      this.beep({ freq: spec.freq, gain: spec.gain, durMs: spec.times > 2 ? 130 : 180, delayMs: i * gap });
    }
  }

  /**
   * 挑选自然度最高的中文语音。
   * 评分：Natural/Neural 线上神经语音优先，其次微软神经音色，再次 zh-CN 普通话。
   */
  _pickVoice() {
    if (this._voice === undefined) {
      const voices = window.speechSynthesis
        .getVoices()
        .filter((v) => /^zh/i.test(v.lang || ''));
      const score = (v) => {
        const n = (v.name || '').toLowerCase();
        let s = 0;
        if (/natural|neural/.test(n)) s += 100;
        else if (/xiaoxiao|yunxi|yunyang|晓晓|云希|云扬/.test(n)) s += 12;
        if (/^zh[-_]cn/i.test(v.lang || '')) s += 20;
        if (v.localService === false) s += 4;
        return s;
      };
      this._voice = voices.length
        ? voices.reduce((best, v) => (score(v) > score(best) ? v : best))
        : null;
    }
    return this._voice;
  }

  /** 语音播报，上一句未说完时不叠加 */
  speak(text) {
    if (!CONFIG.alarm.speechEnabled || this.muted || !text) return;
    if (!('speechSynthesis' in window)) return;
    const now = performance.now();
    if (now < this._speakingUntil) return;
    try {
      window.speechSynthesis.cancel();
      const u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      const v = this._pickVoice();
      if (v) u.voice = v;
      u.rate = v && v.localService === false ? 1.05 : 1.0;
      u.pitch = 1.0;
      u.volume = 1.0;
      this._speakingUntil = now + Math.max(2000, text.length * 280);
      u.onend = () => { this._speakingUntil = 0; };
      window.speechSynthesis.speak(u);
    } catch {
      /* 语音不可用则静默降级 */
    }
  }

  /**
   * 主循环调用：根据当前疲劳等级决定是否报警。
   * 等级升高时立即报警，冷却期内重复事件不响铃但留痕。
   * 等级回落清醒且驻留超门槛时发出恢复事件。
   */
  update(level, ts, reason = '') {
    const cfg = CONFIG.alarm;
    const levelChanged = level !== this.lastLevel;
    const prevLevel = this.lastLevel;
    this.lastLevel = level;
    if (levelChanged && level === 'awake') this._awakeSince = ts;

    if (!cfg.enabled || !this.enabled) return null;
    if (level === 'awake') return this._maybeRecover(ts);

    const spec = cfg.byLevel[level];
    if (!spec) return null;

    const last = this.lastFireAt[level] || 0;
    // escalated: 等级上行跨越（含从清醒进入疲劳），绕过冷却立即报警
    const escalated = levelChanged && this._idx(level) > this._idx(prevLevel);
    // escalating: 疲劳等级之间的进一步上行（mild→moderate 等），配"疲劳在加重"文案
    const escalating = levelChanged && this._idx(prevLevel) >= 1 && this._idx(level) > this._idx(prevLevel);
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
      escalating,
      count: this.fireCountByLevel[level],
      message: `${level === 'severe' ? '重度' : level === 'moderate' ? '中度' : '轻度'}疲劳报警${reason ? ' · ' + reason : ''}`,
    };
  }

  /** 等级回落清醒且驻留超 1.2s → 恢复事件 */
  _maybeRecover(ts) {
    if (this.activeSince == null) return null;
    const RECOVERY_HOLD_MS = 1200;
    if (ts - this._awakeSince < RECOVERY_HOLD_MS) return null;
    const durationMs = this._awakeSince - this.activeSince;
    this.activeSince = null;
    this._awakeSince = null;
    if (durationMs < 500) return null;
    const ev = {
      type: 'recovery',
      level: 'ok',
      ts,
      durationMs,
      message: `已恢复清醒，本次疲劳段持续 ${Math.round(durationMs / 100) / 10} 秒`,
    };
    if (typeof this.onRecovery === 'function') this.onRecovery(ev);
    return ev;
  }

  _idx(level) {
    return ['awake', 'mild', 'moderate', 'severe'].indexOf(level);
  }

  /** 试听按钮 */
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
