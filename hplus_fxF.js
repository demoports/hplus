// hplus port — part F (0x22d30..0x2436b): the end part — rotating line grid / exploding mesh with
// 800 particles on 4 rings, an additive light blob, state machine driven by song orders 0x1f..0x23.
// Also contains the object-builder helpers that live in this address range (0x23f34..0x2436b:
// rsqrt table, vertex/face normals, bounding box centering, radius) — they are called by the ENGINE
// (0x28f5c, 0x24899.., 0x2a4b9) and by part D (0x1d418 -> fn_2432c).
//
// External functions used (HP.fn_xxxxx, register-order args):
//   fn_29a(eax=size)                      himem alloc (hplus_core.js)
//   fn_2c2c8(eax=range)                   rand (hplus_core.js)
//   fn_156ff(esi=chunk, edi=dst) -> edi   copy length-prefixed chunk (hplus_fxA.js)
//   fn_1570b(esi=&k, ebp=vec6)            camera smoothing (hplus_fxA.js)
//   fn_29060(eax, ebx, ecx=0, edx=-1, esi=scale(float bits), edi=chunk data, ebp=object)   build object (ecx/edx unused)   [engine]
//   fn_2a094(ecx, ebp=object)             object init                                              [engine]
//   fn_28ed8(eax=1, ebp=object)                                                                    [engine]
//   fn_28ca4(ebx=rec16/walker, ecx=3, edi=ring+0x18 (points, stride 0x28))  spline sample -> [0x28c74..0x28c7c] [engine]
//   fn_2afd3(ebx=pathstate, esi=camera block, edi=path data, ebp=object)             camera along path [engine]
//   fn_2af3a()                            per-step engine update                                   [engine]
//   fn_2b037(ebx=pathstate/rec16, ecx=[0x21dac] (float bits))  advance a path state              [engine]
//   fn_2a2ac(esi=camera block, edi=dest buffer, ebp=object)     render object (convention order; NOTE hplus_engine.js
//            currently declares it as (esi, ebp, edi) — integrator to reconcile)                       [engine]
//   fn_2b0a8(esi=buffer, ebp=object)      present                                                  [engine]
//   fn_2438e(ebp)                         called by fn_2432c (engine texture-entry creation)       [engine]
// Player state: [0xe20] -> +0x30 order, +0x34 row.
import { HP } from './hplus_core.js';
import { ADDR } from './hplus_addr.js';

// functions this file calls from elsewhere (forwarding, so the HP entry stays late-bound
// and tools/replay.js can still swap it at runtime)
const alloc            = (...a) => HP.fn_29a(...a);     // core: fn_29a — high memory
const rand             = (...a) => HP.fn_2c2c8(...a);   // core: fn_2c2c8 — eax = range
const buildObject      = (...a) => HP.fn_29060(...a);   // engine: fn_29060 — build object from chunk data
const cameraFromSpline = (...a) => HP.fn_2afd3(...a);   // engine: fn_2afd3 — (ebx=walker, esi=camera, edi=path base, ebp=scene)
const invSqrt          = (...a) => HP.fn_23f8c(...a);   // engine: fn_23f8c — fast inverse sqrt on float bits
const objectInit       = (...a) => HP.fn_2a094(...a);   // engine: fn_2a094
const present          = (...a) => HP.fn_2b0a8(...a);   // engine: fn_2b0a8
const renderObject     = (...a) => HP.fn_2a2ac(...a);   // engine: fn_2a2ac — (esi=camera, ebp=object, edi=dest buffer)
const splineAdvance    = (...a) => HP.fn_2b037(...a);   // engine: fn_2b037 — (ebx=walker, ecx=speed factor bits): advance t, wrap keys
const stirRng          = (...a) => HP.fn_2af3a(...a);   // engine: fn_2af3a — stir the RNG + particle texture level override
const copyChunk        = (...a) => HP.fn_156ff(...a);   // fxA: fn_156ff — copy a length-prefixed chunk

// this part's own globals (0x21db4..0x228e8)
const PART = Object.freeze({
  tmpI     : 0x21db4,       // int spill slot: the original stored here; the port keeps the store so memory snapshots match
  state    : 0x22888,       // state machine 0..5, driven by the song position
  subState : 0x2288c,
  lightOn  : 0x22890,
  lightDist: 0x22894,
  displace : 0x228a0,       // mesh displacement along the face normals
  velocity : 0x228a4,
  tmpI2    : 0x228e4,       // int spill slot: the original stored here; the port keeps the store so memory snapshots match
});

const { rd8, rd16, rd32, rds32, wr8, wr16, wr32, rdf, wrf, fround, roundHalfEven } = HP;
const f = fround;
const rint = roundHalfEven;
// float32 store that writes the x87 "indefinite" QNaN (0xffc00000) for NaN results, as the FPU does
const wrfn = (a, v) => { if (v !== v) wr32(a, 0xffc00000); else wrf(a, v); };

