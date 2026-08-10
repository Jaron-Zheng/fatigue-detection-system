/**
 * evaluation-ui.js — 视频离线评测面板
 *
 * 交互流程刻意设计成"先标注、后评测"：
 * 用户先凭主观记忆在时间轴上划分状态区间，再运行算法。
 * 反过来（先看算法结果再标注）会产生确认偏误——人会不自觉地
 * 把标签往算法输出上靠，得出的准确率虚高且不可信。
 */

import { $, el, clear, setText, setStyle } from '../util/dom.js';
import { CONFIG } from '../config.js';
import { VideoFileSource, IntervalAnnotation } from '../core/video-source.js';
import { VideoEvaluator } from '../core/evaluator.js';
import { pct, num, summarize } from '../core/evaluation.js';
import { downloadFile, timestampName, csvCell } from '../core/recorder.js';
import { EVAL_SAMPLE_COLUMNS, LEVEL_KEY_TO_ZH, TRUTH_KEY_TO_ZH } from '../core/csv-schema.js';
import { toast, toastOk, toastWarn, toastError } from './toast.js';

const LABEL_META = {
  normal: { text: '正常', color: 'var(--ok)', soft: 'var(--ok-soft)' },
  fatigue: { text: '疲劳', color: 'var(--danger)', soft: 'var(--danger-soft)' },
  ignore: { text: '忽略', color: 'var(--text-tertiary)', soft: 'var(--fill-tertiary)' },
};

const EVAL_SLIDERS = [
  ['evaluation.stepMs', '采样步长', 40, 400, 20, 'ms'],
  ['evaluation.calibSec', '标定时长', 0, 20, 1, 's'],
];

export class EvaluationPanel {
  /** @param {() => FaceEngine} getEngine 取已初始化引擎的回调 */
  constructor(getEngine, ensureEngine) {
    this.getEngine = getEngine;
    this.ensureEngine = ensureEngine;
    this.source = null;
    this.annotation = new IntervalAnnotation();
    this.evaluator = null;
    this.markStart = null;
    this.markEnd = null;
    this.lastResult = null;
    this.videoMeta = null;
    this._build();
    this._bind();
  }

  _build() {
    const host = $('#evalSliders');
    if (!host) return;
    clear(host);
    this.sliderRefs = {};
    for (const [path, label, min, max, step, unit] of EVAL_SLIDERS) {
      const cur = path.split('.').reduce((o, k) => o[k], CONFIG);
      const valueEl = el('span.slider-value', { text: `${cur}${unit}` });
      const input = el('input.slider', {
        type: 'range',
        min: String(min),
        max: String(max),
        step: String(step),
        value: String(cur),
        'aria-label': label,
      });
      const sync = () => {
        const pctv = ((Number(input.value) - min) / (max - min)) * 100;
        input.style.setProperty('--pct', pctv.toFixed(1) + '%');
      };
      sync();
      input.addEventListener('input', () => {
        const v = Number(input.value);
        const parts = path.split('.');
        const last = parts.pop();
        parts.reduce((o, k) => o[k], CONFIG)[last] = v;
        valueEl.textContent = v === 0 && unit === 's' ? '跳过标定' : `${v}${unit}`;
        sync();
        this._checkStep();
      });
      host.appendChild(el('div.slider-row', {}, [el('span.slider-label', { text: label }), valueEl, input]));
      this.sliderRefs[path] = input;
    }
    this._checkStep();
  }

  /** 步长必须小于观测间断阈值，否则 PERCLOS 无法累积 */
  _checkStep() {
    const s = $('#evalStatus');
    if (!s) return;
    if (CONFIG.evaluation.stepMs > CONFIG.window.maxSampleGapMs) {
      setText(
        s,
        `步长 ${CONFIG.evaluation.stepMs}ms 已超过观测间断阈值 ${CONFIG.window.maxSampleGapMs}ms，` +
          `每帧都会被判为间断，PERCLOS 将无法累积。请调小步长。`
      );
      setStyle(s, 'color', 'var(--danger)');
      return true;
    }
    const est = this.videoMeta
      ? `预计 ${Math.ceil((this.videoMeta.duration * 1000) / CONFIG.evaluation.stepMs)} 个采样点`
      : '';
    setText(s, est);
    setStyle(s, 'color', 'var(--text-tertiary)');
    return false;
  }

