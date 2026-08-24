// hplus port — effect E (0x1f87e..0x203ea): textured 3D object with a particle field and
// "light rays" pass (fn_1fd0c), music-driven camera paths; init fn_1fde5, run fn_1ffe5(eax, ebx).
//
// External functions used (register-order args):
//   alloc(eax=size)                      core: high-memory bump allocator
//   rand(eax=range)                   core: RNG
//   copyChunk(esi=chunk, edi=dst) -> edi   part A: copy length-prefixed chunk + 0 terminator
//   HP.fn_1570b(esi=&k, ebp=&cam)            part A: camera smoothing (6 floats)
//   blueSmear(ecx, edx, edi=buffer)        part B: blend/fade of a 320x240x32 buffer (ecx/edx = 255-x / x weights)
//   buildObject(eax, ebx, ecx, edx=-1, esi, edi=chunk data, ebp=object)   engine: build object from chunk data (ecx unused)
//   objectInit(ecx, ebp=object)             engine: object init
//   HP.fn_28ed8(eax=1, ebp=object)           engine
//   cameraFromSpline(ebx=&angles, esi=&cam, edi=path, ebp=object)   engine: camera/path step
//   renderObject(esi=&cam, ebp=object, edi=dest buffer)         engine: render object (note: engine's arg order)
//   stirRng()                            engine (called at the start of each update step)
//   splineAdvance(ebx=walker, ecx=speed bits)  engine: advance the spline walker
//   present(esi=buffer, ebp=object)      engine: present
// Player state via [0xe20]: +0x30 order, +0x34 row.
import { HP } from './hplus_core.js';
import { ADDR } from './hplus_addr.js';

// functions this file calls from elsewhere (forwarding, so the HP entry stays late-bound
// and tools/replay.js can still swap it at runtime)
const alloc            = (...a) => HP.fn_29a(...a);     // core: fn_29a — high memory
const rand             = (...a) => HP.fn_2c2c8(...a);   // core: fn_2c2c8 — eax = range
const buildObject      = (...a) => HP.fn_29060(...a);   // engine: fn_29060 — build object from chunk data
const cameraFromSpline = (...a) => HP.fn_2afd3(...a);   // engine: fn_2afd3 — (ebx=walker, esi=camera, edi=path base, ebp=scene)
const objectInit       = (...a) => HP.fn_2a094(...a);   // engine: fn_2a094
const present          = (...a) => HP.fn_2b0a8(...a);   // engine: fn_2b0a8
const renderObject     = (...a) => HP.fn_2a2ac(...a);   // engine: fn_2a2ac — (esi=camera, ebp=object, edi=dest buffer)
const splineAdvance    = (...a) => HP.fn_2b037(...a);   // engine: fn_2b037 — (ebx=walker, ecx=speed factor bits): advance t, wrap keys
const stirRng          = (...a) => HP.fn_2af3a(...a);   // engine: fn_2af3a — stir the RNG + particle texture level override
const copyChunk        = (...a) => HP.fn_156ff(...a);   // fxA: fn_156ff — copy a length-prefixed chunk
const blueSmear        = (...a) => HP.fn_18135(...a);   // fxB: fn_18135 — horizontal smear of the blue byte of a 320x240x32 buffer

// this part's own globals (0x1ef24..0x1f778)
const PART = Object.freeze({
  frontBuf: 0x1ef24,        // 320x240x32; swapped with backBuf after present
  backBuf : 0x1ef28,
  pathIdx : 0x1f51c,        // 0..3, advances when the song order changes
  rayFlag : 0x1f778,        // draw the "light rays" pass
});

const { rd8, rd16, rd32, rds32, wr8, wr16, wr32, rdf, wrf, roundHalfEven } = HP;

