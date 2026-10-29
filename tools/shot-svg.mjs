// 临时取证：把生成的 SVG 图表截图成 PNG 以便人工核对渲染效果
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { launchHeadless, shot, sleep } from './cdp-util.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const names = process.argv.slice(2);

const session = await launchHeadless({ debugPort: 9355, width: 1000, height: 560 });
try {
  for (const n of names) {
    const file = path.join(ROOT, 'docs-evidence/figures', n + '.svg');
    await session.cdp.send('Page.navigate', { url: 'file:///' + file.replace(/\\/g, '/') });
    await sleep(600);
    const out = await shot(session.cdp, n + '.png', path.join(ROOT, 'docs-evidence/figures'));
    console.log('✓', out);
  }
} finally {
  await session.close();
}