  _bind() {
    const pick = $('#btnPickVideo');
    const file = $('#fileVideo');
    if (pick && file) {
      pick.addEventListener('click', () => file.click());
      file.addEventListener('change', async () => {
        await this._onVideo(file.files && file.files[0]);
        file.value = '';
      });
    }

    const bindIf = (id, fn) => { const el = $(id); if (el) el.addEventListener('click', fn); };

    bindIf('#btnMarkStart', () => {
      const v = $('#evalVideo');
      if (!v) return;
      this.markStart = v.currentTime;
      if (this.markEnd !== null && this.markEnd < this.markStart) this.markEnd = null;
      this._renderMark();
    });
    bindIf('#btnMarkEnd', () => {
      const v = $('#evalVideo');
      if (!v) return;
      this.markEnd = v.currentTime;
      if (this.markStart !== null && this.markEnd < this.markStart) {
        const t = this.markStart;
        this.markStart = this.markEnd;
        this.markEnd = t;
      }
      this._renderMark();
    });

    bindIf('#btnAddNormal', () => this._addInterval('normal'));
    bindIf('#btnAddFatigue', () => this._addInterval('fatigue'));
    bindIf('#btnAddIgnore', () => this._addInterval('ignore'));
    bindIf('#btnClearAnnot', () => {
      this.annotation.clear();
      this._renderAnnotations();
      toast('已清空标注');
    });

    bindIf('#btnRunEval', () => this._run());
    bindIf('#btnCancelEval', () => { if (this.evaluator) this.evaluator.cancel(); });

    bindIf('#btnExportAnnot', () => this._exportAnnot());
    const fa = $('#fileAnnot');
    if (fa) {
      bindIf('#btnImportAnnot', () => fa.click());
      fa.addEventListener('change', async () => {
        await this._importAnnot(fa.files && fa.files[0]);
        fa.value = '';
      });
    }

    // 点击时间轴跳转播放位置
    const tl = $('#annotTimeline');
    if (tl) {
      tl.addEventListener('click', (e) => {
        if (!this.videoMeta) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const ratio = (e.clientX - rect.left) / rect.width;
        const vEl = $('#evalVideo');
        if (vEl) vEl.currentTime = Math.max(0, Math.min(1, ratio)) * this.videoMeta.duration;
      });
    }
  }

  async _onVideo(f) {
    if (!f) return;
    try {
      const v = $('#evalVideo');
      if (!this.source) this.source = new VideoFileSource(v);
      const meta = await this.source.load(f);
      this.videoMeta = meta;
      $('#evalWorkspace').hidden = false;
      setText(
        $('#videoInfo'),
        `${meta.name} · ${meta.duration.toFixed(1)}s · ${meta.width}×${meta.height} · ${(meta.sizeBytes / 1048576).toFixed(1)}MB`
      );
      const badge = $('#evalBadge');
      setText(badge, '已导入，待标注');
      badge.className = 'badge badge-warn';
      this.annotation.clear();
      this.markStart = null;
      this.markEnd = null;
      this._renderMark();
      this._renderAnnotations();
      this._checkStep();
      clear($('#evalResult'));
      toastOk('视频已载入', `时长 ${meta.duration.toFixed(1)} 秒，请先在时间轴上标注状态区间`);
    } catch (err) {
      toastError('载入失败', String((err && err.message) || err));
    }
  }

  _renderMark() {
    const f = (v) => (v === null ? '--' : v.toFixed(2) + 's');
    setText($('#markRange'), `${f(this.markStart)} ~ ${f(this.markEnd)}`);
  }

  _addInterval(label) {
    if (this.markStart === null || this.markEnd === null) {
      toastWarn('请先设置起点与终点', '播放到目标位置后点「设为起点」「设为终点」');
      return;
    }
    const r = this.annotation.add(this.markStart, this.markEnd, label);
    if (r && r.error) {
      toastWarn('无法添加区间', r.error);
      return;
    }
    // 添加后把起点移到刚才的终点，便于连续标注
    this.markStart = this.markEnd;
    this.markEnd = null;
    this._renderMark();
    this._renderAnnotations();
  }