// fn_1f87e(esi, edi, ebp) -> edi: randomize 0x40 particle records of 0x2c bytes at edi (edi advances!)
HP.fn_1f87e = function (esi, edi, ebp) {
  for (let c = 0x40; c > 0; c--) {
    let eax = (rand(0x190) - 0xc8) | 0;
    wr32(0x1ef34, eax); wrf(edi + 8, eax);
    eax = ((rand(0x28) + ebp) | 0) >> 4;
    wr32(0x1ef34, eax); wrf(edi + 4, eax);
    eax = ((rand(0x28) + esi) | 0) >> 4;
    wr32(0x1ef34, eax); wrf(edi + 0xc, eax);
    wr32(0x1ef34, -4); wrf(edi + 0x20, -4);
    edi += 0x2c;
  }
  return edi;
};

// fn_1f92c(edi=records, ebp=axis offset): move 0xc0 particles along axis ebp with wrap, scale x/z by the
// distance to the wrap plane (records copy at [0x1f8f4] holds the original x/z)
HP.fn_1f92c = function (edi, ebp) {
  let esi = rd32(0x1f8f4);
  let ia = 0;
  const c924 = rdf(0x1f924), c928 = rdf(0x1f928), c920 = rdf(0x1f920), c8f8 = rdf(0x1f8f8);
  for (let c = 0xc0; c > 0; c--) {
    const step = rdf(ia * 4 + 0x1f8fc) * c920;      // x87 intermediates as doubles
    let v = rdf(edi + ebp) + step;
    wrf(0x1f91c, v - c924);
    if (!(rd32(0x1f91c) & 0x80000000)) v = v + c928;
    wrf(edi + ebp, v);                               // fst (v itself stays unrounded)
    const w = -(v - c924) * c8f8;
    wrf(edi + 4, w * rdf(esi + 4));
    wrf(edi + 0xc, w * rdf(esi + 0xc));
    ia = (ia + 1) & 7;
    edi += 0x2c; esi += 0x2c;
  }
};

// fn_1f9b0: one light ray. Start (x=[0x1f99c], y=[0x1f9a0], 16.16), x step [0x1f9a4] per row upwards;
// walk up until a pixel with alpha 0xff is hit, then brighten the pixels along the rest of the ray by
// (remaining count >> [0x1f9ac]) with saturation (table at 0x1facc).
HP.fn_1f9b0 = function () {
  const M = HP.M;
  const N = rd8(0x1f9ac) & 31;                       // self-modified shift count (byte at 0x1fa49)
  wr8(0x1fa49, rd8(0x1f9ac));
  const dx = rds32(0x1f9a4), x0 = rds32(0x1f99c);
  let eax = (dx >= 0) ? (0x1400000 - x0) | 0 : (-x0) | 0;
  eax = Math.trunc(eax / dx) | 0;
  const ybx = rds32(0x1f9a0) >> 16;
  if (eax >= ybx) eax = ybx;
  wr32(0x1f9a8, eax);
  let edi = ((ybx * 5) << 8) + rd32(PART.frontBuf);
  let ebx = x0;
  let found = false;
  for (;;) {
    const ebp = ebx >> 16;
    if (M[edi + ebp * 4 + 3] === 0xff) { found = true; break; }
    ebx = (ebx + dx) | 0; edi -= 0x500;
    wr32(0x1f9a8, rds32(0x1f9a8) - 1);
    if (rds32(0x1f9a8) === 0) return;
  }
  edi += 0x500;
  do {
    const ebp = ebx >> 16;
    const esi = rd32(0x1f9a8) >>> N;
    edi -= 0x500;
    ebx = (ebx + dx) | 0;
    const p = edi + ebp * 4;
    const a = M[M[p] + esi + 0x1facc], c = M[M[p + 1] + esi + 0x1facc], d = M[M[p + 2] + esi + 0x1facc];
    wr32(0x1f9a8, rds32(0x1f9a8) - 1);
    M[p] = a; M[p + 1] = c; M[p + 2] = d;
  } while (rds32(0x1f9a8) !== 0);
};

