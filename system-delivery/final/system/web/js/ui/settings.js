/**
 * settings.js — 参数设置面板
 *
 * 把算法里所有关键参数暴露成可视化控件，价值有两层：
 *   ① 使用层面：不同车型、不同摄像头位置需要微调阈值；
 *   ② 论文层面：做参数敏感性分析与消融实验时，改一个滑块就能出一组对照数据，
 *      不需要改代码重新部署。
 */

import { CONFIG, saveUserConfig, resetConfig } from '../config.js';
import { el, clear, $ } from '../util/dom.js';
import { INDICATOR_META } from '../core/fusion.js';
import { toastOk } from './toast.js';

/** 滑块定义：[对象路径, 标签, min, max, step, 单位, 数值换算] */
const THRESHOLD_SPECS = [
  ['event.microsleepMs', '微睡眠判定时长', 300, 1200, 50, 'ms'],
  ['event.criticalClosureMs', '危险闭眼时长', 1000, 4000, 100, 'ms'],
  ['event.yawnMinMs', '哈欠最短持续', 600, 3000, 100, 'ms'],
  ['event.nodPitchVelDegPerSec', '点头角速度阈值', 25, 120, 5, '°/s'],
  ['event.headDeviationDeg', '视线偏离角度', 10, 50, 1, '°'],
  ['calibration.earCloseRatio', '闭眼阈值系数', 0.55, 0.9, 0.01, '× 基线'],
  ['fusion.emaAlpha', 'EMA 平滑系数', 0.03, 0.5, 0.01, ''],
  ['fusion.hysteresis', '等级滞回带宽', 0, 15, 1, '分'],
];

const WINDOW_SPECS = [
  ['window.perclosSec', 'PERCLOS 窗口', 15, 120, 5, 's'],
  ['window.rateSec', '频率统计窗口', 20, 180, 10, 's'],
  ['window.waveSec', '波形显示窗口', 10, 60, 5, 's'],
  ['calibration.durationSec', '标定时长', 3, 20, 1, 's'],
];

/** 同步滑块的填充比例（供 CSS 渐变使用），让当前值在量程中的位置可见 */
function syncFill(input) {
  const min = Number(input.min);
  const max = Number(input.max);
  const v = Number(input.value);
  const pct = max > min ? ((v - min) / (max - min)) * 100 : 0;
  input.style.setProperty('--pct', pct.toFixed(1) + '%');
}

function getPath(obj, path) {
  return path.split('.').reduce((o, k) => (o ? o[k] : undefined), obj);
}
function setPath(obj, path, val) {
  const parts = path.split('.');
  const last = parts.pop();
  const target = parts.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj);
  if (target && typeof target === 'object') target[last] = val;
}

export class SettingsPanel {
  /**
   * @param {object} hooks 回调集合，由 app.js 注入
   */
  constructor(hooks = {}) {
    this.hooks = hooks;
    this.sheet = $('#sheet');
    this.backdrop = $('#sheetBackdrop');
    this.open = false;
    this._lastFocus = null;
    this._build();
    this._bind();
  }