  _renderAnnotations() {
    const tl = $('#annotTimeline');
    clear(tl);
    const dur = this.videoMeta ? this.videoMeta.duration : 0;
    if (dur > 0) {
      for (let i = 0; i < this.annotation.intervals.length; i++) {
        const iv = this.annotation.intervals[i];
        const meta = LABEL_META[iv.label];
        tl.appendChild(
          el('div', {
            title: `${iv.start.toFixed(2)}s ~ ${iv.end.toFixed(2)}s · ${meta.text}`,
            style: {
              position: 'absolute',
              left: ((iv.start / dur) * 100).toFixed(2) + '%',
              width: (((iv.end - iv.start) / dur) * 100).toFixed(2) + '%',
              top: '0',
              bottom: '0',
              background: meta.color,
              opacity: iv.label === 'ignore' ? '0.35' : '0.75',
            },
          })
        );
      }
    }

    setText($('#annotCoverage'), `已标注 ${this.annotation.coverage.toFixed(1)}s`);

    const table = $('#annotTable');
    clear(table);
    if (!this.annotation.intervals.length) {
      table.appendChild(
        el('tbody', {}, [
          el('tr', {}, [el('td', { text: '尚无标注区间。', style: { color: 'var(--text-tertiary)' } })]),
        ])
      );
      return;
    }
    table.appendChild(
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: '起' }),
          el('th', { text: '止' }),
          el('th', { text: '时长' }),
          el('th', { text: '标签' }),
          el('th', { text: '' }),
        ]),
      ])
    );
    const tbody = el('tbody');
    this.annotation.intervals.forEach((iv, i) => {
      const meta = LABEL_META[iv.label];
      tbody.appendChild(
        el('tr', {}, [
          el('td', { text: iv.start.toFixed(2) + 's' }),
          el('td', { text: iv.end.toFixed(2) + 's' }),
          el('td', { text: (iv.end - iv.start).toFixed(2) + 's' }),
          el('td', {}, [el('span.badge', { text: meta.text, style: { background: meta.soft, color: meta.color } })]),
          el('td', {}, [
            el('button.pill.pill-sm', {
              text: '删除',
              onClick: () => {
                this.annotation.remove(i);
                this._renderAnnotations();
              },
            }),
          ]),
        ])
      );
    });
    table.appendChild(tbody);
  }

  async _run() {
    if (!this.source || !this.source.ready) {
      toastWarn('请先选择视频文件');
      return;
    }
    if (this._checkStep()) {
      toastWarn('采样步长不合法', '请调小步长后重试');
      return;
    }
    const hasAnnot = this.annotation.intervals.some((iv) => iv.label !== 'ignore');
    if (!hasAnnot) {
      const go = confirm(
        '尚未标注任何"正常/疲劳"区间。\n\n' +
          '继续将只输出算法指标，无法计算准确率、灵敏度等评估结果。\n\n' +
          '是否仍要继续？'
      );
      if (!go) return;
    }

    const engine = this.getEngine();
    if (!engine || !engine.ready) {
      setText($('#evalStatus'), '正在初始化推理引擎…');
      try {
        await this.ensureEngine();
      } catch (err) {
        toastError('引擎初始化失败', String((err && err.message) || err));
        return;
      }
    }

    const btn = $('#btnRunEval');
    const cancel = $('#btnCancelEval');
    btn.disabled = true;
    cancel.disabled = false;
    $('#evalProgressWrap').hidden = false;
    clear($('#evalResult'));

    this.evaluator = new VideoEvaluator(this.getEngine(), this.source);
    const t0 = performance.now();

    try {
      const res = await this.evaluator.run({
        stepMs: CONFIG.evaluation.stepMs,
        calibSec: CONFIG.evaluation.calibSec,
        annotation: this.annotation,
        positiveFrom: $('#selPositiveFrom').value,
        onProgress: (done, total, tSec) => {
          setStyle($('#evalProgress'), 'width', ((done / total) * 100).toFixed(1) + '%');
          setText($('#evalStatus'), `评测中 ${done}/${total} 采样点（视频 ${tSec.toFixed(1)}s）`);
          setStyle($('#evalStatus'), 'color', 'var(--text-secondary)');
        },
      });

      if (res.cancelled) {
        toastWarn('评测已取消');
        setText($('#evalStatus'), '已取消');
        return;
      }
      if (res.error) {
        toastError('评测失败', res.error);
        setText($('#evalStatus'), res.error);
        setStyle($('#evalStatus'), 'color', 'var(--danger)');
        return;
      }

      this.lastResult = res;
      const elapsed = (performance.now() - t0) / 1000;
      setText($('#evalStatus'), `完成，耗时 ${elapsed.toFixed(1)} 秒，共 ${res.samples.length} 个采样点`);
      const badge = $('#evalBadge');
      setText(badge, res.metrics ? '已完成准确率评估' : '已完成指标评测');
      badge.className = 'badge ' + (res.metrics ? 'badge-ok' : 'badge-warn');
      this._renderResult(res);
      toastOk('评测完成', res.metrics ? `灵敏度 ${pct(res.metrics.byTime.sensitivity)}` : '已输出算法指标');
    } catch (err) {
      toastError('评测异常', String((err && err.message) || err));
      console.error(err);
    } finally {
      btn.disabled = false;
      cancel.disabled = true;
      this.evaluator = null;
    }
  }

  _renderResult(res) {
    const host = $('#evalResult');
    clear(host);

    /* ---- 视频质量前置提示 ---- */
    if (!res.quality.usable) {
      host.appendChild(
        el('div.advice-item', {
          style: { background: 'var(--danger-soft)', color: 'var(--danger)' },
          text:
            `人脸丢失率 ${pct(res.quality.faceLostRatio)} 过高，本段视频不适合用于准确率评估。` +
            `请确认面部完整入画、光照充足后重新录制。`,
        })
      );
    }

    /* ---- 标定信息 ---- */
    const c = res.calibration;
    host.appendChild(
      el('div.advice-item', {
        text: c.used
          ? c.fallback
            ? `个性化标定未成功（${c.reason || '有效样本不足'}），已回退通用阈值——这会降低准确率，建议视频开头保留 ${c.durationSec}s 正视镜头的清醒片段。`
            : `个性化标定成功：睁眼 EAR 基线 ${num(c.earBaseline, 4)}，闭眼阈值 ${num(c.earCloseThresh, 4)}，质量${c.quality}（${c.sampleCount} 样本）。`
          : '已跳过个性化标定，使用通用固定阈值。',
      })
    );

    if (!res.metrics) {
      host.appendChild(
        el('div.advice-item', {
          text: '未提供"正常/疲劳"标注，因此只输出算法指标而无准确率评估。请在时间轴上标注后重跑。',
        })
      );
      this._renderExportButtons(host, res);
      return;
    }

    const t = res.metrics.byTime;
    const mt = res.metrics.matrixTimeMs;
    const sec = (v) => (v / 1000).toFixed(1) + 's';

    /* ---- 核心指标卡 ---- */
    host.appendChild(
      el('div.stat-big', { style: { marginTop: '16px' } }, [
        statItem(pct(t.sensitivity), '灵敏度（查全）', 'var(--ok)'),
        statItem(pct(t.specificity), '特异度（抗误报）', 'var(--accent)'),
        statItem(pct(t.accuracy), '准确率'),
        statItem(num(t.mcc), 'MCC 相关系数'),
      ])
    );

    /* ---- 混淆矩阵 ---- */
    host.appendChild(el('h4', { text: '混淆矩阵（按时间加权）', style: { margin: '22px 0 10px', fontSize: '15px' } }));
    const cm = el('table.tbl');
    cm.appendChild(
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: '' }),
          el('th', { text: '系统判为疲劳', style: { textAlign: 'center' } }),
          el('th', { text: '系统判为正常', style: { textAlign: 'center' } }),
        ]),
      ])
    );
    cm.appendChild(
      el('tbody', {}, [
        el('tr', {}, [
          el('th', { text: '人工标注：疲劳' }),
          cell(`TP ${sec(mt.tp)}`, 'var(--ok-soft)', 'var(--ok)'),
          cell(`FN ${sec(mt.fn)}`, 'var(--danger-soft)', 'var(--danger)'),
        ]),
        el('tr', {}, [
          el('th', { text: '人工标注：正常' }),
          cell(`FP ${sec(mt.fp)}`, 'var(--caution-soft)', 'var(--caution)'),
          cell(`TN ${sec(mt.tn)}`, 'var(--ok-soft)', 'var(--ok)'),
        ]),
      ])
    );
    host.appendChild(cm);
    host.appendChild(
      el('p.t-caption', {
        style: { marginTop: '8px' },
        text:
          `FN（漏报）是安全相关系统最需要关注的一格：这段时间你确实疲劳，但系统没有报警。` +
          `FP（误报）影响使用体验但不涉及安全。`,
      })
    );

    /* ---- 完整指标表 ---- */
    host.appendChild(el('h4', { text: '完整指标', style: { margin: '22px 0 10px', fontSize: '15px' } }));
    const rows = [
      ['准确率 Accuracy', pct(t.accuracy), '整体判对比例。类别不平衡时会虚高，不能单看'],
      ['灵敏度 Sensitivity / Recall', pct(t.sensitivity), '真实疲劳中被检出的比例，本场景首要指标'],
      ['特异度 Specificity', pct(t.specificity), '正常状态中未被误报的比例'],
      ['查准率 Precision', pct(t.precision), '系统报疲劳时确实疲劳的比例'],
      ['平衡准确率 Balanced Acc.', pct(t.balancedAcc), '灵敏度与特异度的算术平均，抗不平衡'],
      ['F1 分数', num(t.f1), '查准率与查全率的调和平均'],
      ["Youden's J", num(t.youdenJ), '灵敏度+特异度−1，0 等于随机猜测'],
      ['MCC', num(t.mcc), 'Matthews 相关系数，−1~1，公认最稳的单一指标'],
      ['漏报率 FNR', pct(t.fnr), '真实疲劳被判为正常的比例'],
      ['误报率 FPR', pct(t.fpr), '正常被判为疲劳的比例'],
    ];
    const mtbl = el('table.tbl');
    mtbl.appendChild(
      el('thead', {}, [el('tr', {}, [el('th', { text: '指标' }), el('th', { text: '数值', style: { textAlign: 'center' } }), el('th', { text: '含义' })])])
    );
    mtbl.appendChild(
      el(
        'tbody',
        {},
        rows.map(([k, v, d]) =>
          el('tr', {}, [
            el('td', { text: k }),
            el('td', { text: v, style: { textAlign: 'center', fontWeight: '700' } }),
            el('td', { text: d, style: { color: 'var(--text-secondary)' } }),
          ])
        )
      )
    );
    host.appendChild(mtbl);

    /* ---- 正类阈值扫描 ---- */
    if (res.sweep) {
      host.appendChild(el('h4', { text: '疲劳判定起始等级对比', style: { margin: '22px 0 10px', fontSize: '15px' } }));
      const st = el('table.tbl');
      st.appendChild(
        el('thead', {}, [
          el('tr', {}, [
            el('th', { text: '正类定义' }),
            el('th', { text: '灵敏度', style: { textAlign: 'center' } }),
            el('th', { text: '特异度', style: { textAlign: 'center' } }),
            el('th', { text: '平衡准确率', style: { textAlign: 'center' } }),
            el('th', { text: 'MCC', style: { textAlign: 'center' } }),
          ]),
        ])
      );
      const cur = res.config.positiveFrom;
      st.appendChild(
        el(
          'tbody',
          {},
          res.sweep.map((s) =>
            el('tr', { style: s.positiveFrom === cur ? { background: 'var(--accent-soft)', fontWeight: '600' } : null }, [
              el('td', { text: s.label + (s.positiveFrom === cur ? '（当前）' : '') }),
              el('td', { text: pct(s.sensitivity), style: { textAlign: 'center' } }),
              el('td', { text: pct(s.specificity), style: { textAlign: 'center' } }),
              el('td', { text: pct(s.balancedAcc), style: { textAlign: 'center' } }),
              el('td', { text: num(s.mcc), style: { textAlign: 'center' } }),
            ])
          )
        )
      );
      host.appendChild(st);
    }

    /* ---- 响应延迟 ---- */
    if (res.latency && res.latency.events.length) {
      const L = res.latency;
      host.appendChild(el('h4', { text: '响应延迟', style: { margin: '22px 0 10px', fontSize: '15px' } }));
      host.appendChild(
        el('div.stat-big', {}, [
          statItem(Number.isFinite(L.meanLatencySec) ? L.meanLatencySec.toFixed(1) + 's' : '--', '平均延迟'),
          statItem(Number.isFinite(L.medianLatencySec) ? L.medianLatencySec.toFixed(1) + 's' : '--', '中位延迟'),
          statItem(`${L.detectedCount}/${L.events.length}`, '检出/总区间'),
          statItem(String(L.missedCount), '漏检区间', L.missedCount > 0 ? 'var(--danger)' : undefined),
        ])
      );
    }

    /* ---- 自动结论 ---- */
    host.appendChild(el('h4', { text: '结论', style: { margin: '22px 0 10px', fontSize: '15px' } }));
    for (const line of summarize(res.metrics, res.latency)) {
      host.appendChild(el('div.advice-item', { text: line }));
    }

    this._renderExportButtons(host, res);
  }

  _renderExportButtons(host, res) {
    host.appendChild(
      el('div.controls.no-print', { style: { marginTop: '20px' } }, [
        el('div.controls-group', {}, [
          el('span.controls-label', { text: '导出' }),
          el('button.pill.pill-primary', { text: '评测报告 JSON', onClick: () => this._exportJson(res) }),
          el('button.pill', { text: '逐点数据 CSV', onClick: () => this._exportCsv(res) }),
          el('button.pill', { text: '指标汇总 CSV', onClick: () => this._exportMetricsCsv(res) }),
        ]),
      ])
    );
  }

  _annotationAt(res, tSec) {
    if (typeof res?.samples?.find === 'function') {
      const hit = res.samples.find((s) => Math.abs(s.tSec - tSec) < 1e-6 && s.truth);
      if (hit && hit.truth) return hit.truth;
    }
    const snapshot = Array.isArray(res?.annotation) ? IntervalAnnotation.fromJSON(res.annotation) : null;
    return snapshot ? snapshot.labelAt(tSec) || 'unlabeled' : 'unlabeled';
  }

  _exportJson(res) {
    const data = {
      meta: {
        product: '基于面部多特征融合的Web端驾驶员疲劳检测系统',
        kind: '视频离线评测报告',
        exportedAt: new Date().toISOString(),
        note: '视频仅在本机解码，本文件不含任何图像数据。标签由被试本人主观自评给出。',
      },
      video: res.video,
      file: res.file,
      config: { ...res.config, algorithmConfig: { window: CONFIG.window, event: CONFIG.event, fusion: CONFIG.fusion } },
      calibration: res.calibration,
      annotation: Array.isArray(res.annotation) ? res.annotation : [],
      labelStats: res.labelStats,
      metrics: res.metrics,
      sweep: res.sweep,
      latency: res.latency,
      quality: res.quality,
      summary: res.summary,
      conclusion: res.metrics ? summarize(res.metrics, res.latency) : [],
      samples: res.samples,
      events: res.events,
    };
    downloadFile(timestampName('视频评测报告', 'json'), JSON.stringify(data, null, 2), 'application/json');
    toastOk('已导出评测报告 JSON');
  }

  _exportCsv(res) {
    const lines = [EVAL_SAMPLE_COLUMNS.map((c) => c.zh).map(csvCell).join(',')];
    for (const s of res.samples) {
      const truth = s.truth || this._annotationAt(res, s.tSec);
      const row = {
        tSec: s.tSec,
        truth: TRUTH_KEY_TO_ZH[truth] || truth,
        pred: LEVEL_KEY_TO_ZH[s.level] || s.level,
        score: s.score,
        raw: s.raw,
        perclos: s.perclos,
        perclosReady: s.perclosReady ? 1 : 0,
        maxClosureMs: s.maxClosureMs,
        currentClosureMs: s.currentClosureMs,
        blinkRate: s.blinkRate,
        avgBlinkMs: s.avgBlinkMs ?? '',
        yawnRate: s.yawnRate,
        nodRate: s.nodRate,
        headDevRatio: s.headDevRatio,
        ear: s.ear ?? '',
        mar: s.mar ?? '',
        pitch: s.pitch ?? '',
        yaw: s.yaw ?? '',
        facePresent: s.facePresent,
        dataValid: s.dataValid,
      };
      lines.push(EVAL_SAMPLE_COLUMNS.map((c) => csvCell(row[c.key])).join(','));
    }
    downloadFile(timestampName('视频评测逐点数据', 'csv'), '\ufeff' + lines.join('\r\n'), 'text/csv;charset=utf-8');
    toastOk('已导出逐点数据 CSV', `${res.samples.length} 行`);
  }

  _exportMetricsCsv(res) {
    if (!res.metrics) {
      toastWarn('无准确率指标可导出', '请先完成标注再评测');
      return;
    }
    const t = res.metrics.byTime;
    const c = res.metrics.byCount;
    const mt = res.metrics.matrixTimeMs;
    // 表头与指标名都用中文（括号里保留通用英文缩写，方便对照文献）
    const rows = [['指标', '按时间加权', '按采样点计数']];
    const numOrBlank = (v) => (Number.isFinite(v) ? Number(v.toFixed(6)) : '');
    const add = (k, a, b) => rows.push([k, numOrBlank(a), numOrBlank(b)]);
    add('准确率 Accuracy', t.accuracy, c.accuracy);
    add('灵敏度/召回率 Sensitivity', t.sensitivity, c.sensitivity);
    add('特异度 Specificity', t.specificity, c.specificity);
    add('精确率 Precision', t.precision, c.precision);
    add('阴性预测值 NPV', t.npv, c.npv);
    add('F1 分数', t.f1, c.f1);
    add('平衡准确率 Balanced Accuracy', t.balancedAcc, c.balancedAcc);
    add('Youden J 指数', t.youdenJ, c.youdenJ);
    add('马修斯相关系数 MCC', t.mcc, c.mcc);
    add('假正率 FPR', t.fpr, c.fpr);
    add('假负率 FNR', t.fnr, c.fnr);
    rows.push(['真正例 TP（时间列为毫秒）', Math.round(mt.tp), res.metrics.matrix.tp]);
    rows.push(['假正例 FP（时间列为毫秒）', Math.round(mt.fp), res.metrics.matrix.fp]);
    rows.push(['真负例 TN（时间列为毫秒）', Math.round(mt.tn), res.metrics.matrix.tn]);
    rows.push(['假负例 FN（时间列为毫秒）', Math.round(mt.fn), res.metrics.matrix.fn]);
    if (res.latency) {
      // 缺失值写空单元格，而不是界面上那个占位的 "--"：
      // "--" 以减号开头，会被 CSV 防注入规则加上单引号变成 '-- ，在 Excel 里更难看
      rows.push(['平均响应延迟(秒)', numOrBlank(res.latency.meanLatencySec), '']);
      rows.push(['响应延迟中位数(秒)', numOrBlank(res.latency.medianLatencySec), '']);
      rows.push(['已检出的疲劳区间数', res.latency.detectedCount, '']);
      rows.push(['漏检的疲劳区间数', res.latency.missedCount, '']);
    }
    downloadFile(
      timestampName('视频评测指标汇总', 'csv'),
      '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n'),
      'text/csv;charset=utf-8'
    );
    toastOk('已导出指标汇总 CSV');
  }

  _exportAnnot() {
    if (!this.annotation.intervals.length) {
      toastWarn('尚无标注可导出');
      return;
    }
    const data = {
      video: this.videoMeta ? { name: this.videoMeta.name, duration: this.videoMeta.duration } : null,
      createdAt: new Date().toISOString(),
      labelScheme: { normal: '正常/清醒', fatigue: '疲劳（轻度及以上）', ignore: '不计入评估' },
      note: '标签由被试本人主观自评给出，等价于 KSS 嗜睡量表的简化二分。',
      intervals: this.annotation.toJSON(),
    };
    downloadFile(timestampName('人工标注', 'json'), JSON.stringify(data, null, 2), 'application/json');
    toastOk('已导出标注');
  }

  async _importAnnot(f) {
    if (!f) return;
    try {
      if (f.size <= 0) throw new Error('所选标注文件为空。');
      if (f.size > 2 * 1024 * 1024) throw new Error('标注文件超过 2MB 安全限制。');
      if (f.type && f.type !== 'application/json' && !/\.json$/i.test(f.name)) {
        throw new Error('请选择 JSON 格式的标注文件。');
      }
      const data = JSON.parse(await f.text());
      const arr = Array.isArray(data) ? data : data.intervals;
      if (!Array.isArray(arr)) {
        toastError('标注文件格式不正确', '缺少 intervals 数组');
        return;
      }
      this.annotation = IntervalAnnotation.fromJSON(arr);
      this._renderAnnotations();
      if (data.video && this.videoMeta && data.video.name !== this.videoMeta.name) {
        toastWarn('标注与当前视频可能不匹配', `标注来自「${data.video.name}」`);
      } else {
        toastOk('标注已导入', `${this.annotation.intervals.length} 个区间`);
      }
    } catch (err) {
      toastError('导入失败', String((err && err.message) || err));
    }
  }
}

function statItem(n, l, color) {
  return el('div.stat-item', {}, [
    el('div.n', { text: String(n), style: color ? { color } : null }),
    el('div.l', { text: l }),
  ]);
}

function cell(text, bg, color) {
  return el('td', {
    text,
    style: { textAlign: 'center', background: bg, color, fontWeight: '700' },
  });
}
