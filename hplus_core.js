// hplus port — core: memory image, access helpers, PMODE allocators, RNG, integer/x87 helpers.
// Plain JS, usable in the browser and in node.  Every other module imports this HP namespace
// and hangs its own functions off it, so the emulated code's cross-calls stay late-bound.
export const HP = {};

// ---------------------------------------------------------------- memory
HP.MEM_SIZE = 0x1100000;           // mirrors the emulated RAM (1 MB + 16 MB) in 32-bit-segment offsets
HP.IMAGE_SIZE = 0x2f076;
HP.BSS_END = 0x32c20;
let M = null, DV = null, M32 = null, MF32 = null, M16 = null;
HP.init = function (imageBytes, size) {
  size = size || HP.MEM_SIZE;
  const buf = new ArrayBuffer(size);
  M = new Uint8Array(buf); DV = new DataView(buf);
  M32 = new Int32Array(buf); MF32 = new Float32Array(buf); M16 = new Int16Array(buf);
  M.set(imageBytes.subarray ? imageBytes.subarray(0, HP.IMAGE_SIZE) : new Uint8Array(imageBytes, 0, HP.IMAGE_SIZE), 0);
  HP.M = M; HP.DV = DV; HP.M32 = M32; HP.MF32 = MF32; HP.M16 = M16;
  // PMODE variables at the start of the segment (as observed in the emulator at program entry)
  wr32(0x00, 0x35048); wr32(0x04, 0x8f080);       // lomem base/top
  wr32(0x08, 0xef090); wr32(0x0c, 0x10ef090);     // himem base/top
  wr32(0x10, 0x10000); wr32(0x14, 0x10100); wr32(0x18, 0x10f70); wr32(0x1c, 0x100008); wr32(0x20, 0x18);
  wr32(0x24, 0x8a0); wr32(0x28, 0x8c6); wr32(0x2c, 0x8ee); wr32(0x30, 0x9be);
  return M;
};
// accessors (little-endian). rd32 is unsigned, rds32 signed.
const rd8 = a => M[a];
const rds8 = a => (M[a] << 24) >> 24;
const rd16 = a => DV.getUint16(a, true);
const rds16 = a => DV.getInt16(a, true);
const rd32 = a => DV.getUint32(a, true);
const rds32 = a => DV.getInt32(a, true);
const wr8 = (a, v) => { M[a] = v; };
const wr16 = (a, v) => DV.setUint16(a, v & 0xffff, true);
const wr32 = (a, v) => DV.setUint32(a, v >>> 0, true);
const rdf = a => DV.getFloat32(a, true);            // float32 -> number (exact)
// rounds to float32 like fstp dword; a NaN is stored as the x87 "real indefinite" 0xffc00000 (sign bit set)
const wrf = (a, v) => { if (v !== v) DV.setUint32(a, 0xffc00000, true); else DV.setFloat32(a, v, true); };
const rdd = a => DV.getFloat64(a, true);
const wrd = (a, v) => DV.setFloat64(a, v, true);
Object.assign(HP, { rd8, rds8, rd16, rds16, rd32, rds32, wr8, wr16, wr32, rdf, wrf, rdd, wrd });
HP.fill32 = function (a, v, n) { for (let i = 0; i < n; i++, a += 4) DV.setUint32(a, v >>> 0, true); };
HP.fill8 = function (a, v, n) { M.fill(v & 0xff, a, a + n); };
HP.copy = function (dst, src, n) { M.copyWithin(dst, src, src + n); };

// ---------------------------------------------------------------- allocators (PMODE)
// fn_27c(eax=size) -> ptr (low memory), fn_29a(eax=size) -> ptr (high memory). carry on failure.
HP.fn_27c = function (size) {
  size = (size + 3) & ~3;
  const p = rd32(0), e = (p + size) >>> 0;
  if (e > rd32(4)) throw new Error('lomem exhausted');
  wr32(0, e); return p;
};
HP.fn_29a = function (size) {
  size = (size + 3) & ~3;
  const p = rd32(8), e = (p + size) >>> 0;
  if (e > rd32(0xc)) throw new Error('himem exhausted');
  wr32(8, e); return p;
};
HP.fn_2c2 = function () { return (rd32(0xc) - rd32(8)) >>> 0; };   // free himem

// ---------------------------------------------------------------- integer helpers
const rol = (v, n) => ((v << n) | (v >>> (32 - n))) >>> 0;
const ror = (v, n) => ((v >>> n) | (v << (32 - n))) >>> 0;
// high 32 bits of the unsigned 64-bit product a*b
function mulhi(a, b) {
  a >>>= 0; b >>>= 0;
  const ah = a >>> 16, al = a & 0xffff, bh = b >>> 16, bl = b & 0xffff;
  const ll = al * bl, lh = al * bh, hl = ah * bl, hh = ah * bh;
  const mid = (ll >>> 16) + (lh & 0xffff) + (hl & 0xffff);
  return (hh + (lh >>> 16) + (hl >>> 16) + (mid >>> 16)) >>> 0;
}
// high 32 bits of the signed 64-bit product a*b
function imulhi(a, b) {
  a |= 0; b |= 0;
  let h = mulhi(a, b);
  if (a < 0) h = (h - b) >>> 0;
  if (b < 0) h = (h - a) >>> 0;
  return h | 0;
}
// full 64-bit products as BigInt-free [lo, hi]
function mul64(a, b) { return [Math.imul(a, b) >>> 0, mulhi(a, b)]; }
function imul64(a, b) { return [Math.imul(a, b), imulhi(a, b)]; }
// shrd lo,hi,n  (n in 1..31): returns the low dword after shifting the 64-bit value right by n
const shrd = (lo, hi, n) => ((lo >>> n) | (hi << (32 - n))) >>> 0;
// idiv of a 64-bit edx:eax by 32-bit b -> {q, r} (JS numbers, exact up to 2^53 dividend)
function idiv64(lo, hi, b) {
  const num = hi * 4294967296 + (lo >>> 0);   // hi signed, lo unsigned
  const q = Math.trunc(num / b);
  return { q: q | 0, r: (num - q * b) | 0 };
}
Object.assign(HP, { rol, ror, mulhi, imulhi, mul64, imul64, shrd, idiv64 });

