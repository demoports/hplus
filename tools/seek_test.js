const { chromium } = require('playwright-core');
const http = require('http'), fs = require('fs'), path = require('path'); const ROOT = process.env.ROOT || __dirname;
const server = http.createServer((req, res) => { const p = path.join(ROOT, decodeURIComponent(req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0])); fs.readFile(p, (e, d) => { if (e) { res.writeHead(404); res.end(); return; } const ext = path.extname(p); res.writeHead(200, { 'Content-Type': ext === '.html' ? 'text/html' : ext === '.js' ? 'text/javascript' : 'application/octet-stream' }); res.end(d); }); });
(async () => {
  await new Promise(r => server.listen(0, r)); const port = server.address().port;
  const exe = process.env.HOME + '/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
  const browser = await chromium.launch({ executablePath: exe, headless: true, args: ['--autoplay-policy=no-user-gesture-required'] });
  const page = await browser.newPage({ viewport: { width: 960, height: 720 } });
  page.on('pageerror', e => console.log('[pageerror]', e.message)); page.on('console', m => { if (m.type() === 'error') console.log('[console]', m.text()); });
  await page.goto(`http://localhost:${port}/index.html`); await page.waitForTimeout(300); await page.click('#go');
  const st = async (label) => console.log(label, await page.evaluate(() => JSON.stringify({ t: app.time().toFixed(2), part: HP.part, idx: HP.partIndex, frames: HP.stats.frames, status: document.getElementById('status').textContent, pos: HP.player && [HP.player.position().order, HP.player.position().row], A: [HP.rd32(0x15308), HP.rd32(0x1530c)] })));
  await page.waitForTimeout(12000); await st('t=12s');
  await page.keyboard.press('ArrowRight'); await page.waitForTimeout(1500); await st('after >> 5');
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(3000); await st('after << 10');
  // jump ahead a lot (into part B) using seek(+55)
  await page.evaluate(() => app.seek(55)); await page.waitForTimeout(12000); await st('after +55');
  await page.keyboard.press('ArrowLeft'); await page.waitForTimeout(4000); await st('after << 5 (in B)');
  await page.evaluate(() => app.seek(-30)); await page.waitForTimeout(8000); await st('after -30 (cross into A)');
  await page.waitForTimeout(3000); await st('+3s playing');
  await page.screenshot({ path: 'bshot_seek.png' });
  await browser.close(); server.close();
})().catch(e => { console.error(e); process.exit(1); });