  _build() {
    /* ---- 融合权重 ---- */
    const wHost = $('#weightSliders');
    clear(wHost);
    this.weightInputs = {};
    for (const key of Object.keys(CONFIG.fusion.weights)) {
      const meta = INDICATOR_META[key];
      const val = CONFIG.fusion.weights[key];
      const valueEl = el('span.slider-value', { text: val.toFixed(2) });
      const input = el('input.slider', {
        type: 'range',
        min: '0',
        max: '0.6',
        step: '0.01',
        value: String(val),
        'aria-label': meta.label + ' 权重',
      });
      syncFill(input);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        CONFIG.fusion.weights[key] = v;
        valueEl.textContent = v.toFixed(2);
        syncFill(input);
        this._updateWeightSum();
      });
      wHost.appendChild(
        el('div.slider-row', { title: meta.desc }, [
          el('span.slider-label', { text: meta.label }),
          valueEl,
          input,
        ])
      );
      this.weightInputs[key] = { input, valueEl };
    }
    this.weightSumEl = el('div.t-caption', { style: { marginTop: '4px' } });
    wHost.appendChild(this.weightSumEl);
    this._updateWeightSum();

    /* ---- 阈值 ---- */
    this.thresholdInputs = this._buildSpecs($('#thresholdSliders'), THRESHOLD_SPECS);
    /* ---- 窗口 ---- */
    this.windowInputs = this._buildSpecs($('#windowSliders'), WINDOW_SPECS, () => {
      if (this.hooks.onWindowChange) this.hooks.onWindowChange();
    });
  }

  _buildSpecs(host, specs, onChange) {
    clear(host);
    const map = {};
    for (const [path, label, min, max, step, unit] of specs) {
      const val = getPath(CONFIG, path);
      const digits = step < 1 ? 2 : 0;
      const valueEl = el('span.slider-value', { text: `${Number(val).toFixed(digits)}${unit}` });
      const input = el('input.slider', {
        type: 'range',
        min: String(min),
        max: String(max),
        step: String(step),
        value: String(val),
        'aria-label': label,
      });
      syncFill(input);
      input.addEventListener('input', () => {
        const v = Number(input.value);
        setPath(CONFIG, path, v);
        valueEl.textContent = `${v.toFixed(digits)}${unit}`;
        syncFill(input);
        if (onChange) onChange();
      });
      host.appendChild(
        el('div.slider-row', {}, [el('span.slider-label', { text: label }), valueEl, input])
      );
      map[path] = { input, valueEl, unit, digits };
    }
    return map;
  }

  _updateWeightSum() {
    const sum = Object.values(CONFIG.fusion.weights).reduce((a, b) => a + b, 0);
    this.weightSumEl.textContent = `权重合计 ${sum.toFixed(2)}，计算时会自动归一化（各项 ÷ 合计）。`;
  }

  _bind() {
    const h = this.hooks;

    $('#btnSettings').addEventListener('click', () => this.show());
    $('#btnCloseSheet').addEventListener('click', () => this.hide());
    this.backdrop.addEventListener('click', () => this.hide());
    // 保存引用以便在重建时移除旧监听器，防止多次绑定累积
    if (this._onKeyDown) document.removeEventListener('keydown', this._onKeyDown);
    this._onKeyDown = (e) => {
      if (!this.open) return;
      if (e.key === 'Escape') {
        this.hide();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = Array.from(
        this.sheet.querySelectorAll(
          'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])'
        )
      ).filter((node) => !node.hidden && node.getClientRects().length > 0);
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', this._onKeyDown);

    /* 报警开关 */
    const swAlarm = $('#swAlarm');
    swAlarm.checked = CONFIG.alarm.enabled;
    swAlarm.addEventListener('change', () => {
      CONFIG.alarm.enabled = swAlarm.checked;
    });

    const swSpeech = $('#swSpeech');
    swSpeech.checked = CONFIG.alarm.speechEnabled;
    swSpeech.addEventListener('change', () => {
      CONFIG.alarm.speechEnabled = swSpeech.checked;
    });

    $('#btnTestAlarm').addEventListener('click', () => {
      if (h.onTestAlarm) h.onTestAlarm();
    });

    /* 画面开关 */
    const swMesh = $('#swMesh');
    swMesh.checked = CONFIG.render.showMesh;
    swMesh.addEventListener('change', () => {
      CONFIG.render.showMesh = swMesh.checked;
      CONFIG.render.showContours = swMesh.checked;
      CONFIG.render.showIris = swMesh.checked;
      if (h.onRenderChange) h.onRenderChange();
    });

    const swMirror = $('#swMirror');
    swMirror.checked = CONFIG.render.mirror;
    swMirror.addEventListener('change', () => {
      CONFIG.render.mirror = swMirror.checked;
      if (h.onRenderChange) h.onRenderChange();
    });

    /* 摄像头选择 */
    this.selCamera = $('#selCamera');
    this.selCamera.addEventListener('change', () => {
      if (h.onCameraChange) h.onCameraChange(this.selCamera.value);
    });

    /* 推理委托 */
    const seg = $('#segDelegate');
    seg.querySelectorAll('button').forEach((b) => {
      b.setAttribute('aria-selected', String(b.dataset.v === CONFIG.capture.delegate));
      b.addEventListener('click', () => {
        seg.querySelectorAll('button').forEach((x) => x.setAttribute('aria-selected', 'false'));
        b.setAttribute('aria-selected', 'true');
        CONFIG.capture.delegate = b.dataset.v;
        if (h.onDelegateChange) h.onDelegateChange(b.dataset.v);
      });
    });

    /* 模拟疲劳注入（答辩演示用） */
    const swSim = $('#swSimulate');
    swSim.addEventListener('change', () => {
      if (h.onSimulateChange) h.onSimulateChange(swSim.checked);
    });
    this.swSimulate = swSim;

    /* 保存 / 重置 */
    $('#btnSaveCfg').addEventListener('click', () => {
      saveUserConfig();
      toastOk('参数已保存', '下次打开系统会自动沿用当前设置');
      this.hide();
    });
    $('#btnResetCfg').addEventListener('click', () => {
      resetConfig();
      this._build();
      this._syncSwitches();
      if (h.onWindowChange) h.onWindowChange();
      if (h.onRenderChange) h.onRenderChange();
      toastOk('已恢复默认参数');
    });
  }

  _syncSwitches() {
    $('#swAlarm').checked = CONFIG.alarm.enabled;
    $('#swSpeech').checked = CONFIG.alarm.speechEnabled;
    $('#swMesh').checked = CONFIG.render.showMesh;
    $('#swMirror').checked = CONFIG.render.mirror;
    if (this.swSimulate) this.swSimulate.checked = false;
    $('#segDelegate')
      .querySelectorAll('button')
      .forEach((b) => b.setAttribute('aria-selected', String(b.dataset.v === CONFIG.capture.delegate)));
  }

  /** 填充摄像头列表 */
  setCameras(devices, currentId) {
    clear(this.selCamera);
    if (!devices.length) {
      this.selCamera.appendChild(el('option', { value: '', text: '默认摄像头' }));
      return;
    }
    devices.forEach((d, i) => {
      this.selCamera.appendChild(
        el('option', { value: d.deviceId, text: d.label || `摄像头 ${i + 1}` })
      );
    });
    if (currentId) this.selCamera.value = currentId;
  }

  show() {
    this._lastFocus = document.activeElement;
    this.open = true;
    this.sheet.classList.add('open');
    this.backdrop.classList.add('open');
    this.sheet.setAttribute('aria-hidden', 'false');
    const first = this.sheet.querySelector('button, input, select');
    if (first) first.focus();
  }

  hide() {
    this.open = false;
    this.sheet.classList.remove('open');
    this.backdrop.classList.remove('open');
    this.sheet.setAttribute('aria-hidden', 'true');
    if (this._lastFocus && this._lastFocus.focus) this._lastFocus.focus();
  }
}
