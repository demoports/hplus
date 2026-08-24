// hplus port — browser glue: loads/unpacks HPLUS.EXE, drives the part sequencer with real time,
// streams the music player into WebAudio, maps keys, presents frames on a canvas, seeks (+-5 s).
import { HP } from './hplus_core.js';
import { HP_DATA_GZ_B64 } from './hplus_data.js';

// the emulated code and the effects register themselves on HP when they load
import './hplus_engine.js';
import './hplus_sound.js';
import './hplus_main.js';
import './hplus_fxA.js';
import './hplus_fxB.js';
import './hplus_fxC.js';
import './hplus_fxD.js';
import './hplus_fxE.js';
import './hplus_fxF.js';

export { HP };

const W = 320, H = 240, RATE = 44100;

// the intro's data = the WWPACK-unpacked 32-bit image of HPLUS.EXE, embedded gzipped (hplus_data.js).
// (to regenerate it from the original exe, see tools/wwpack.js)
async function loadData() {
  if (typeof HP_DATA_GZ_B64 !== 'string') throw new Error('hplus_data.js not loaded');
  const s = atob(HP_DATA_GZ_B64), gz = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) gz[i] = s.charCodeAt(i);
  const ab = await new Response(new Blob([gz]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  return new Uint8Array(ab);
}

function setSongPosition(pos) {       // what the effects read: [0xe20]+0x30 order, +0x34 row, +0x23 tick
  if (!pos) return;
  const p = HP.rd32(0xe20);
  HP.wr32(p + 0x30, pos.order); HP.wr32(p + 0x34, pos.row); HP.wr32(p + 0x23, pos.tick);
}
function blitTo(ctx2d, imgData, pix, bufOff) {
  const M32 = new Uint32Array(HP.M.buffer, bufOff, W * H);
  for (let i = 0; i < W * H; i++) { const v = M32[i]; pix[i] = 0xff000000 | ((v & 0xff) << 16) | (v & 0xff00) | ((v >>> 16) & 0xff); }
  ctx2d.putImageData(imgData, 0, 0);
}
let previewGen = 0;                     // bumping this cancels a running preview

// Render one frame of the intro (the one presented at `seconds` of music, simulated at 25 fps, no audio)
// into the canvas — the launcher's background. Runs in slices so the page stays responsive.
HP.preview = function (canvas, seconds, done) {
  const my = ++previewGen;
  const ctx2d = canvas.getContext('2d');
  canvas.width = W; canvas.height = H;
  const imgData = ctx2d.createImageData(W, H), pix = new Uint32Array(imgData.data.buffer);
  let last = null;
  loadData().then((data) => {
    if (my !== previewGen) return;
    HP.init(data);
    HP.videoOut = (off) => { last = off; };
    HP.fn_2c1e6 = () => {}; HP.onPartEntry = null;
    return new Promise(r => setTimeout(r, 30));
  }).then(() => {
    if (my !== previewGen) return;
    HP.mainInit({});
    const player = HP.player, seq = HP.mainSequence();
    seq.next();
    const step = () => {
      if (my !== previewGen) return;
      const t0 = performance.now();
      while (performance.now() - t0 < 25) {
        if (player.position().frames / RATE >= seconds) { finish(); return; }
        for (let k = 0; k < 40; k++) HP.timerTick();
        player.render(new Int16Array(1764 * 2), 1764);   // 40 ms of music, in lockstep
        setSongPosition(player.position());
        if (seq.next().done) { finish(); return; }
      }
      setTimeout(step, 0);
    };
    const finish = () => { if (last != null) blitTo(ctx2d, imgData, pix, last); if (done) done(); };
    step();
  }).catch((e) => console.error(e));
};

HP.start = function (canvas, setStatus, opts) {
  opts = opts || {};
  previewGen++;                         // cancel a running preview: from here on the memory image is ours
  const ctx2d = canvas.getContext('2d');
  canvas.width = W; canvas.height = H;
  const imgData = ctx2d.createImageData(W, H);
  const pix = new Uint32Array(imgData.data.buffer);
  let running = true, paused = false, raf = 0, audio = null, proc = null;
  let seq = null, lastT = 0, msAcc = 0;
  HP.stats = { frames: 0, audioPeak: 0, t0: performance.now() };

  let blit = true;                      // false while fast-forwarding
  function present(bufOff) {           // called by the engine's fn_2c9f4 port
    if (blit) blitTo(ctx2d, imgData, pix, bufOff);
  }

  // --- audio: the player renders on the main thread into a ScriptProcessor; the song position the effects see is
  // the one audible now (positionAtFrame on the audio clock, relative to a base that seeking resets).
  let player = null, audioStarted = false, seeking = null;
  let baseFrame = 0, baseTime = 0;      // player output frame index that was audible at audio time baseTime
  function audioSetup() {
    const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
    audio = new AC({ sampleRate: RATE });
    player = HP.player;                 // created by HP.fn_f50 (the player port) during mainInit
    const bufFrames = 2048;
    proc = audio.createScriptProcessor(bufFrames, 0, 2);
    const tmp = new Int16Array(bufFrames * 2);
    // pre-render the first chunk so the player's position log exists from the very first frame
    // (the original's player has ticked by the time the first update steps run)
    let pre = new Int16Array(bufFrames * 2); player.render(pre, bufFrames);
    proc.onaudioprocess = (e) => {
      const L = e.outputBuffer.getChannelData(0), R = e.outputBuffer.getChannelData(1);
      if (!player || paused || seeking) { L.fill(0); R.fill(0); return; }
      if (pre) { tmp.set(pre); pre = null; }
      else player.render(tmp, bufFrames);
      let pk = 0;
      for (let i = 0; i < bufFrames; i++) { L[i] = tmp[2 * i] / 32768; R[i] = tmp[2 * i + 1] / 32768; const a = Math.abs(tmp[2 * i]); if (a > pk) pk = a; }
      HP.stats.audioPeak = pk;
    };
    proc.connect(audio.destination);
    if (audio.state !== 'running' && audio.resume) audio.resume();
    // the position timeline starts when the music is started (the original's player is ticked by the timer
    // IRQ from that moment on; the DMA output lags it), not when the first audio buffer becomes audible
    baseFrame = 0; baseTime = audio.currentTime; audioStarted = true;
  }
  function audibleFrame() {
    let f = Math.floor(baseFrame + (audio.currentTime - baseTime) * RATE);
    const rendered = player.position().frames;
    if (f < baseFrame) f = baseFrame; if (f > rendered) f = rendered;
    return f;
  }
  const setPosition = setSongPosition;
  function syncPlayerPosition() {
    if (!audio || !player || !audioStarted) return;
    setPosition(player.positionAtFrame(audibleFrame()));
  }
  const musicTime = () => player ? player.position().frames / RATE : 0;   // seconds of music rendered so far

  // --- seeking: forward = fast-forward the simulation (frames are computed but not shown); backward = restore the
  // latest snapshot before the target and fast-forward from there. Snapshots: the program memory (as blocks that
  // differ from the post-init baseline) + the player's state, taken at every part entry and every 10 s.
  const SNAP_EVERY = 10, BLOCK = 16384;
  let baseline = null, snapshots = [], lastSnapTime = -1;
  function takeSnapshot(entry, partIndex) {
    const M = HP.M, end = Math.min(M.length, HP.rd32(8) + BLOCK);        // heap end
    if (!baseline) baseline = M.slice(0, end);
    const blocks = [];
    const n32 = Math.min(end, baseline.length) >> 2;
    const M32 = new Int32Array(M.buffer, 0, n32), B32 = new Int32Array(baseline.buffer, 0, n32);
    for (let b = 0; b * BLOCK < end; b++) {
      const lo = b * (BLOCK >> 2), hi = Math.min(lo + (BLOCK >> 2), n32);
      let diff = hi <= lo;
      for (let i = lo; i < hi; i++) if (M32[i] !== B32[i]) { diff = true; break; }
      if (diff) blocks.push([b * BLOCK, M.slice(b * BLOCK, Math.min((b + 1) * BLOCK, end))]);
    }
    snapshots.push({ t: musicTime(), entry, partIndex, blocks, player: player.saveState(), part: HP.part, run: HP.partRun });
    if (snapshots.length > 40) {   // keep memory bounded: drop the oldest non-entry snapshot
      const i = snapshots.findIndex(s => !s.entry); if (i >= 0) snapshots.splice(i, 1);
    }
  }
  function restoreSnapshot(s) {
    HP.M.set(baseline, 0);
    for (const [off, data] of s.blocks) HP.M.set(data, off);
    player.restoreState(s.player);
    HP.part = s.part; HP.partIndex = s.partIndex; HP.partRun = s.run;
  }
  HP.onPartEntry = (i) => {
    if (!player) return;
    const t = musicTime();
    if (snapshots.some(x => x.entry && x.partIndex === i && Math.abs(x.t - t) < 0.01)) return;   // (re-entry after a restore)
    takeSnapshot(true, i);
  };

  function simulateFrame(dtMs) {       // one frame of the intro with a given frame time, music advanced in lockstep
    for (let k = 0; k < dtMs; k++) HP.timerTick();
    const n = Math.ceil(dtMs * RATE / 1000);
    player.render(new Int16Array(n * 2), n);
    setPosition(player.position());
    const r = seq.next();
    HP.stats.frames++;
    return !r.done;
  }
  function seek(delta) {
    if (!player || !audio) return musicTime();
    const now = musicTime();                                   // (while seeking: the simulated time reached so far)
    const target = Math.max(0, (seeking ? seeking.target : now) + delta);
    if (target < now) {
      let s = null; for (const x of snapshots) if (x.t <= target + 0.01 && (!s || x.t > s.t)) s = x;
      if (!s) return now;
      if (!s.entry && s.run !== HP.partRun) {   // a mid-part snapshot of an earlier run of a part: restart from that part's entry
        const e = snapshots.filter(x => x.entry && x.t <= s.t).pop(); if (!e) return now; s = e;
      }
      restoreSnapshot(s);
      blit = false;
      if (s.entry) {                    // restart the part: its prologue runs again on the restored memory, and — as at
        seq = HP.mainSequence(s.partIndex);   // launch — before the music is advanced (it latches the song position)
        seq.next();
      }
      snapshots = snapshots.filter(x => x.t < s.t || x === s);
      lastSnapTime = s.t;
    }
    seeking = { target };
    blit = false;
    return target;
  }
  function seekStep(budgetMs) {        // run part of a pending seek; returns true when done
    const t0 = performance.now();
    while (performance.now() - t0 < budgetMs) {
      if (musicTime() >= seeking.target) { finishSeek(); return true; }
      if (!simulateFrame(HP.part === 'D' ? 33 : 40)) { finishSeek(); stop(true); return true; }
    }
    return false;
  }
  function finishSeek() {
    seeking = null; blit = true;
    baseFrame = player.position().frames; baseTime = audio.currentTime;   // audio continues from the new position
    msAcc = 0;
  }

  // Frame pacing. All parts but one scale their animation by the measured frame time (14 ms steps), so the
  // display rate does not matter for them (it is capped at maxFps so that >60 Hz displays still get >= 1
  // step per frame). Part D (the ray-cast tunnel) is the exception: the original advances it a fixed 3 steps
  // per presented frame, so its speed is the frame rate of the machine — we present it at opts.dFps
  // (default 30, about what a fast 1998 PC managed there) instead of the display rate.
  const maxFps = opts.maxFps || 60, dFps = opts.dFps || 30;
  let lastPresent = 0;
  function frame(t) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    if (!lastT) lastT = t;
    let dt = Math.min(200, t - lastT); lastT = t;
    if (paused) return;
    if (seeking) { seekStep(30); return; }
    msAcc += dt;
    while (msAcc >= 1) { HP.timerTick(); msAcc -= 1; }   // the 1 kHz timer IRQ: [0x2ee54]++ etc.
    const minInterval = 1000 / (HP.part === 'D' ? dFps : maxFps) - 1;
    if (t - lastPresent < minInterval) return;           // not yet time for the next frame
    lastPresent = t;
    syncPlayerPosition();
    const mt = musicTime();
    if (mt - lastSnapTime >= SNAP_EVERY) { lastSnapTime = mt; takeSnapshot(false, HP.partIndex); }
    const r = seq.next();                                // runs until the next present (the part yields after it)
    HP.stats.frames++;
    if (r.done) stop(true);
  }
  function stop(ended) {
    if (!running) return;
    running = false; cancelAnimationFrame(raf);
    try { HP.mainExit(); } catch (e) {}
    if (proc) proc.disconnect();
    if (audio) audio.close();
    snapshots = []; baseline = null;
    if (opts.onEnd) opts.onEnd(ended);
  }

  loadData().then((data) => {
    HP.init(data);
    HP.videoOut = present;
    HP.fn_2c1e6 = () => {};            // DOS prints
    setStatus && setStatus('precalculating…');
    return new Promise(r => setTimeout(r, 20));
  }).then(() => {
    HP.mainInit({});                   // precalc + starts the player (HP.player)
    player = HP.player;
    seq = HP.mainSequence();
    // The original enters the first part right after starting the music, i.e. with the song still at
    // order 0 (before the player's first tick): run the part's prologue + first frame now, before the
    // audio clock (and the position sync) starts, so the part latches start order 0 like the original.
    seq.next();
    audioSetup();
    lastSnapTime = 0;
    setStatus && setStatus('');
    if (opts.onStart) opts.onStart();
    raf = requestAnimationFrame(frame);
  }).catch((e) => { setStatus && setStatus(e.message); console.error(e); });

  return {
    stop: () => stop(false),
    pause: () => { paused = !paused; HP.key(paused ? HP.SC_SPACE : HP.SC_SPACE | 0x80); },
    seek,                              // seek(+-seconds) -> target time (music seconds); performed over the next frames
    time: musicTime,
    key: (sc) => HP.key(sc),
    fps: () => { HP.key(HP.SC_BACKTICK); HP.key(HP.SC_BACKTICK | 0x80); },
  };
};
