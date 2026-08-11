#!/usr/bin/env node
/**
 * check-literals.mjs — 设计令牌落地一致性检测（第三轮角色十五）
 *
 * 扫描 web/css/{base,components,layout,motion}.css，找出绕开令牌系统
 * 直接写字面量颜色（#hex / rgb()/rgba()）的地方。tokens.css 是令牌
 * 的唯一真相来源，不在扫描范围内。
 *
 * 判定规则：
 *   1. 注释里的颜色不算（但注释里写了 `lit-ok:` 视为人工裁决标记）；
 *   2. 中性黑白（rgba(0,0,0,α)/rgba(255,255,255,α)）与近黑遮罩
 *      rgba(10,10,11,α) 主题无关，自动放行；
 *   3. rgba(var(--xxx-rgb), α) 这类令牌引用不是字面量，放行；
 *   4. 其余字面量必须在同一行带 `/* lit-ok: 理由 *\/` 标记才放行，
 *      否则记为违规——谁手滑写死一个颜色，静态检查当场拦下。
 *
 * 用法：
 *   node tools/check-literals.mjs            扫描真实 CSS
 *   node tools/check-literals.mjs --selftest 自检：构造违规样例验证拦截能力
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCAN_FILES = ['base.css', 'components.css', 'layout.css', 'motion.css'].map((f) =>
  path.join(ROOT, 'web', 'css', f)
);

const HEX_RE = /#[0-9a-fA-F]{3,8}\b/g;
const RGB_RE = /\brgba?\(/g;
/** 自动放行的中性色（主题无关的黑白与近黑遮罩） */
const NEUTRAL_RE = /^rgba?\(\s*(?:0\s*,\s*0\s*,\s*0|255\s*,\s*255\s*,\s*255|10\s*,\s*10\s*,\s*11)\s*,/;

/**
 * 扫描一份 CSS 文本，返回违规列表 [{line, text, match}]。
 * @param {string} source CSS 源码
 */
export function scanLiterals(source) {
  const violations = [];
  const lines = source.split('\n');
  let inBlockComment = false;

  lines.forEach((rawLine, idx) => {
    let line = rawLine;
    let approved = false;

    // 跨行块注释：整行都在注释里则跳过；同时探测 lit-ok 裁决标记
    if (inBlockComment) {
      const end = line.indexOf('*/');
      if (end < 0) return; // 整行仍是注释
      if (/lit-ok\s*:/.test(line.slice(0, end))) approved = true;
      line = line.slice(end + 2);
      inBlockComment = false;
    }
    // 行内注释剥离（保留 lit-ok 判定）
    let code = '';
    let rest = line;
    for (;;) {
      const start = rest.indexOf('/*');
      if (start < 0) {
        code += rest;
        break;
      }
      code += rest.slice(0, start);
      const end = rest.indexOf('*/', start + 2);
      if (end < 0) {
        if (/lit-ok\s*:/.test(rest.slice(start))) approved = true;
        inBlockComment = true;
        break;
      }
      if (/lit-ok\s*:/.test(rest.slice(start, end))) approved = true;
      rest = rest.slice(end + 2);
    }
    if (approved) return;

    for (const m of code.matchAll(HEX_RE)) {
      violations.push({ line: idx + 1, match: m[0], text: code.trim() });
    }
    for (const m of code.matchAll(RGB_RE)) {
      const snippet = code.slice(m.index, m.index + 40);
      if (snippet.startsWith('rgba(var(')) continue; // 令牌引用
      if (NEUTRAL_RE.test(snippet)) continue; // 中性黑白/近黑
      violations.push({ line: idx + 1, match: snippet.split(')')[0] + ')', text: code.trim() });
    }
  });
  return violations;
}

/** CLI 主流程 */
function main() {
  const selftest = process.argv.includes('--selftest');
  if (selftest) {
    // 自检：构造一段包含三类情况的 CSS，验证"拦得住坏的、放得过好的"
    const sample = [
      '.bad1 { color: #e5322d; }                       /* 应被拦截：语义色字面量 */',
      '.bad2 { box-shadow: 0 0 8px rgba(0, 113, 227, 0.4); } /* 应被拦截：强调色 RGB 复述 */',
      '/* 注释里的 #ffffff 不算 */',
      '.ok1 { color: rgba(var(--danger-rgb), 0.42); } /* 令牌引用，放行 */',
      '.ok2 { background: rgba(0, 0, 0, 0.44); }      /* 中性黑，放行 */',
      '.ok3 { color: #fff; /* lit-ok: 白字测试 */ }    /* 人工裁决，放行 */',
    ].join('\n');
    const v = scanLiterals(sample);
    const lines = v.map((x) => x.line);
    const expectBad = [1, 2].every((l) => lines.includes(l));
    const expectOk = ![4, 5, 6].some((l) => lines.includes(l));
    if (expectBad && expectOk && v.length === 2) {
      console.log('✓ 自检通过：2 处违规被拦截（#e5322d、rgba(0,113,227,.4)），令牌引用/中性色/lit-ok 正确放行');
      return 0;
    }
    console.error(`✗ 自检失败：期望拦 2 放 3，实际 ${JSON.stringify(v)}`);
    return 1;
  }

  let total = 0;
  for (const file of SCAN_FILES) {
    const rel = path.relative(ROOT, file);
    if (!fs.existsSync(file)) {
      console.error(`  ✗ 文件不存在：${rel}`);
      total++;
      continue;
    }
    const violations = scanLiterals(fs.readFileSync(file, 'utf8'));
    for (const v of violations) {
      console.error(`  ✗ ${rel}:${v.line} 字面量颜色 ${v.match} —— ${v.text}`);
      total++;
    }
  }
  if (total) {
    console.error(`✗ 字面量颜色检测：${total} 处违规。改用令牌变量，或确属主题无关色时加 /* lit-ok: 理由 */ 标记`);
    return 1;
  }
  console.log(`  ✓ 字面量颜色检测通过（${SCAN_FILES.length} 个样式文件无绕开令牌的颜色）`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
