// Replay/validation harness (node): runs the JS port frame by frame, feeding the emulator's per-frame inputs
// (dt/ms, RNG state, song position) from a trace run's frames.jsonl, and compares each presented frame with the
// reference PNG of that run.
//   node replay.js REFDIR [--from N] [--to N] [--out DIR] [--snap] [--parts A,B,...] [--nosync]
// --snap: at every reference snapshot (snapNNNNN.bin.z) also diff the whole memory image and report the first
//         differing ranges (needs the same allocation sequence; heap diffs are reported separately).
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const png = require('./png.js');
const args = process.argv.slice(2);
const refdir = args[0];
function opt(name, def) { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; }
const FROM = +opt('--from', 1), TO = +opt('--to', 1e9), OUT = opt('--out', null), SNAP = args.includes('--snap'), NOSYNC = args.includes('--nosync');
const POSNEXT = args.includes('--posnext');   // song position for the update/exit check = the one at the NEXT flip
const DUMP = opt('--dump', null) ? opt('--dump', null).split(',').map(Number) : [];   // frames at which to dump M (mysnapNNNNN.bin) + the alloc map
if (OUT) fs.mkdirSync(OUT, { recursive: true });

require('./hplus_core.js');
const READLOG = opt('--readlog', null);   // binary log of (site, frame, order, row, tick) at every [0xe20] read of the original
let RL = null, rlIdx = 0, rlFed = 0, rlSkipped = 0;
if (READLOG) {
  const b = fs.readFileSync(READLOG); RL = new Uint32Array(b.buffer, b.byteOffset, b.length >> 2);
  const HP0 = globalThis.HP, o32 = HP0.rd32, os32 = HP0.rds32;
  // each read of [0xe20] by the port corresponds to one logged read of the original (same code, same order):
  // put the logged song position into the state block before returning the pointer
  const jsCount = {}; globalThis.RLDIAG = { jsCount };
  const feed = () => {
    const cur = globalThis.__nframe || 0;
    jsCount[cur] = (jsCount[cur] || 0) + 1;
    while (rlIdx * 5 < RL.length && RL[rlIdx * 5 + 1] < cur) { rlIdx++; rlSkipped++; }      // the original read more often: drop
    if (rlIdx * 5 < RL.length && RL[rlIdx * 5 + 1] === cur) {
      const p = o32(0xe20);
      HP0.wr32(p + 0x30, RL[rlIdx * 5 + 2]); HP0.wr32(p + 0x34, RL[rlIdx * 5 + 3]); HP0.wr32(p + 0x23, RL[rlIdx * 5 + 4]);
      rlIdx++; rlFed++;
    }
  };
  if (!args.includes('--exitonly')) {
    HP0.rd32 = (a) => { if (a === 0xe20) feed(); return o32(a); };
    HP0.rds32 = (a) => { if (a === 0xe20) feed(); return os32(a); };
  }
}
// --glitchlog FILE: (frame, rng1, rng2, [0x2ee60], [0x144fc]) logged at the noise routine fn_1579c entry: apply it there
const GLOG = opt('--glitchlog', null);
if (GLOG) {
  const gb = fs.readFileSync(GLOG); const G = new Uint32Array(gb.buffer, gb.byteOffset, gb.length >> 2);
  const byF = new Map(); for (let i = 0; i * 5 < G.length; i++) byF.set(G[i * 5], [G[i * 5 + 1], G[i * 5 + 2], G[i * 5 + 3], G[i * 5 + 4]]);
  const HPg = globalThis.HP; const orig1579c = null;
  globalThis.__glitchByFrame = byF;
  console.log('glitch-log entries:', byF.size);
}
// --exitonly: only the parts' exit-check reads are fed from the log (by site), everything else uses the per-flip policy
const EXIT_SITES = new Set([0x15f80, 0x184ba, 0x1bb5e, 0x1da90, 0x2020c]);
const exitByFrame = new Map();   // frame -> [order,row,tick] at the exit check of that frame
if (RL && args.includes('--exitonly')) {
  for (let i = 0; i * 5 < RL.length; i++) if (EXIT_SITES.has(RL[i * 5])) exitByFrame.set(RL[i * 5 + 1], [RL[i * 5 + 2], RL[i * 5 + 3], RL[i * 5 + 4]]);
  console.log('exit-check reads in log:', exitByFrame.size);
}
for (const f of ['hplus_engine.js', 'hplus_sound.js', 'hplus_main.js', 'hplus_fxA.js', 'hplus_fxB.js', 'hplus_fxC.js', 'hplus_fxD.js', 'hplus_fxE.js', 'hplus_fxF.js'])
  if (fs.existsSync(path.join(__dirname, f))) require('./' + f); else console.log('(missing ' + f + ')');