// fn_1fa8a: saturation table [0x1facc + i] = min(i, 255), i < 0x240
HP.fn_1fa8a = function () {
  for (let i = 0; i < 0x240; i++) wr8(0x1facc + i, i < 0xff ? i : 0xff);
};

// fn_1fd0c: the rays pass — 300 rays from a random spot near the horizon
HP.fn_1fd0c = function () {
  wr32(0x1fac8, -0x1b58); wr32(0x1fab0, 0xa00000);
  if (rds32(0x1f774) === 2) { wr32(0x1fac8, 0x4e20); wr32(0x1fab0, 0x8c0000); }
  // (the original leaks one x87 stack entry per call: sin(A) stays on the stack; harmless)
  const sA = Math.sin(rdf(0x1f508));
  let t = (1 + sA); t = t * t * rds32(0x1fac0);
  wr32(0x1fac4, roundHalfEven(t) | 0);
  let v = Math.abs(Math.sin(rdf(0x1f500) * rdf(0x1fabc)) * Math.cos(rdf(0x1f504))) * rdf(0x1fab8);
  v = ((v + 1) + 1) + 1;
  wr32(0x1f9ac, roundHalfEven(v) | 0);
  wr32(0x1fab4, 0x12c);
  do {
    wr32(0x1f99c, (rand(0x280000) + rd32(0x1fab0)) | 0);
    wr32(0x1f9a0, (rand(0xa0000) + 0x820000) | 0);
    let eax = (rand(0x2710) + rds32(0x1fac8)) | 0;
    if (eax === 0) eax = 1;
    wr32(0x1f9a4, eax);
    HP.fn_1f9b0();
    wr32(0x1fab4, rds32(0x1fab4) - 1);
  } while (rds32(0x1fab4) !== 0);
};

// fn_1fde5: part E precalc. Split: head (engine-dependent object build) + tail (pure), so the tail can be
// diffed against the emulator on its own.
HP.fn_1fde5 = function () {
  let eax = alloc(0xb6010); eax = (eax | 0xf) + 1;
  wr32(PART.frontBuf, eax); eax += 0x4b000; wr32(PART.backBuf, eax); eax += 0x4b000;
  wr32(0x23fd0, 0);
  copyChunk(0x1dcb4, rd32(PART.frontBuf));
  buildObject(0, 1, 0, 0xffffffff, rd32(0x1ef2c), rd32(PART.frontBuf), 0x1ef38);  // (eax, ebx, ecx(unused), edx, esi, edi, ebp)
  copyChunk(0x1eb1b, rd32(PART.frontBuf));
  buildObject(3, 9, 0, 0xffffffff, rd32(0x1ef2c), rd32(PART.frontBuf), 0x1ef38);
  wr32(0x1efa4, 1); wr32(0x1ef60, 0);
  wr32(0x1ef64, 0x1a); wr32(0x1ef65, 0x1a); wr32(0x1ef66, 0x28);   // overlapping dword stores, keep order
  HP.fill32(rd32(PART.frontBuf), 0, 0x25800);
  objectInit(0xc0, 0x1ef38);          // (ecx, ebp)
  HP.fn_28ed8(1, 0x1ef38);             // (eax, ebp)
  HP.fn_1fde5_tail();
};
HP.fn_1fde5_tail = function () {      // 0x1feda .. 0x1ffe4
  const M = HP.M;
  let edi = rd32(0x1f44c);
  edi = HP.fn_1f87e(0x56, edi, 0x2b);
  edi = HP.fn_1f87e(-0x20, edi, -0x7f);
  edi = HP.fn_1f87e(-0x70, edi, 0x4b);
  let eax = Math.imul(rds32(0x1efa0), 0x2c);
  const ecx = eax;
  eax = alloc(eax + 0x10); eax = (eax | 0xf) + 1;
  wr32(0x1f8f4, eax);
  HP.copy(eax, rd32(0x1f44c), ecx);
  wr32(0x1efc0, rd32(0x1f4c8)); wr32(0x1efc4, rd32(0x1f4cc)); wr32(0x1efc8, rd32(0x1f4d8)); wr32(0x1ef5c, rd32(0x1f4dc));
  HP.fn_1fa8a();
  wr32(ADDR.rngS1, 0x1010102); wr32(ADDR.rngS2, 0x9192919);      // RNG reseed
  // stamp an 8x8 grid of 16x16 marks (pattern at 0x1f77e) into the 256-wide 8-bit texture at [0x1f398]
  for (let edx = 7; edx >= 0; edx--) {
    for (let ecx2 = 7; ecx2 >= 0; ecx2--) {
      let p = (ecx2 << 5) + (edx << 13) + ((edx & 1) << 4) + rd32(0x1f398);
      let esi = 0x1f77e;
      for (let r = 0x10; r > 0; r--) {
        for (let c = 0x10; c > 0; c--) {
          const bh = M[esi];
          if (bh !== 0) {
            const k = (3 * bh + 0xa) & 0xff;
            let al = M[p] - k;
            al = (al < 0) ? 0xff : al;           // sub/sbb/or: borrow -> 0xff
            M[p] = (al + 1) & 0xff;              // inc al
          }
          esi++; p++;
        }
        p += 0xf0;
      }
    }
  }
};