// ---------------------------------------------------------------------------------------------
// fn_22d30: light-blob tables: [0x22d28] = pi*[0x22d28]/256; alloc 320x240 (r,angle) word pairs at
// [0x228fc] and a 0xa00-entry BGRX gradient at [0x22900].
HP.fn_22d30 = function () {
  const M = HP.M;
  wr32(PART.tmpI2, 0x100);
  wrf(0x22d28, Math.PI * rdf(0x22d28) / 256);
  let eax = alloc(0x4d810); eax = (eax | 0xf) + 1;
  wr32(0x228fc, eax); eax += 0x4b000; wr32(0x22900, eax); eax += 0x2800;
  // gradient
  let a = 0xa0, b = 0x8c, edi = rd32(0x22900);
  for (let c = 0xa00; c > 0; c--) {
    M[edi] = 0; M[edi + 1] = b & 0xff; M[edi + 2] = a & 0xff; M[edi + 3] = 0; edi += 4;
    a--; if (a <= 0) a = 0;
    b--; if (b <= 0) b = 0;
  }
  // polar table
  edi = rd32(0x228fc);
  const k = rdf(0x228f8), rs = rdf(0x2290c), gs = rdf(0x22908), as = rdf(0x22910);
  wr32(0x228e8, -0x78);
  for (let y = -0x78; y < 0x78; y++) {
    wr32(0x228e8, y);
    for (let x = -0xa0; x < 0xa0; x++) {
      wr32(PART.tmpI2, x);
      const xk = x * k;
      let r = Math.sqrt(y * y + xk * xk) * rs * gs;
      const ri = rint(r); wr32(0x228f0, ri);
      let ang = Math.atan2(xk, y);           // fpatan: atan2(ST1=x*k, ST0=y)
      if (x >= 0) ang = ang + 2 * Math.PI;   // fldpi; fldpi; faddp; faddp
      ang = ang * as * gs;
      const ai = rint(ang); wr32(0x228f4, ai);
      wr16(edi, ri); wr16(edi + 2, (ai & 0xffff) >>> 8);
      edi += 4;
    }
    wr32(PART.tmpI2, 0xa0);
  }
  wr32(0x228e8, 0x78);
};

// fn_22e68: draw the additive light blob at the projected light position [0x220a8+8..+0x10]
HP.fn_22e68 = function () {
  const M = HP.M, dv = HP.DV;
  const ebp = 0x220a8, esi = 0x222d4;
  for (let i = 0; i < 3; i++) {
    const a = rdf(ebp + 8) * rdf(esi + i * 4 + 0x24);
    const b = rdf(ebp + 0xc) * rdf(esi + i * 4 + 0x34);
    const c = rdf(ebp + 0x10) * rdf(esi + i * 4 + 0x44);
    wrf(0x228c4 + i * 4, ((a + b) + c) + rdf(esi + i * 4 + 0x54));
  }
  const fz = (1 / rdf(0x228cc)) * rdf(0x21df0);
  const sy = rdf(0x228c8) * fz + rdf(0x228e0);
  const sx = rdf(0x228c4) * fz + rdf(0x228dc);
  wr32(0x228d4, rint(sy)); wr32(0x228d0, rint(sx)); wrf(0x228d8, fz);
  if (!(rd32(0x228cc) & 0x80000000)) return;
  wr32(0x228d0, rds32(0x228d0) - 0xa0); wr32(0x228d4, rds32(0x228d4) - 0x78);
  if (rds32(0x228d0) <= -0x140 || rds32(0x228d0) >= 0x140) return;
  if (rds32(0x228d4) <= -0xf0 || rds32(0x228d4) >= 0xf0) return;
  wr32(0x228ec, rint(rdf(0x228cc)));
  let e = (-(rds32(0x228ec) + rds32(PART.lightDist)) | 0) >> 4;
  if (e <= 0) e = 0;
  if (e >= 0x100) e = 0x100;
  wr32(0x228ec, e);
  wr32(0x22d14, rd32(0x223e4)); wr32(0x22d18, rd32(0x223e8)); wr32(0x22d1c, rd32(0x223ec));
  {
    const d = rdf(0x22d28), amp = rdf(0x22d24);
    let p = 0x22914;
    for (let c = 0x100; c > 0; c--, p += 4) {
      const s = rdf(0x22d14) + d;
      wrf(0x22d14, s);
      const v = rint(Math.abs(Math.sin(s) * amp));
      wr32(0x228f0, v); wr32(p, v);
    }
  }
  let src = rd32(0x228fc);
  wr32(PART.tmpI2, 0x140); wr32(0x228e8, 0xf0);
  if (rds32(0x228d0) <= 0) {
    wr32(0x228d0, -rds32(0x228d0));
    const x0 = rds32(0x228d0);
    wr32(PART.tmpI2, rds32(PART.tmpI2) - x0); src += x0 * 4; wr32(0x228d0, 0);
  }
  if (rds32(0x228d4) <= 0) {
    wr32(0x228d4, -rds32(0x228d4));
    const y0 = rds32(0x228d4);
    wr32(0x228e8, rds32(0x228e8) - y0); src += y0 * 0x500; wr32(0x228d4, 0);
  }
  const sxp = rds32(0x228d0), syp = rds32(0x228d4);
  wr32(PART.tmpI2, rds32(PART.tmpI2) - sxp); if (rds32(PART.tmpI2) === 0) return;
  wr32(0x228e8, rds32(0x228e8) - syp); if (rds32(0x228e8) === 0) return;
  let dst = ((syp * 5) << 6) + sxp; dst = (dst << 2) + rd32(0x21da0);
  const pal = rd32(0x22900), w = rds32(PART.tmpI2), inten = rds32(0x228ec);
  for (let rows = rds32(0x228e8); rows > 0; rows--) {
    let s = src, d = dst;
    for (let c = w; c > 0; c--) {
      let eax = dv.getUint16(s, true);
      const bx = dv.getUint16(s + 2, true);
      eax = ((eax + rd32(bx * 4 + 0x22914)) >>> 8) + inten;
      s += 4;
      dv.setUint32(d, (dv.getUint32(d, true) + dv.getUint32(pal + eax * 4, true)) >>> 0, true);
      d += 4;
    }
    src += 0x500; dst += 0x500;
  }
};