// ---------------------------------------------------------------- x87 helpers
// fistp/fist with the default rounding mode (round to nearest, ties to even)
function roundHalfEven(x) {
  if (!(x > -2147483649 && x < 2147483648)) return -2147483648;   // NaN / overflow -> x87 integer indefinite
  const f = Math.floor(x), d = x - f;
  if (d < 0.5) return f;
  if (d > 0.5) return f + 1;
  return (f % 2 === 0) ? f : f + 1;
}
const fround = Math.fround;
// fistp with RC=truncate (used while the draw loop runs)
const truncInt = (x) => (x > -2147483649 && x < 2147483648) ? Math.trunc(x) : -2147483648;
Object.assign(HP, { roundHalfEven, fround, truncInt });

// ---------------------------------------------------------------- RNG  fn_2c2c8(eax=range) -> eax
HP.fn_2c2c8 = function (range) {
  let s1 = rd32(0x28e38), s2 = rd32(0x28e3c);
  let t = (rol((s1 + s2) >>> 0, 5) + 0x09381277) >>> 0;
  s2 = ror((s2 + 0x82093847) >>> 0, 8);
  wr32(0x28e38, t); wr32(0x28e3c, s2);
  return mulhi(range >>> 0, t);
};
HP.rand = HP.fn_2c2c8;

// ---------------------------------------------------------------- timer callbacks (0x2ee64 IRQ handler logic)
// tables: fn ptr [0x2ee1d+i*4], rate [0x2ee2d+i*4], acc [0x2ee3d+i*4] (i=0..3)
HP.timerCallbacks = {};            // offset -> JS function (registered by the player/engine ports)
HP.fn_2ef6e = function (eax, edx) {  // register/alter a timer callback: edx=fn, eax=rate (16.16 Hz, or <0x10000 = one-shot ms)
  for (let i = 3; i >= 0; i--) if (rd32(0x2ee1d + i * 4) === (edx >>> 0)) { wr32(0x2ee2d + i * 4, eax); return; }
  for (let i = 0; i < 4; i++) if (rd32(0x2ee2d + i * 4) === 0) { wr32(0x2ee1d + i * 4, edx); wr32(0x2ee2d + i * 4, eax); return; }
};
// one 1 kHz tick of the timer IRQ handler (0x2ee64) — the parts that matter in the port
HP.timerTick = function () {
  wr32(0x2ee54, rd32(0x2ee54) + 1);
  if (rd32(0xe10) !== 0) {                 // nosound: fake song position advance (not used with sound)
    wr32(0x2ee50, rd32(0x2ee50) + 1);
    if (rds32(0x2ee50) >= 0x50) {
      wr32(0x2ee50, 0);
      const p = rd32(0xe20);
      wr32(p + 0x34, rd32(p + 0x34) + 1);
      if (rds32(p + 0x34) >= 0x40) { wr32(p + 0x34, 0); wr32(p + 0x30, rd32(p + 0x30) + 1); }
    }
  }
  if (rd32(0x2ee58) !== 0) {               // [0x2ee58]: effect-driven random "glitch" trigger (see fn_2cf9a)
    wr32(0x2ee5c, rd32(0x2ee5c) + 1);
    if (rd32(0x2ee5c) === 0x1e) {
      wr32(0x2ee5c, 0);
      const r = HP.fn_2c2c8(0x400);
      wr32(0x2ee60, 0x400);
      let ebx = 0xc;
      if (r < rds32(0x2ee58)) { ebx = 0; wr32(0x2ee60, 0); }
      if (rd32(0xe10) === 0 && HP.fn_2cf9a) HP.fn_2cf9a(ebx);
    }
  }
  for (let i = 3; i >= 0; i--) {
    let rate = rd32(0x2ee2d + i * 4);
    let fire = false;
    if (rate < 0x10000) {
      if (rate === 0) continue;
      rate = (rate - 1) >>> 0;
      if (rate === 0xffffffff) continue;      // was 0: (dec -> -1 -> js) never happens since we skip 0
      wr32(0x2ee2d + i * 4, rate);
      if (rate !== 0) continue;
      fire = true;
    } else {
      let acc = (rd32(0x2ee3d + i * 4) + rate) >>> 0;
      if (acc >= 0x3e80000) { acc = (acc - 0x3e80000) >>> 0; fire = true; }
      wr32(0x2ee3d + i * 4, acc);
    }
    if (fire && rd32(0xe10) === 0) {
      const f = HP.timerCallbacks[rd32(0x2ee1d + i * 4)];
      if (f) f();
    }
  }
};