// fn_20240: one update step (14 ms)
HP.fn_20240 = function () {
  if (rd8(ADDR.keyPause) === 1) return;
  stirRng();
  splineAdvance(0x1f4b4, rd32(0x1ef2c));          // (ebx=angles, ecx=matrix)
  HP.fn_20262();
};
HP.fn_20262 = function () {                       // pure tail of the update step
  HP.fn_1f92c(rd32(0x1f44c), 8);
  if (rds32(PART.pathIdx) !== 3) {
    const esi = rd32(ADDR.playerState);
    const eax = rd32(esi + 0x30);
    if (eax !== rd32(0x1f520)) {
      wr32(0x1f520, eax);
      wr32(PART.pathIdx, (rd32(PART.pathIdx) + 1) & 3);
      const ebx = rd32(PART.pathIdx);
      if (rd32(ebx * 4 + 0x1f544) !== rd32(ebx * 4 + 0x1f540)) {
        const s = rd32(PART.pathIdx);
        wr32(0x1f4b8, rd32(s * 4 + 0x1f534)); wr32(0x1f4c0, rd32(s * 4 + 0x1f524));
        wr32(0x1f4bc, 0); wrf(0x1f4b4, 0);
      }
    }
  }
  wr32(PART.rayFlag, 0);
  if (rds32(PART.pathIdx) === 1) {
    const esi = rd32(ADDR.playerState), row = rds32(esi + 0x34);
    if (row >= 4 && row <= 0xc) { wr32(0x1f774, 2); wr32(PART.rayFlag, 1); }
  }
  if (rds32(PART.pathIdx) === 2) {
    const esi = rd32(ADDR.playerState), row = rds32(esi + 0x34);
    if (row >= 4 && row <= 0xc) { wr32(0x1f774, 1); wr32(PART.rayFlag, 1); }
  }
  let eax = rd32(0x1f4c8), ebx = rd32(0x1f4cc);
  if (rds32(PART.rayFlag) === 1) { eax = rd32(0x1f4d0); ebx = rd32(0x1f4d4); }
  wr32(0x1efc0, eax); wr32(0x1efc4, ebx);
  wrf(0x1f500, rdf(0x1f500) + rdf(0x1f50c));
  wrf(0x1f504, rdf(0x1f504) + rdf(0x1f510));
  wrf(0x1f508, rdf(0x1f508) + rdf(0x1f514));
  const esi = rd32(ADDR.playerState), order = rds32(esi + 0x30);
  if (order < 0x18) return;
  if (order === 0x18 && rds32(esi + 0x34) < 0x3a) return;
  wrf(0x1f4e8, rdf(0x1f4e8) + rdf(0x1f4ec));
  wrf(0x1f4e4, rdf(0x1f4e4) + rdf(0x1f4e8));
};