// fn_23124(esi, edi, ebp) -> edi: build one ring of 10 + 0x39 records (0x28 bytes each) at edi.
// ebp = 0 or 4 selects the x/y field for the first 10; esi = -1 in all calls.
HP.fn_23124 = function (esi, edi, ebp) {
  let eax = rds32(0x228b8);
  wr32(0x21db8, 0xc8);
  for (let c = 0xa; c > 0; c--) {
    wr32(PART.tmpI, eax); wrf(edi + ebp + 0x18, eax);
    wrf(edi + 0x20, rds32(0x21db8));
    eax = (eax + rds32(0x228bc)) | 0;
    wr32(0x21db8, rds32(0x21db8) - 0x32);
    edi += 0x28;
  }
  const step = Math.imul(0x78, esi);
  esi = ((-esi + 1) >>> 1);
  let src = (rd32(0x220dc) + Math.imul(Math.imul(rds32(0x220d4) - 1, esi), 0x3c)) | 0;
  const k = rdf(0x23120);
  src += step;                       // one extra step before the loop (0x23189)
  for (let c = 0x39; c > 0; c--) {
    src += step;
    wrf(edi + 0x18, rdf(src + 4) * k + rdf(0x220b0));
    wrf(edi + 0x1c, rdf(src + 8) * k + rdf(0x220b4));
    wrf(edi + 0x20, rdf(src + 0xc) * k + rdf(0x220b8));
    edi += 0x28;
  }
  return edi;
};

