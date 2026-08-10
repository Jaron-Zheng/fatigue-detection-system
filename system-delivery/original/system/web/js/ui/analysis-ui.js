/**
 * analysis-ui.js — 实验分析面板（参数敏感性 / 权重消融 / 离线复现）
 *
 * 这些工具全部不需要摄像头，可在答辩现场直接演示，
 * 并且用的是与实时检测完全相同的融合算法（core/analysis.js 复用 core/fusion.js）。
 */

import { $, el, clear, setText } from '../util/dom.js';
import { fmtDuration } from '../util/math.js';
import { CONFIG } from '../config.js';
import { SENSITIVITY_PARAMS, runSensitivity, runAblation, replaySession, parseSessionCsv } from '../core/analysis.js';
import { downloadFile, timestampName, csvCell } from '../core/recorder.js';
import { toastOk, toastWarn, toastError } from './toast.js';

const LEVEL_LABEL = { awake: '清醒', mild: '轻度', moderate: '中度', severe: '重度' };
const LEVEL_CLASS = { awake: 'badge-ok', mild: 'badge-warn', moderate: 'badge-caution', severe: 'badge-danger' };

export class AnalysisPanel {
  /** @param {() => Array} getSamples 取当前会话样本的回调 */
  constructor(getSamples) {
    this.getSamples = getSamples;
    this.lastResult = null;
    this.lastKind = null;
    this.replaySamples = null;
    this._build();
    this._bind();
  }

  _build() {
    const sel = $('#selSensParam');
    if (!sel) return;
    clear(sel);
    for (const [key, spec] of Object.entries(SENSITIVITY_PARAMS)) {
      sel.appendChild(el('option', { value: key, text: `${spec.label}${spec.unit ? '（' + spec.unit + '）' : ''}` }));
    }
    this._showDesc();
  }

  _showDesc() {
    const key = $('#selSensParam') ? $('#selSensParam').value : null;
    const spec = SENSITIVITY_PARAMS[key];
    setText($('#sensDesc'), spec ? spec.desc : '');
  }

  _bind() {
    const sel = $('#selSensParam');
    if (sel) sel.addEventListener('change', () => this._showDesc());

    const btnSens = $('#btnRunSens');
    if (btnSens) btnSens.addEventListener('click', () => this.runSensitivity());

    const btnAbl = $('#btnRunAblation');
    if (btnAbl) btnAbl.addEventListener('click', () => this.runAblation());

    const btnExp = $('#btnExportAnalysis');
    if (btnExp) btnExp.addEventListener('click', () => this.exportResult());

    const pick = $('#btnPickReplay');
    const file = $('#fileReplay');
    if (pick && file) {
      pick.addEventListener('click', () => file.click());
      file.addEventListener('change', async () => {
        await this._onReplayFile(file.files && file.files[0]);
        file.value = '';
      });
    }
  }

  /** 当前用于分析的样本：优先用导入的回放数据，否则用本次会话 */
  _samples() {
    if (this.replaySamples && this.replaySamples.length > 1) return this.replaySamples;
    return this.getSamples();
  }

  runSensitivity() {
    const samples = this._samples();
    const key = $('#selSensParam').value;
    // 消融实验会占用同一个说明位，这里必须重新写回当前参数的说明，
    // 否则先跑消融再跑敏感性时，表格是敏感性的、说明却是消融的。
    this._showDesc();
    const r = runSensitivity(samples, key);
    if (r.error) {
      toastWarn('无法运行分析', r.error);
      return;
    }
    this.lastResult = r;
    this.lastKind = 'sensitivity';
    this._renderSensitivity(r);
    toastOk('敏感性分析完成', `${r.label}：扫描 ${r.rows.length} 个候选值`);
  }