// fn_1ffe5(eax, ebx): run part E until song position (start order + eax, row ebx) or ESC. Yields after present.
HP.fn_1ffe5 = function* (eax, ebx) {
  wr32(0x1ef14, eax); wr32(0x1ef18, ebx);
  let esi = rd32(ADDR.playerState);
  const so = rd32(esi + 0x30);
  wr32(0x1f520, so); wr32(0x1ef1c, so);
  wr32(PART.pathIdx, 0);
  {
    const s = rd32(PART.pathIdx);
    wr32(0x1f4b8, rd32(s * 4 + 0x1f534)); wr32(0x1f4c0, rd32(s * 4 + 0x1f524));
    wr32(0x1f4bc, 0); wrf(0x1f4b4, 0);
  }
  wr32(ADDR.timerMs, 0);
  HP.fill32(rd32(PART.frontBuf), rd32(rd32(0x1f39c)), 0x12c00);
  wrf(0x1f4e4, 0);
  for (;;) {
    let edi = rd32((rd32(PART.pathIdx)) * 4 + 0x1f544);
    wr32(0x28c9c, 1);
    if (rds32(PART.pathIdx) === 1) wr32(0x28c9c, 0);
    cameraFromSpline(0x1f4b4, 0x1f450, edi, 0x1ef38);         // (ebx, esi, edi, ebp)
    HP.fn_1570b(0x1f4e4, 0x1f450);                        // (esi, ebp)
    if (rds32(PART.pathIdx) === 3) wr32(0x1ef6c, rd32(0x1f4c4));
    wr32(0x1efa8, rd32(0x1f450)); wr32(0x1efac, rd32(0x1f454)); wr32(0x1efb0, rd32(0x1f458));
    wr32(0x1efb4, rd32(0x1f45c)); wr32(0x1efb8, rd32(0x1f460)); wr32(0x1efbc, rd32(0x1f464));
    renderObject(0x1f450, 0x1ef38, rd32(PART.frontBuf));         // engine signature: (esi=camera, ebp=scene, edi=dest)
    if (rds32(PART.rayFlag) === 1) HP.fn_1fd0c();
    esi = rd32(ADDR.playerState);
    const order = rds32(esi + 0x30), row = rds32(esi + 0x34);
    if (order !== 0x18 && (row < 4 || row >= 0x32)) {
      let v = Math.sin(rdf(0x1f500)) * rdf(0x1f4f8) + rdf(0x1f4fc);
      const r = roundHalfEven(v) | 0;
      wr32(0x1f4f0, r);
      const old = rds32(0x1f4f0); wr32(0x1f4f0, (0xff - r) | 0); wr32(0x1f4f4, old);
      blueSmear(rd32(0x1f4f4), rd32(0x1f4f0), rd32(PART.frontBuf));   // (ecx, edx, edi)
    } else {
      wrf(0x1f500, 0);
    }
    present(rd32(PART.frontBuf), 0x1ef38);                  // present (esi=buffer, ebp=object)
    yield;
    wr32(0x1ef20, 2);
    let n = Math.trunc((rds32(ADDR.frameMs) + 1) / 0xe);
    for (; n > 0; n--) HP.fn_20240();
    const a = rd32(PART.frontBuf); wr32(PART.frontBuf, rd32(PART.backBuf)); wr32(PART.backBuf, a);
    HP.fill32(rd32(PART.frontBuf), 0, 0x12c00);
    if (rd8(ADDR.keyEsc) === 1) { wr32(ADDR.partExit, 1); return; }
    esi = rd32(ADDR.playerState);
    if (rds32(esi + 0x30) < ((rds32(0x1ef1c) + rds32(0x1ef14)) | 0)) continue;
    if (rds32(esi + 0x34) < rds32(0x1ef18)) continue;
    return;
  }
};