// fn_231ca: part F precalc (called last, with [0x28ed4]=1; it also ends up selecting the video mode via the engine)
HP.fn_231ca = function () {
  const M = HP.M;
  let eax = alloc(0x101010); eax = (eax | 0xf) + 1;
  wr32(0x21da0, eax); eax += 0x4b000; wr32(0x21da4, eax); eax += 0x4b000; wr32(0x21da8, eax); eax += 0x4b000;
  const buf = rd32(0x21da0);
  wr32(0x23fd0, -0x6a4);
  copyChunk(0x203f4, buf);
  buildObject(0, 1, 0, 0xffffffff, rd32(0x21dac), buf, 0x21dbc);
  wr32(0x23fd0, 0x1388);
  copyChunk(0x20e53, buf);
  buildObject(3, 9, 0, 0xffffffff, rd32(0x21dac), buf, 0x21dbc);
  wr32(0x23fd0, -0x5dc);
  copyChunk(0x213b2, buf);
  buildObject(3, 1, 0, 0xffffffff, rd32(0x223c0), buf, 0x21dbc);
  // 'Line' object: the ring vertices relative to [0x220b0..], 16-wide grid lines
  let edi = buf;
  wr32(edi, 0x656e694c); edi += 4;
  let ecx = rd32(0x220d4);
  wr16(edi, ecx); edi += 2;
  let esi = rd32(0x220dc);
  for (let c = ecx; c > 0; c--) {
    wrf(edi, rdf(esi + 4) - rdf(0x220b0));
    wrf(edi + 4, rdf(esi + 8) - rdf(0x220b4));
    wrf(edi + 8, rdf(esi + 0xc) - rdf(0x220b8));
    esi += 0x3c; edi += 0xc;
  }
  wr16(edi, 0xc0); edi += 2;
  for (let a = 1, c = 0x60; c > 0; c--, a++) {
    wr16(edi, a); wr16(edi + 2, a + 1); wr16(edi + 4, a); wr16(edi + 6, a + 0x10); edi += 8;
  }
  wr32(edi, 0);
  buildObject(1, 0x101, 0, 0xffffffff, rd32(0x21dac), buf, 0x21dbc);
  wr32(0x220ac, 0);
  // 'Obu!' object: the triangle mesh [0x220e0] (faces stride 0x30 with 3 vertex pointers) relative to [0x220b0..]
  edi = buf;
  wr32(edi, 0x2175624f); edi += 4;
  const nf = rd32(0x220d8);
  wr16(edi, Math.imul(nf, 3)); edi += 2;
  esi = rd32(0x220e0);
  for (let c = nf; c > 0; c--) {
    for (let k = 0; k < 3; k++) {
      const v = rd32(esi + 0xc + k * 4);
      wrf(edi, rdf(v + 4) - rdf(0x220b0));
      wrf(edi + 4, rdf(v + 8) - rdf(0x220b4));
      wrf(edi + 8, rdf(v + 0xc) - rdf(0x220b8));
      edi += 0xc;
    }
    esi += 0x30;
  }
  wr16(edi, nf); edi += 2;
  for (let a = nf, bx = 0; a > 0; a--) { wr16(edi, bx); bx++; wr16(edi + 2, bx); bx++; wr16(edi + 4, bx); bx++; edi += 6; }
  wr32(edi, 0);
  buildObject(1, 9, 0, 0xffffffff, rd32(0x21dac), buf, 0x21dbc);
  wr32(0x21e28, 1); wr32(0x21de4, 1);
  wr32(0x21de8, 0x1a); wr32(0x21de9, 0x1a); wr32(0x21dea, 0x28);
  wr32(0x21dec, 0x96); wr32(0x21ded, 0x96); wr32(0x21dee, 0x96);
  HP.fill32(buf, 0, 0x25800);
  objectInit(0x320, 0x21dbc);
  // 800 particle records (16 bytes: t, speed, ring offset, ring size)
  eax = alloc(0x320 * 0x10 + 0x10); eax = (eax | 0xf) + 1; wr32(0x223ac, eax);
  edi = eax;
  for (let c = 0x320; c > 0; c--) {
    let r = rand(0x64); wr32(PART.tmpI, r);
    const t = r; wr32(PART.tmpI, 0x64);
    wrf(edi, t / 100);
    r = rand(6); wr32(edi + 8, Math.imul(r, 0x28));
    wr32(edi + 0xc, 0xa78);
    r = rand(0x1388) + 0x64; wr32(PART.tmpI, r);
    wr32(PART.tmpI, 0x30d40);
    wrf(edi + 4, r / 200000);
    edi += 0x10;
  }
  // 4 rings
  eax = alloc(0x29f0); eax = (eax | 0xf) + 1; wr32(0x228c0, eax);
  wrf(PART.tmpI, 0);
  HP.fill32(eax, rd32(PART.tmpI), 0xa78);
  edi = eax;
  wr32(0x228b8, -0xbb8); wr32(0x228bc, 0x10e); edi = HP.fn_23124(-1, edi, 0);
  wr32(0x228b8, -0xbb8); wr32(0x228bc, 0x10e); edi = HP.fn_23124(-1, edi, 4);
  wr32(0x228b8, 0xbb8); wr32(0x228bc, -0x10e); edi = HP.fn_23124(-1, edi, 0);
  wr32(0x228b8, 0xbb8); wr32(0x228bc, -0x10e); edi = HP.fn_23124(-1, edi, 4);
  HP.fn_28ed8(1, 0x21dbc);
  wr32(0x21e44, rd32(0x223b0)); wr32(0x21e48, rd32(0x223b4)); wr32(0x21e4c, rd32(0x223b8)); wr32(0x21de0, rd32(0x223bc));
  wr32(PART.tmpI, 0x80); wrf(0x22240, 128); wrf(0x22244, 128);
  {
    let p = rd32(0x2224c);
    for (let c = 0x10000; c > 0; c--, p++) { let v = (M[p] << 1) - 0x14; if (v <= 0) v = 0; M[p] = v & 0xff; }
  }
  wrf(0x22228, 1); wr32(PART.tmpI, 0xff); wrf(0x2222c, 255);
  {
    let p = rd32(0x22234);
    for (let i = 0; i < 0x100; i++, p += 0x100) M.fill(i >>> 2, p, p + 0x100);
  }
  HP.fn_22d30();
  wr32(PART.tmpI, 0x40); wrf(0x22210, 64); wrf(0x22214, 64);
};

// build the 256-entry BGRx palette at 0x29090 with component scales (r=red scale, g=green, b=blue)
function palette(r, g, b) {
  wr32(PART.tmpI2, 0x100); wrf(PART.tmpI2, 1 / 256);
  const d = rdf(PART.tmpI2);
  let v = 0, edi = 0x29090;
  for (let c = 0x100; c > 0; c--, edi += 4) {
    wr32(PART.tmpI, r); let t = rint(r * v); wr32(PART.tmpI, t); wr8(edi + 2, t);
    wr32(PART.tmpI, g); t = rint(g * v); wr32(PART.tmpI, t); wr8(edi + 1, t);
    wr32(PART.tmpI, b); t = rint(b * v); wr32(PART.tmpI, t); wr8(edi, t);
    v = v + d;
  }
}

