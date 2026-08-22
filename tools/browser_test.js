// headless smoke test of the port: serves this dir, opens index.html, starts the intro, screenshots at given seconds
const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = process.env.ROOT || __dirname;
const server = http.createServer((req, res) => {
  const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
  fs.readFile(p, (e, d) => { if (e) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(p); res.writeHead(200, { 'Content-Type': ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : 'application/octet-stream' }); res.end(d); });
});
(async () => {
  await new Promise(r => server.listen(0, r));
  const port = server.address().port;
  const exe = process.env.CHROME || `${process.env.HOME}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--autoplay-policy=no-user-gesture-required', '--use-angle=metal', '--ignore-gpu-blocklist'] });
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
  page.on('console', m => console.log('[page]', m.text()));
  page.on('pageerror', e => console.log('[pageerror]', e.message));
  await page.goto(`http://localhost:${port}/index.html`);
  await page.waitForTimeout(300);
  await page.screenshot({ path: 'bshot_launcher.png' });
  await page.evaluate(() => { window.__dsteps = 0; const o = HP.fn_1dab0; HP.fn_1dab0 = function () { window.__dsteps++; return o.apply(this, arguments); }; });
  await page.click('#go');
  const times = (process.argv[2] || '3,8').split(',').map(Number);
  let last = 0;
  for (const t of times) { await page.waitForTimeout((t - last) * 1000); last = t; await page.screenshot({ path: `bshot_${t}.png` }); const st = await page.evaluate(() => { const s = HP.stats || {}; const p = HP.player && HP.player.position(); return JSON.stringify({ status: document.getElementById('status').textContent, frames: s.frames, fps: s.frames ? (s.frames / ((performance.now() - s.t0) / 1000)).toFixed(1) : 0, audioPeak: s.audioPeak, pos: p && [p.order, p.row], A: [HP.rd32(0x15308), HP.rd32(0x1530c), HP.rd32(0x14514), HP.rd32(0x14fe0)], Bstart: HP.rd32(0x178d0), Bexit: HP.rd32(0x178c8), part: HP.part, dsteps: window.__dsteps }); }); console.log(`t=${t}s: ${st}`); }
  const fps = await page.evaluate(() => window.__fps || 'n/a');
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
