// 探一下这台机器能不能用真 GPU 出图（不走 SwiftShader）。
// 能用就走硬件，录出来的清晰度明显高一档。
import { chromium } from 'playwright-core';

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL = 'http://127.0.0.1:4173/?tier=2&touch=0&cine=1';

async function probe(label, args) {
  const b = await chromium.launch({ executablePath: CHROME, args });
  const page = await (await b.newContext({ viewport: { width: 1280, height: 720 } })).newPage();
  let renderer = 'n/a';
  try {
    await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForFunction(() => !!window.gift188, { timeout: 90000 });
    renderer = await page.evaluate(() => {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      if (!gl) return 'no-webgl';
      const d = gl.getExtension('WEBGL_debug_renderer_info');
      return d ? String(gl.getParameter(d.UNMASKED_RENDERER_WEBGL)) : 'renderer-hidden';
    });
  } catch (e) {
    renderer = 'FAILED: ' + String(e).slice(0, 60);
  }
  console.log(`${label.padEnd(18)} ${renderer}`);
  await b.close();
  return renderer;
}

await probe('swiftshader', ['--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist']);
await probe('hardware', ['--ignore-gpu-blocklist', '--enable-gpu-rasterization', '--use-angle=d3d11']);
await probe('hardware2', []);