// fn_236ef(eax): run part F. Generator: yields after each present.
HP.fn_236ef = function* (eax) {
  const M = HP.M;
  wr32(0x26404, 0xffffffff);
  wr32(0x21d94, eax | 0);
  { let p = rd32(0x28e5c); for (let c = 0x20000; c > 0; c--, p++) M[p] >>= 1; }
  HP.copy(0x2285d, 0x2285d - 0x28, 0x28);
  let esi = rd32(ADDR.playerState);
  const order0 = rd32(esi + 0x30);
  wr32(0x21d98, order0);
  wr32(0x22404, ((order0 - 1) >>> 1));
  wr32(0x22400, 0);
  {
    const s = rd32(0x22400);
    wr32(0x223a0, rd32(s * 4 + 0x2241c)); wr32(0x223a8, rd32(s * 4 + 0x22408));
    wr32(0x223a4, 0); wrf(0x2239c, 0);
  }
  wr32(ADDR.timerMs, 0);
  palette(0x28, 0x1e, 0x1e);
  // working copy of the mesh vertices
  eax = Math.imul(rd32(0x2214c), 0x3c);
  const ndw = eax >>> 2;
  let p = alloc(eax + 0x10); p = (p | 0xf) + 1; wr32(0x228b0, p);
  HP.copy(p, rd32(0x22154), ndw * 4);
  wr32(PART.state, 0); wr32(PART.subState, 0);
  for (;;) {
    HP.fill32(rd32(0x21da0), rd32(rd32(0x22220)), 0x12c00);
    wr32(0x220e8, rd32(0x220e8) & 0x3ffe);
    esi = rd32(ADDR.playerState);
    const ord = rds32(esi + 0x30), row = rds32(esi + 0x34);
    if (ord >= 0x1f && (ord > 0x1f || row >= 0x30) && rd8(ADDR.keyPause) !== 1) {
      if (rds32(PART.state) <= 4) {
        const r = rand(8);
        wr32(0x220e8, rd32(0x220e8) & 0x3ffe);
        if (r === 3) wr32(0x220e8, rd32(0x220e8) | 1);
      } else wr32(0x220e8, rd32(0x220e8) | 1);
    }
    // displace the mesh vertices along the (paired) face normals by [0x228a0]
    {
      let src = rd32(0x228b0), nrm = rd32(0x22158), dst = rd32(0x22154), ebp = nrm;
      const k = rdf(PART.displace), kz = rdf(0x228b4);
      let par = 0;
      for (let n = rds32(0x22150); n > 0; n--) {
        par = (par + 1) & 1;
        if (par === 1) ebp = nrm;
        let d = rdf(ebp + 0x18) * k;
        wrf(dst + 4, d + rdf(src + 4)); wrf(dst + 0x40, d + rdf(src + 0x40)); wrf(dst + 0x7c, d + rdf(src + 0x7c));
        d = rdf(ebp + 0x1c) * k;
        wrf(dst + 8, d + rdf(src + 8)); wrf(dst + 0x44, d + rdf(src + 0x44)); wrf(dst + 0x80, d + rdf(src + 0x80));
        d = rdf(ebp + 0x20) * kz * k;
        wrf(dst + 0xc, d + rdf(src + 0xc)); wrf(dst + 0x48, d + rdf(src + 0x48)); wrf(dst + 0x84, d + rdf(src + 0x84));
        src += 0xb4; dst += 0xb4; nrm += 0x30;
      }
    }
    // 800 particles: 4 rings x 200, positions sampled along the rings by the engine
    {
      const saved = rd32(0x21df0);
      let ring = rd32(0x228c0), rec = rd32(0x223ac);
      let vtx = rd32(0x21dbc + 0x514);
      for (let ebp = 4; ebp > 0; ebp--) {
        for (let c = 0xc8; c > 0; c--) {
          wr32(0x28c9c, 0);
          HP.fn_28ca4(rec, 3, ring + 0x18);           // (ebx=record, ecx=3, edi=ring points); esi=ring, ebp=ring# unused by the callee
          wr32(vtx + 4, rd32(0x28c74)); wr32(vtx + 8, rd32(0x28c78)); wr32(vtx + 0xc, rd32(0x28c7c));
          wr32(PART.tmpI, -0x2d); wrf(vtx + 0x20, -45);
          rec += 0x10; vtx += 0x2c;
        }
        ring += 0xa78;
      }
      wr32(0x21df0, saved);
    }
    wr32(0x28c9c, 1);
    if (rds32(0x22400) === 4) wr32(0x28c9c, 0);
    cameraFromSpline(0x2239c, 0x222d4, rd32(rd32(0x22400) * 4 + 0x22430), 0x21dbc);   // (ebx, esi, edi=path, ebp)
    HP.fn_1570b(0x223c4, 0x222d4);
    wr32(0x21e2c, rd32(0x222d4)); wr32(0x21e30, rd32(0x222d8)); wr32(0x21e34, rd32(0x222dc));
    wr32(0x21e38, rd32(0x222e0)); wr32(0x21e3c, rd32(0x222e4)); wr32(0x21e40, rd32(0x222e8));
    renderObject(0x222d4, 0x21dbc, rd32(0x21da0));                               // (esi, ebp, edi) — engine signature order
    if (rds32(PART.lightOn) !== 0) HP.fn_22e68();
    present(rd32(0x21da0), 0x21dbc);                                        // (esi, ebp) present
    yield;
    wr32(0x21d9c, 2);
    let n = Math.trunc((rds32(ADDR.frameMs) + 1) / 0xe);
    for (; n > 0; n--) HP.fn_23bd0();
    if (rd8(ADDR.keyEsc) === 1) { wr32(ADDR.partExit, 1); break; }
    if (rds32(PART.state) < 5) continue;
    if (rds32(0x223a4) < rds32(0x22418) - 0xc8) continue;
    break;
  }
  // exit: keep the last frame in [0x21da8] (part A's final fade blends from it), restore the lightmap
  HP.copy(rd32(0x21da8), rd32(0x21da0), 0x12c00 * 4);
  { let q = rd32(0x28e5c); for (let c = 0x20000; c > 0; c--, q++) M[q] = (M[q] << 1) & 0xff; }
  palette(0x96, 0x96, 0x96);
};