  _renderSensitivity(r) {
    const table = $('#sensTable');
    clear(table);
    table.appendChild(
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: `${r.label}${r.unit ? ' (' + r.unit + ')' : ''}` }),
          el('th', { text: '会话结论', style: { textAlign: 'center' } }),
          el('th', { text: '平均指数', style: { textAlign: 'right' } }),
          el('th', { text: '峰值指数', style: { textAlign: 'right' } }),
          el('th', { text: '疲劳时间占比', style: { textAlign: 'right' } }),
          el('th', { text: '重度占比', style: { textAlign: 'right' } }),
          el('th', { text: '兜底占比', style: { textAlign: 'right' }, title: '危险闭眼安全兜底规则生效的时间占比。该值高说明结论主要由兜底规则决定，此时其他参数的影响会被掩盖' }),
          el('th', { text: '等级跃迁', style: { textAlign: 'right' } }),
        ]),
      ])
    );
    const tbody = el('tbody');
    for (const row of r.rows) {
      const val = Number.isInteger(row.value) ? String(row.value) : row.value.toFixed(3).replace(/0+$/, '');
      tbody.appendChild(
        el('tr', { style: row.isCurrent ? { background: 'var(--accent-soft)', fontWeight: '600' } : null }, [
          el('td', { text: row.isCurrent ? `${val}（当前）` : val }),
          el('td', { style: { textAlign: 'center' } }, [
            el('span.badge', { class: LEVEL_CLASS[row.worstLevel] || '', text: LEVEL_LABEL[row.worstLevel] || row.worstLevel }),
          ]),
          el('td', { style: { textAlign: 'right' }, text: row.avgScore.toFixed(1) }),
          el('td', { style: { textAlign: 'right' }, text: row.peakScore.toFixed(0) }),
          el('td', { style: { textAlign: 'right' }, text: (row.fatigueRatio * 100).toFixed(1) + '%' }),
          el('td', { style: { textAlign: 'right' }, text: (row.ratios.severe * 100).toFixed(1) + '%' }),
          el('td', {
            style: { textAlign: 'right', color: row.overrideRatio > 0.3 ? 'var(--caution)' : 'var(--text-tertiary)' },
            text: (row.overrideRatio * 100).toFixed(1) + '%',
          }),
          el('td', { style: { textAlign: 'right' }, text: String(row.alarms) }),
        ])
      );
    }
    table.appendChild(tbody);

    /* 自动结论 */
    const host = $('#sensConclusion');
    clear(host);
    const lines = [];
    if (r.type === 'monotonic') {
      // 单调型参数是权衡取舍，不存在"最优值"，报平台区会误导
      const dir = r.slope < 0 ? '下降' : '上升';
      lines.push(
        `该参数为单调权衡型：取值每增加 1${r.unit ? r.unit : ''}，疲劳时间占比约${dir} ` +
          `${Math.abs(r.slope).toFixed(2)} 个百分点。它不存在"稳定平台区"，` +
          `也没有客观最优值——取低值预警更早但虚警更多，取高值更稳但可能漏报。` +
          `当前默认值 ${fmtNum(r.current)}${r.unit || ''}，论文中应说明所选取舍立场（本系统偏向"宁可早报"）。`
      );
    } else if (r.plateau) {
      const inside = r.current >= r.plateau.from && r.current <= r.plateau.to;
      lines.push(
        `稳定平台区约为 ${fmtNum(r.plateau.from)} – ${fmtNum(r.plateau.to)}（共 ${r.plateau.count} 个候选值结论一致），` +
          `当前默认值 ${fmtNum(r.current)} ${inside ? '落在该区间内，说明结论对参数扰动不敏感，取值有客观依据' : '未落在该区间内，建议复核默认值'}。`
      );
    } else {
      lines.push('未识别出明显的稳定平台区：结论对该参数较敏感，需要谨慎标定，论文中应作为敏感参数如实说明。');
    }
    // 若结论主要由危险闭眼兜底规则决定，必须如实说明，否则会误读为"参数不重要"
    const avgOverride = r.rows.reduce((a, b) => a + b.overrideRatio, 0) / r.rows.length;
    if (avgOverride > 0.25) {
      lines.push(
        `本次会话中安全兜底规则平均生效 ${(avgOverride * 100).toFixed(0)}% 的时间（存在多次危险闭眼），` +
          `分数在这些时段被直接钳制，因此该参数的影响被部分掩盖。` +
          `若要单独考察此参数，建议改用一段不含危险闭眼（持续闭眼均短于 ${(CONFIG.event.criticalClosureMs / 1000).toFixed(1)}s）的会话数据。`
      );
    }
    const lo = r.rows[0];
    const hi = r.rows[r.rows.length - 1];
    lines.push(
      `取值下界 ${fmtNum(lo.value)} 时疲劳占比 ${(lo.fatigueRatio * 100).toFixed(1)}%、结论「${LEVEL_LABEL[lo.worstLevel]}」；` +
        `上界 ${fmtNum(hi.value)} 时疲劳占比 ${(hi.fatigueRatio * 100).toFixed(1)}%、结论「${LEVEL_LABEL[hi.worstLevel]}」。`
    );
    for (const t of lines) host.appendChild(el('div.advice-item', { text: t }));
  }

  runAblation() {
    const samples = this._samples();
    const r = runAblation(samples);
    if (r.error) {
      toastWarn('无法运行消融实验', r.error);
      return;
    }
    this.lastResult = r;
    this.lastKind = 'ablation';

    const table = $('#sensTable');
    clear(table);
    table.appendChild(
      el('thead', {}, [
        el('tr', {}, [
          el('th', { text: '移除的指标' }),
          el('th', { text: '原权重', style: { textAlign: 'right' } }),
          el('th', { text: '平均指数', style: { textAlign: 'right' } }),
          el('th', { text: 'Δ平均', style: { textAlign: 'right' } }),
          el('th', { text: '峰值', style: { textAlign: 'right' } }),
          el('th', { text: '疲劳占比', style: { textAlign: 'right' } }),
          el('th', { text: '结论', style: { textAlign: 'center' } }),
        ]),
      ])
    );
    const tbody = el('tbody');
    tbody.appendChild(
      el('tr', { style: { background: 'var(--accent-soft)', fontWeight: '600' } }, [
        el('td', { text: '（完整模型，基线）' }),
        el('td', { style: { textAlign: 'right' }, text: '—' }),
        el('td', { style: { textAlign: 'right' }, text: r.base.avgScore.toFixed(1) }),
        el('td', { style: { textAlign: 'right' }, text: '—' }),
        el('td', { style: { textAlign: 'right' }, text: r.base.peakScore.toFixed(0) }),
        el('td', { style: { textAlign: 'right' }, text: ((1 - r.base.ratios.awake) * 100).toFixed(1) + '%' }),
        el('td', { style: { textAlign: 'center' } }, [
          el('span.badge', { class: LEVEL_CLASS[r.base.worstLevel] || '', text: LEVEL_LABEL[r.base.worstLevel] }),
        ]),
      ])
    );
    for (const row of r.rows) {
      const drop = row.deltaAvg;
      tbody.appendChild(
        el('tr', {}, [
          el('td', { text: row.label }),
          el('td', { style: { textAlign: 'right' }, text: row.weight.toFixed(2) }),
          el('td', { style: { textAlign: 'right' }, text: row.avgScore.toFixed(1) }),
          el('td', {
            style: { textAlign: 'right', color: drop < -1 ? 'var(--danger)' : 'var(--text-secondary)' },
            text: (drop >= 0 ? '+' : '') + drop.toFixed(1),
          }),
          el('td', { style: { textAlign: 'right' }, text: row.peakScore.toFixed(0) }),
          el('td', { style: { textAlign: 'right' }, text: (row.fatigueRatio * 100).toFixed(1) + '%' }),
          el('td', { style: { textAlign: 'center' } }, [
            el('span.badge', { class: LEVEL_CLASS[row.worstLevel] || '', text: LEVEL_LABEL[row.worstLevel] }),
          ]),
        ])
      );
    }
    table.appendChild(tbody);

    const host = $('#sensConclusion');
    clear(host);
    const worst = r.rows[0];
    const least = r.rows[r.rows.length - 1];
    const zeroRows = r.rows.filter((x) => Math.abs(x.deltaAvg) < 0.05);
    host.appendChild(
      el('div.advice-item', {
        text:
          `扣除「${worst.label}」后平均指数下降最多（${worst.deltaAvg.toFixed(1)} 分），` +
          `说明它在本次会话中贡献最大；扣除「${least.label}」影响最小（${least.deltaAvg.toFixed(1)} 分）。`,
      })
    );
    if (zeroRows.length) {
      host.appendChild(
        el('div.advice-item', {
          text:
            `以下指标在本次会话中贡献为零：${zeroRows.map((x) => x.label).join('、')}。` +
            `这通常说明该行为在本段数据里没有出现（例如驾驶员全程没有打哈欠），` +
            `而不是指标本身无效——不能据此删除该指标。`,
        })
      );
    }
    host.appendChild(
      el('div.advice-item', {
        text:
          '方法说明：消融采用"扣除贡献"语义，分母保持完整权重之和，因此 Δ 必然为负或零。' +
          '若改用"权重置零后重新归一化"，权重会被重新分配给其他指标，可能出现移除某项后分数反而升高的反直觉结果。' +
          '消融结论依赖具体会话内容，论文中应在多种典型场景下分别做消融并汇总。',
      })
    );
    setText($('#sensDesc'), '权重消融实验：逐项扣除某指标的贡献，观察会话结论如何变化。');
    toastOk('消融实验完成', `已对 ${r.rows.length} 个指标逐项评估`);
  }

  async _onReplayFile(file) {
    if (!file) return;
    try {
      const text = await file.text();
      const parsed = parseSessionCsv(text);
      if (parsed.error) {
        toastError('CSV 解析失败', parsed.error);
        setText($('#replayInfo'), '解析失败：' + parsed.error);
        return;
      }
      this.replaySamples = parsed.samples;
      const r = replaySession(parsed.samples, {});

      setText(
        $('#replayInfo'),
        `${file.name} · ${parsed.samples.length} 个采样点 · ${parsed.columns} 列${parsed.skipped ? ` · 跳过 ${parsed.skipped} 行无效数据` : ''}`
      );
      const badge = $('#replayBadge');
      if (badge) {
        setText(badge, '已导入并复现');
        badge.className = 'badge badge-ok';
      }

      const host = $('#replayResult');
      clear(host);
      host.appendChild(
        el('div.stat-big', {}, [
          statItem(fmtDuration(parsed.samples[parsed.samples.length - 1].t), '会话时长'),
          statItem(r.avgScore.toFixed(1), '平均疲劳指数'),
          statItem(r.peakScore.toFixed(0), '峰值疲劳指数'),
          statItem(LEVEL_LABEL[r.worstLevel] || r.worstLevel, '重算结论'),
        ])
      );
      host.appendChild(
        el('div.advice-item', {
          style: { marginTop: '14px' },
          text:
            `离线重算使用与实时检测完全相同的融合算法：清醒 ${(r.ratios.awake * 100).toFixed(1)}%、` +
            `轻度 ${(r.ratios.mild * 100).toFixed(1)}%、中度 ${(r.ratios.moderate * 100).toFixed(1)}%、` +
            `重度 ${(r.ratios.severe * 100).toFixed(1)}%，等级跃迁 ${r.alarms} 次。` +
            `后续的敏感性分析与消融实验将基于这份导入数据运行。`,
        })
      );
      toastOk('已导入并复现', `${parsed.samples.length} 个采样点，结论：${LEVEL_LABEL[r.worstLevel]}`);
    } catch (err) {
      toastError('读取文件失败', String((err && err.message) || err));
    }
  }

  exportResult() {
    if (!this.lastResult) {
      toastWarn('暂无可导出的结果', '请先运行敏感性分析或消融实验');
      return;
    }
    let rows;
    let name;
    if (this.lastKind === 'sensitivity') {
      const r = this.lastResult;
      rows = [
        ['参数名', '取值', '是否当前默认值(1=是)', '会话结论', '平均疲劳指数', '峰值疲劳指数', '疲劳时间占比', '重度时间占比', '等级跃迁次数'],
      ];
      for (const x of r.rows) {
        rows.push([
          r.label || r.param,
          x.value,
          x.isCurrent ? 1 : 0,
          LEVEL_LABEL[x.worstLevel] || x.worstLevel,
          Number(x.avgScore.toFixed(2)),
          Number(x.peakScore.toFixed(2)),
          Number(x.fatigueRatio.toFixed(4)),
          Number(x.ratios.severe.toFixed(4)),
          x.alarms,
        ]);
      }
      name = timestampName(`敏感性分析_${r.label || r.param}`, 'csv');
    } else {
      const r = this.lastResult;
      rows = [
        ['被扣除的指标', '原权重', '平均疲劳指数', '平均指数变化量', '峰值疲劳指数', '疲劳时间占比', '疲劳占比变化量', '会话结论'],
      ];
      rows.push([
        '完整模型(基线)',
        '',
        Number(r.base.avgScore.toFixed(2)),
        0,
        Number(r.base.peakScore.toFixed(2)),
        Number((1 - r.base.ratios.awake).toFixed(4)),
        0,
        LEVEL_LABEL[r.base.worstLevel] || r.base.worstLevel,
      ]);
      for (const x of r.rows) {
        rows.push([
          x.label || x.key,
          x.weight,
          Number(x.avgScore.toFixed(2)),
          Number(x.deltaAvg.toFixed(2)),
          Number(x.peakScore.toFixed(2)),
          Number(x.fatigueRatio.toFixed(4)),
          Number(x.deltaFatigueRatio.toFixed(4)),
          LEVEL_LABEL[x.worstLevel] || x.worstLevel,
        ]);
      }
      name = timestampName('权重消融实验', 'csv');
    }
    const csv = '\ufeff' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n');
    downloadFile(name, csv, 'text/csv;charset=utf-8');
    toastOk('已导出分析结果', name);
  }
}

function statItem(n, l) {
  return el('div.stat-item', {}, [el('div.n', { text: String(n) }), el('div.l', { text: l })]);
}

const fmtNum = (v) => (Number.isInteger(v) ? String(v) : String(Number(v.toFixed(4))));