const HP = globalThis.HP;
const { rd32, wr32 } = HP;

// stubs for pieces not yet ported (so partial runs work)
const missing = [];
function stub(name, fn) { if (!HP[name]) { HP[name] = fn; missing.push(name); } }
stub('fn_2c1e6', () => {});
stub('fn_28f4a', () => { const p = HP.fn_29a(0x38010); });                    // engine init: mirror its allocation
stub('fn_d5b', () => { HP.fn_27c(0x20000); const p = HP.fn_29a(0xb340); wr32(0xe20, (p | 0xf) + 1); wr32(0xe10, 0); });  // sound init: mirror allocations
stub('fn_f50', () => {}); stub('fn_f80', () => {}); stub('fn_2cd46', () => {}); stub('fn_2cf9a', () => {});
for (const f of ['fn_1816a', 'fn_1b5eb', 'fn_1d39f', 'fn_1fde5', 'fn_231ca']) stub(f, () => {});
for (const f of ['fn_182fc', 'fn_1b8c0', 'fn_1d566', 'fn_1ffe5', 'fn_236ef']) stub(f, function* () { console.log(f + ' not ported — stopping'); throw new Error('stop'); });
if (missing.length) console.log('stubbed:', missing.join(' '));

// reference
const frames = fs.readFileSync(path.join(refdir, 'frames.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
const byFrame = new Map(frames.map(f => [f.frame, f]));

// memory + present hook
const image = HP.loadImageNode(path.join(__dirname, 'image32.bin'));
HP.init(image);
let presented = null;   // {buf offset}
HP.videoOut = function (bufOff, page) { presented = bufOff; };   // the engine's present calls HP.videoOut(bufferOffset, page)

if (process.env.PARTLOG) require('./partlog.js');
const allocs = [];
{ const o = HP.fn_29a; HP.fn_29a = function (n) { const p = o(n); allocs.push([p, n, (new Error().stack.split('\n')[2] || '').trim().replace(/\(.*\//, '(')]); return p; }; }
HP.mainInit({});
let nframe = 0, total = 0, bad = 0, worst = 0;
if (globalThis.__glitchByFrame) {
  const real = HP.fn_1579c;
  HP.fn_1579c = function () {
    const g = globalThis.__glitchByFrame.get(nframe);
    if (g) { wr32(0x28e38, g[0]); wr32(0x28e3c, g[1]); wr32(0x2ee60, g[2]); wr32(0x144fc, g[3]); }
    return real.apply(HP, arguments);
  };
}
// the parts clear [0x2ee54] in their prologue, so the frame's ms value is injected right before the present
const realPresent = HP.fn_2b0a8;
HP.fn_2b0a8 = function (esi, ebp) {
  const mn = byFrame.get(nframe + 2);   // this present = frame nframe+1; its [0x2ee54] = dt recorded at the next flip
  if (!NOSYNC && mn) wr32(0x2ee54, mn.dt);
  return realPresent.call(HP, esi, ebp);
};
const seq = HP.mainSequence();
function refFrameFile(n) { return path.join(refdir, 'f' + String(n).padStart(5, '0') + '.png'); }
function setInputs(n, afterFlip) {
  // called right after the present of frame n-1 (afterFlip = meta of that flip; null before the first frame):
  // [0x2ee54] = the ms value the original saw at present n (= dt recorded at flip n+1... see below),
  // RNG/song position = the state recorded at flip n-1 (the frame n render then continues from there).
  const m = byFrame.get(n), mn = byFrame.get(n + 1);
  if (!m) return false;
  if (!NOSYNC) {
    if (afterFlip) {
      wr32(0x28e38, afterFlip.rng[0]); wr32(0x28e3c, afterFlip.rng[1]);
      const src = POSNEXT ? m : afterFlip;
      const p = HP.DV.getUint32(0xe20, true);
      const ex = exitByFrame.get(n - 1);   // the exit check after flip n-1 (= before rendering frame n)
      if (ex) { wr32(p + 0x30, ex[0]); wr32(p + 0x34, ex[1]); wr32(p + 0x23, ex[2]); }
      else if (!RL || args.includes('--exitonly')) { wr32(p + 0x30, src.order); wr32(p + 0x34, src.row); wr32(p + 0x23, src.tick); }
    }   // (before the first frame the position stays as the player start left it: order 0)
  }
  return true;
}
function compare(n) {
  const f = refFrameFile(n);
  if (!fs.existsSync(f) || presented == null) return;
  const ref = png.decode(fs.readFileSync(f));
  const mine = png.bgrxToRGB(HP.M.subarray(presented, presented + 320 * 240 * 4), 320, 240);
  let diff = 0, maxd = 0;
  for (let i = 0; i < mine.length; i += 3) { const d = Math.abs(mine[i] - ref.rgb[i]) + Math.abs(mine[i + 1] - ref.rgb[i + 1]) + Math.abs(mine[i + 2] - ref.rgb[i + 2]); if (d) { diff++; if (d > maxd) maxd = d; } }
  total++; if (diff) bad++; if (diff > worst) worst = diff;
  if (diff || n % 50 === 0) console.log(`frame ${n}: ${diff} px differ (max |d| ${maxd})`);
  if (OUT && (diff || n % 25 === 0)) {
    fs.writeFileSync(path.join(OUT, 'j' + String(n).padStart(5, '0') + '.png'), png.encodeRGB(320, 240, mine));
    if (diff) { const dimg = new Uint8Array(mine.length); for (let i = 0; i < mine.length; i++) dimg[i] = Math.min(255, Math.abs(mine[i] - ref.rgb[i]) * 4); fs.writeFileSync(path.join(OUT, 'd' + String(n).padStart(5, '0') + '.png'), png.encodeRGB(320, 240, dimg)); }
  }
}
function compareSnapshot(n) {
  const f = path.join(refdir, 'snap' + String(n).padStart(5, '0') + '.bin.z');
  if (!fs.existsSync(f)) return;
  const ref = zlib.inflateSync(fs.readFileSync(f));
  const M = HP.M; let ranges = [], start = -1, count = 0;
  const end = Math.min(ref.length, M.length);
  // regions written asynchronously by IRQs / the player / PMODE in the original (not meaningful to compare)
  const VOL = [[0, 0x100], [0x31c, 0x330], [0x658, 0x670], [0x9c8, 0xb00], [0x2ee3d, 0x2ee64], [0x32800, 0x32c20], [0x3f090, 0x5f090], [0x1283b0, 0x1336f0]];
  const vol = (a) => { for (const r of VOL) if (a >= r[0] && a < r[1]) return true; return false; };
  for (let i = 0; i < end; i++) {
    const d = M[i] !== ref[i] && !vol(i);
    if (d && start < 0) start = i;
    if (!d && start >= 0) { ranges.push([start, i]); start = -1; }
    if (d) count++;
  }
  if (start >= 0) ranges.push([start, end]);
  ranges.sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
  console.log(`snapshot ${n}: ${count} bytes differ (non-volatile); ${ranges.length} ranges, largest: ` + ranges.slice(0, 16).map(r => r[0].toString(16) + '-' + r[1].toString(16)).join(' '));
}
// the generator yields right after present; the inputs for frame N must be set before present N.
// We set them at the start (for frame 1) and right after each yield for the next frame.
const t0 = Date.now();
try {
  setInputs(1, null);
  for (const _ of seq) {
    nframe++; globalThis.__nframe = nframe;
    if (nframe >= FROM && nframe <= TO) compare(nframe);
    if (SNAP) compareSnapshot(nframe);
    if (DUMP.includes(nframe)) { fs.writeFileSync('mysnap' + String(nframe).padStart(5, '0') + '.bin', HP.M.subarray(0, rd32(8))); fs.writeFileSync('allocs.json', JSON.stringify(allocs)); console.log('dumped frame ' + nframe); }
    if (nframe >= TO || !byFrame.has(nframe + 1)) break;
    presented = null;
    setInputs(nframe + 1, byFrame.get(nframe));
  }
} catch (e) { if (e.message !== 'stop') throw e; }
if (RL && process.env.RLDIAG) {
  const logCount = {}, sitesByFrame = {};
  for (let i = 0; i * 5 < RL.length; i++) { const f = RL[i * 5 + 1]; logCount[f] = (logCount[f] || 0) + 1; (sitesByFrame[f] = sitesByFrame[f] || []).push(RL[i * 5].toString(16)); }
  let shown = 0;
  for (let f = 0; f <= nframe && shown < 12; f++) { const a = globalThis.RLDIAG.jsCount[f] || 0, b = logCount[f] || 0; if (a !== b) { console.log('frame ' + f + ': js reads ' + a + ' vs log ' + b + '  sites: ' + (sitesByFrame[f] || []).join(' ')); shown++; } }
}
console.log(`done: ${nframe} frames run, ${total} compared, ${bad} differ, worst ${worst} px, ${((Date.now() - t0) / 1000).toFixed(1)} s` + (RL ? ` (readlog: fed ${rlFed}, skipped ${rlSkipped}, unused ${(RL.length / 5 - rlIdx) | 0})` : ''));