// fn_23bd0: one update step (14 ms)
HP.fn_23bd0 = function () {
  if (rd8(ADDR.keyPause) === 1) return;
  stirRng();
  splineAdvance(0x2239c, rd32(0x21dac));
  {
    let rec = rd32(0x223ac);
    for (let c = 0x320; c > 0; c--, rec += 0x10) splineAdvance(rec, rd32(0x21dac));
  }
  if (rds32(0x22400) !== 4) {
    const esi = rd32(ADDR.playerState);
    const e = ((rds32(esi + 0x30) - 1) >>> 1);
    if (e !== rd32(0x22404)) {
      wr32(0x22404, e);
      wr32(0x22400, rd32(0x22400) + 1);
      if (rds32(0x22400) >= 4) wr32(0x22400, 4);
      const s = rd32(0x22400);
      if (rd32(s * 4 + 0x22430) !== rd32(s * 4 + 0x2242c)) {
        wr32(0x223a0, rd32(s * 4 + 0x2241c)); wr32(0x223a8, rd32(s * 4 + 0x22408));
        wr32(0x223a4, 0); wrf(0x2239c, 0);
      }
    }
  }
  wrf(0x223e4, rdf(0x223e4) + rdf(0x223f0));
  wrf(0x223e8, rdf(0x223e8) + rdf(0x223f4));
  wrf(0x223ec, rdf(0x223ec) + rdf(0x223f8));
  let esi = rd32(ADDR.playerState);
  if (rds32(esi + 0x30) >= 0x20 && rds32(PART.state) === 0 && rds32(esi + 0x34) >= 2) {
    wr32(PART.state, 1); wr32(0x220ac, rd32(0x220ac) | 1);
  }
  if (rds32(PART.state) === 1) {
    wrf(PART.velocity, rdf(PART.velocity) - rdf(0x228ac));
    wrf(PART.displace, rdf(PART.displace) + rdf(PART.velocity));
  }
  if (rds32(PART.state) === 1 && rds32(esi + 0x30) >= 0x21) {
    wr32(PART.state, 2); wr32(PART.lightOn, 1); wr32(PART.lightDist, -0x3e8); wr32(PART.subState, 1);
  }
  if (rds32(PART.state) === 2) {
    wrf(PART.velocity, rdf(PART.velocity) + rdf(0x228a8));
    wrf(PART.displace, rdf(PART.displace) + rdf(PART.velocity));
  }
  if (rds32(PART.subState) === 1) {
    wr32(PART.lightDist, rds32(PART.lightDist) + 0xf);
    if (rds32(PART.lightDist) >= 0x578) wr32(PART.lightDist, 0x578);
  }
  if (rds32(PART.subState) === 2) {
    wr32(PART.lightDist, rds32(PART.lightDist) - 6);
    if (rds32(PART.lightDist) <= -0x7d0) { wr32(PART.lightDist, -0x7d0); wr32(PART.lightOn, 0); }
  }
  esi = rd32(ADDR.playerState);
  if (rds32(esi + 0x34) >= 0x34) wr32(PART.subState, 2);
  if (rds32(PART.state) === 2) {
    esi = rd32(ADDR.playerState);
    if (rds32(esi + 0x34) >= 0x12) wr32(PART.state, 3);
  }
  if (rds32(PART.state) === 3) {
    wrf(PART.velocity, rdf(PART.velocity) * rdf(0x2289c));
    wrf(PART.displace, rdf(PART.displace) + rdf(PART.velocity));
  }
  if (rds32(PART.state) === 3) {
    esi = rd32(ADDR.playerState);
    if (rds32(esi + 0x30) >= 0x23 && rds32(esi + 0x34) >= 4) wr32(PART.state, 4);
  }
  if (rds32(PART.state) === 4) {
    if (rd32(PART.displace) & 0x80000000) {
      for (let i = 0, a = 0; i < 0xb; i++, a += 0x3c) wr32(a + 0x21e54, rd32(a + 0x21e54) & 0x7fe);
      wr32(0x223a0, rd32(0x22448));
      wrf(PART.displace, 0);
      wr32(0x21e24, 0);
      wr32(PART.state, 5);
    } else {
      wrf(PART.velocity, rdf(PART.velocity) - rdf(0x228a8));
      wrf(PART.displace, rdf(PART.displace) + rdf(PART.velocity));
    }
  }
  if (rds32(0x223d0) !== 5) {
    wrf(0x223c8, rdf(0x223c8) + rdf(0x223cc));
    wrf(0x223c4, rdf(0x223c4) + rdf(0x223c8));
    if (rd32(0x223c4) & 0x80000000) { wrf(0x223c4, 0); wr32(0x223d0, 5); }
  }
};

// ---------------------------------------------------------------------------------------------
// Object-builder helpers in 0x23f34..0x2436b (engine territory by meaning; ported here because of the range split).
// hplus_engine.js ports them as well — if it is loaded first its versions take precedence (guarded below).
// Object struct (ebp): +0x2c vertex count, +0x30 face count, +0x34 vertices (stride 0x3c: +4,+8,+0xc xyz,
// +0x20..+0x28 normal, +0x38 1/nfaces), +0x38 faces (stride 0x30: +0xc,+0x10,+0x14 vertex ptrs, +0x18..+0x20 normal, +0x24 plane d).

// fn_23f34: 1/sqrt table (0x2000 dwords) at [0x23f30], indexed by mantissa bits; [table+0x4000] = 0x7ff800
HP.fn_23f34 = HP.fn_23f34 || function () {
  const dv = HP.DV;
  let eax = alloc(0x8010); eax = (eax | 0xf) + 1; wr32(0x23f30, eax);
  let edi = eax;
  const tmp = new DataView(new ArrayBuffer(4));
  for (let i = 0; i < 0x2000; i++, edi += 4) {
    tmp.setUint32(0, ((i << 11) | 0x3f000000) >>> 0, true);
    const x = tmp.getFloat32(0, true);
    tmp.setFloat32(0, 1 / Math.sqrt(x), true);
    let b = tmp.getUint32(0, true);
    b = ((b + 0x200) & 0x7ff800) >>> 0;
    dv.setUint32(edi, b, true);
  }
  wr32(rd32(0x23f30) + 0x4000, 0x7ff800);
};
// fn_23f8c(eax=float bits) -> ecx: fast inverse sqrt (float bits) using the table
HP.fn_23f8c = HP.fn_23f8c || function (eax) {
  eax >>>= 0;
  let ecx = 0x5f000000;
  let ebx = (eax >>> 1) & 0x3fc00000;
  let idx = (eax >>> 9) & 0x7ffc;
  ecx = (ecx - ebx) >>> 0;
  ecx = (ecx & 0xff800000) >>> 0;
  ecx = (ecx | rd32(idx + rd32(0x23f30))) >>> 0;
  return ecx;
};
// fn_23fd4(ebp): per-vertex 1/(number of faces using it) -> vertex+0x38
HP.fn_23fd4 = HP.fn_23fd4 || function (ebp) {
  let v = rd32(ebp + 0x34), n = rds32(ebp + 0x2c);
  for (let i = 0; i < n; i++, v += 0x3c) wr32(v + 0x38, 0);
  let fc = rd32(ebp + 0x38);
  for (let i = rds32(ebp + 0x30); i > 0; i--, fc += 0x30) {
    const a = rd32(fc + 0xc), b = rd32(fc + 0x10), c = rd32(fc + 0x14);
    wr32(a + 0x38, rd32(a + 0x38) + 1); wr32(b + 0x38, rd32(b + 0x38) + 1); wr32(c + 0x38, rd32(c + 0x38) + 1);
  }
  v = rd32(ebp + 0x34);
  for (let i = n; i > 0; i--, v += 0x3c) wrf(v + 0x38, 1 / rds32(v + 0x38));
};
// fn_24018(ebp): face normals (scaled by 255/len) and averaged vertex normals
HP.fn_24018 = HP.fn_24018 || function (ebp) {
  const tmp = new DataView(new ArrayBuffer(4));
  wrfn(0x28e44, 0);
  const z = rd32(0x28e44);
  let v = rd32(ebp + 0x34);
  for (let i = rds32(ebp + 0x2c); i > 0; i--, v += 0x3c) { wr32(v + 0x20, z); wr32(v + 0x24, z); wr32(v + 0x28, z); }
  let fc = rd32(ebp + 0x38);
  for (let i = rds32(ebp + 0x30); i > 0; i--, fc += 0x30) {
    const b = rd32(fc + 0xc), d = rd32(fc + 0x10), s = rd32(fc + 0x14);
    const bx = rdf(b + 4), by = rdf(b + 8), bz = rdf(b + 0xc);
    const dx = rdf(d + 4), dy = rdf(d + 8), dz = rdf(d + 0xc);
    const sx = rdf(s + 4), sy = rdf(s + 8), sz = rdf(s + 0xc);
    wrfn(0x28e78, (dy - by) * (sz - bz) - (sy - by) * (dz - bz));
    wrfn(0x28e7c, -((dx - bx) * (sz - bz) - (sx - bx) * (dz - bz)));
    wrfn(0x28e80, (dx - bx) * (sy - by) - (sx - bx) * (dy - by));
    const nx = rdf(0x28e78), ny = rdf(0x28e7c), nz = rdf(0x28e80);
    wrfn(0x28e40, (nx * nx + ny * ny) + nz * nz);
    const rs = invSqrt(rd32(ADDR.tmpF));
    wr32(ADDR.tmpF, rs);
    tmp.setUint32(0, rs, true);
    const r = tmp.getFloat32(0, true);
    wr32(ADDR.tmpF, 0xff);
    const r255 = r * 255;
    let t = nx * r255; wrfn(fc + 0x18, t);
    wrfn(b + 0x20, t + rdf(b + 0x20)); wrfn(d + 0x20, t + rdf(d + 0x20)); wrfn(s + 0x20, t + rdf(s + 0x20));
    t = ny * r255; wrfn(fc + 0x1c, t);
    wrfn(b + 0x24, t + rdf(b + 0x24)); wrfn(d + 0x24, t + rdf(d + 0x24)); wrfn(s + 0x24, t + rdf(s + 0x24));
    t = nz * r255; wrfn(fc + 0x20, t);
    wrfn(b + 0x28, t + rdf(b + 0x28)); wrfn(d + 0x28, t + rdf(d + 0x28)); wrfn(s + 0x28, t + rdf(s + 0x28));
    wrfn(fc + 0x24, -((rdf(fc + 0x18) * bx + rdf(fc + 0x1c) * by) + rdf(fc + 0x20) * bz));
  }
  v = rd32(ebp + 0x34);
  for (let i = rds32(ebp + 0x2c); i > 0; i--, v += 0x3c) {
    const k = rdf(v + 0x38);
    const a = rdf(v + 0x20) * k, bb = rdf(v + 0x24) * k, c = rdf(v + 0x28) * k;
    wrfn(v + 0x24, bb); wrfn(v + 0x28, c); wrfn(v + 0x20, a);
  }
};
// fn_241be(ebp): bounding box -> center in ebp+8..+0x10 ((min+max)/[0x28e68]), vertices re-centered
HP.fn_241be = HP.fn_241be || function (ebp) {
  let v = rd32(ebp + 0x34), n = rds32(ebp + 0x2c);
  wr32(ADDR.bboxMinX, rd32(v + 4)); wr32(0x23fbc, rd32(v + 4));
  wr32(0x23fc0, rd32(v + 8)); wr32(0x23fc4, rd32(v + 8));
  wr32(0x23fc8, rd32(v + 0xc)); wr32(0x23fcc, rd32(v + 0xc));
  for (let i = n; i > 0; i--, v += 0x3c) {
    for (let k = 0; k < 3; k++) {
      const val = rdf(v + 4 + k * 4);
      const hi = 0x23fb8 + k * 8, lo = hi + 4;
      if (!(rdf(hi) >= val)) wrfn(hi, val);    // jae skips when st0(cur) >= val
      if (!(rdf(lo) <= val)) wrfn(lo, val);    // jbe skips when cur <= val
    }
  }
  const div = rdf(ADDR.const2);
  wrfn(ebp + 8, (rdf(ADDR.bboxMinX) + rdf(0x23fbc)) / div);
  wrfn(ebp + 0xc, (rdf(0x23fc0) + rdf(0x23fc4)) / div);
  wrfn(ebp + 0x10, (rdf(0x23fc8) + rdf(0x23fcc)) / div);
  v = rd32(ebp + 0x34);
  for (let i = n; i > 0; i--, v += 0x3c) {
    wrfn(v + 4, rdf(v + 4) - rdf(ebp + 8));
    wrfn(v + 8, rdf(v + 8) - rdf(ebp + 0xc));
    wrfn(v + 0xc, rdf(v + 0xc) - rdf(ebp + 0x10));
  }
};
// fn_242e3(ebp): bounding radius -> ebp+0x20
HP.fn_242e3 = HP.fn_242e3 || function (ebp) {
  wrfn(0x23fb8, 0);
  let v = rd32(ebp + 0x34);
  for (let i = rds32(ebp + 0x2c); i > 0; i--, v += 0x3c) {
    const x = rdf(v + 4), y = rdf(v + 8), z = rdf(v + 0xc);
    const l = (z * z + y * y) + x * x;      // fld x; fmul; fld y; fmul; fld z; fmul; faddp; faddp -> (z²+y²)+x²
    if (!(rdf(ADDR.bboxMinX) >= l)) wrfn(0x23fb8, l);
  }
  wrfn(ebp + 0x20, Math.sqrt(rdf(ADDR.bboxMinX)));
};
// fn_2432c(edx, ebp): allocate builder tables, copy a 13-byte name from edx to 0x2436b, [ebp+0x5c]++, fn_2438e
HP.fn_2432c = HP.fn_2432c || function (edx, ebp) {
  let eax = alloc(0x310); eax = (eax | 0xf) + 1; wr32(0x24382, eax);
  eax = alloc(0x60000); eax = ((eax | 0xffff) + 1) >>> 0; wr32(0x24386, eax);
  HP.copy(0x2436b, edx, 0xd);
  wr32(ebp + 0x5c, rd32(ebp + 0x5c) + 1);
  return HP.fn_2438e(ebp);
};
