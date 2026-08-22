// hplus (halcyon, The Party 1998) — music player port.
// Transliteration of the intro's module player (custom XM-derived format, player by
// "digisnap / matrix") and its SB16 16-bit stereo software mixer, from the disassembly
// of HPLUS.EXE (32-bit image offsets quoted in comments).  Bit-exact with the original:
// the player operates on a flat byte array laid out like the original's memory
// (module at offset 0x1090, player state block, driver block), with every integer
// operation mirrored (32-bit wraparound, shifts, truncating division).
//
// Usage:
//   const p = HPlusPlayer.create(HPlusPlayer.decrypt(encryptedBytes));   // or create(decryptedBytes)
//   p.render(int16Array, nframes)   // interleaved stereo, 44100 Hz, signed 16-bit
//   p.position()                    // {order,row,tick,frames,...}
// The first rendered frame is the single silent frame the original emits before tick 1
// (the original additionally plays 5512 frames of 0x8080 fill before that; see notes).
(function (root) {
'use strict';

const MOD = 0x1090;           // module offset (same as in the original image)
const S   = 0x10000;          // player state block (0x3740 bytes)
const D   = 0x14000;          // sound driver block (0x7c00 bytes)
const MEMSIZE = 0x1c000;
const RATE = 44100;
const MIX = D + 0x4c;         // mixer context (ebx in the mixing code)
const ACC = D + 0x74;         // accumulator (MIX+0x28): 0x1d4c dwords, stereo pairs
const CHN = S + 0x1970;       // channel structs, 0xe5 bytes each
const CHSZ = 0xe5;

function decrypt(bytes) {     // 0xe1ba (rol 1, +0x85) then 0xe2bc (ror 5)
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    let x = (((b << 1) | (b >> 7)) + 0x85) & 0xff;
    out[i] = ((x >> 5) | (x << 3)) & 0xff;
  }
  return out;
}

// unsigned 32x32 -> high 32 bits
function mulhi(a, b) {
  a >>>= 0; b >>>= 0;
  const ah = a >>> 16, al = a & 0xffff, bh = b >>> 16, bl = b & 0xffff;
  const lo = al * bl;
  const mid = ah * bl + al * bh + Math.floor(lo / 65536);   // < 2^33, exact in double
  const hi = ah * bh + Math.floor(mid / 65536);
  return hi >>> 0;
}

function create(moduleBytes, opts) {
  opts = opts || {};
  const mem = new Uint8Array(MEMSIZE);
  const dv = new DataView(mem.buffer);
  mem.set(moduleBytes, MOD);
  const u8 = a => mem[a], s8 = a => (mem[a] << 24) >> 24;
  const u16 = a => dv.getUint16(a, true), s16 = a => dv.getInt16(a, true);
  const u32 = a => dv.getUint32(a, true), s32 = a => dv.getInt32(a, true);
  const w8 = (a, v) => { mem[a] = v & 0xff; };
  const w16 = (a, v) => dv.setUint16(a, v & 0xffff, true);
  const w32 = (a, v) => dv.setUint32(a, v >>> 0, true);
  const add32 = (a, v) => w32(a, (s32(a) + v) | 0);

  // ---- random generator shared with the intro (0x2c2c8); state seeded like the image
  let rnd1 = 0x49180712 | 0, rnd2 = 0x1294792 | 0;
  function random(n) {
    let edx = (rnd1 + rnd2) | 0;
    edx = ((edx << 5) | (edx >>> 27)) | 0;
    edx = (edx + 0x9381277) | 0;
    rnd2 = (rnd2 + 0x82093847) | 0;
    rnd2 = ((rnd2 >>> 8) | (rnd2 << 24)) | 0;
    rnd1 = edx;
    return mulhi(n, edx);
  }

  // ------------------------------------------------------------------ loader (0x2cfa8)
  // driver config (SB16: port 220, irq 5, dma8 1, dma16 5, flags 3 (16-bit + sb16 dma), version 5, rate 44100)
  w32(S, D);
  w8(D + 7, 3); w8(D + 8, 5); w32(D + 9, RATE);
  for (let i = 0; i < 0x1d4c; i++) w32(ACC + i * 4, 0x2000000);     // 0x2e466
  w32(D + 0x1e, RATE >> 3); w32(D + 0x22, RATE >> 3); w32(D + 0x1a, 0); w32(D + 0x32, 2);
  w32(S + 0x4b, Math.floor(0x100 * 4294967296 / RATE));             // 0x2e667: (0x100<<32)/rate
  w32(D + 0x70, 12);                                                  // master volume (0xf14 -> setvol(0xc))
  setTempoRaw(0x320000);                                              // 0x2e4bf
  w32(D + 0x64, 1);

  function setTempoRaw(eax) {   // 0x2e5b4
    const ebx = eax >>> 0;
    let v = Math.floor((u32(D + 9) * 65536) / ebx) >>> 0;
    w32(D + 0x3e, v);
    w32(D + 0x2a, Math.floor(((v << 8) >>> 0) / u32(D + 0x32)));
  }
  let curBPM = 0;
  function setBPM(bpm) {        // 0x2d5ba: eax*0x6666 -> driver settempo
    curBPM = bpm;
    setTempoRaw(Math.imul(bpm, 0x6666) >>> 0);
  }

  // 0x2cfa8: load module at esi = MOD
  {
    let esi = MOD;
    for (let i = 0; i < 0x200; i++) w32(S + 0x170 + i * 4, 0);
    for (let i = 0; i < 0x728; i++) w32(S + 0x1970 + i * 4, 0);
    const hdrlen = 0x20 + u32(esi);
    for (let i = 0; i < hdrlen; i++) mem[S + 0x50 + i] = mem[esi + i];
    esi += hdrlen;
    // pattern pointers
    for (let ecx = 0; ecx < u32(S + 0x5c); ecx++) { w32(S + 0x170 + ecx * 4, esi); esi = (esi + u32(esi)) | 0; }
    // instruments
    for (let ecx = 0; ecx < u32(S + 0x60); ecx++) {
      const al = u8(esi + 1); const edx = u8(esi); const ebx = esi; esi += 2;
      if (edx !== 0) {
        w32(S + 0x570 + ecx * 4, ebx);
        let fl = al;
        if (fl & 1) esi += 0x60; fl >>= 1;
        if (fl & 1) { esi += u8(esi) * 4 + 0xa; } fl >>= 1;
        if (fl & 1) { esi += u8(esi) * 4 + 8; } fl >>= 1;
        if (fl & 1) esi += 4;
        w32(S + 0x770 + ecx * 4, esi);
        for (let k = 0; k < edx; k++) esi = (esi + u32(esi)) | 0;
      }
    }
    // period/frequency table (0x2d038)
    {
      let eax = 0x41560000n; const ebx = 0x801d966fn;
      const linear = (u32(S + 0x64) & 1) !== 0;
      for (let ecx = 0; ecx < 0x300; ecx++) {
        if (!linear) { w32(S + 0x970 + ecx * 4, Number(0x6d3bc83b0000n / eax)); }
        else w32(S + 0x970 + ecx * 4, Number(eax >> 11n));
        eax = ((eax * ebx) >> 31n) & 0xffffffffn;
      }
    }
    {
      let eax = 0x10000n;
      for (let ecx = 0; ecx < 16; ecx++) { w32(S + 0x3679 + ecx * 4, Number(eax >> 8n)); eax = ((eax * 0x10f39n) >> 16n) & 0xffffffffn; }
    }
    for (let ecx = 0x7f; ecx >= 0; ecx--) {
      const v = Math.imul(ecx * 2 - 0x80, ecx * 2 - 0x80);
      let ah = (((v >> 8) & 0xff) - 0x40) & 0xff;
      w8(S + 0x15f0 + ecx, ah); w8(S + 0x1570 + ecx, (-ah) & 0xff);
    }
    for (let ecx = 0xff; ecx >= 0; ecx--) {
      let al = ((ecx << 24) >> 24) >> 1;          // sar al,1
      w8(S + 0x1870 + ecx, al); w8(S + 0x1770 + ecx, -al);
      w8(S + 0x1670 + ecx, ((al & 0x80) + 0x40) & 0xff);
    }
    w32(S + 0x1e, 0x40); w8(S + 0x2b, 1); w32(S + 0x30, 0); w32(S + 0x34, 0); w32(S + 0x23, 0); w8(S + 0x36b9, 0);
    // driver prepare (0x2e55d): channels, sample conversion
    w32(D + 0x32, u32(S + 0x58));
    forEachSample(function (shdr) {   // 0x2e56e
      let ecx = u32(shdr) - 0x16; let ebx = shdr + 0x16;
      w32(shdr + 0xc, ebx);
      if (u8(shdr + 0x10) & 4) {
        ecx >>>= 1;
        // SB16 (D.7 & 2): word-index pointer, realign odd data
        const p = u32(shdr + 0xc); w32(shdr + 0xc, p >>> 1);
        if (p & 1) { for (let k = 0; k < ecx; k++) { w16(ebx - 1, u16(ebx)); ebx += 2; } }
      }
    });
    setBPM(u32(S + 0x6c));
    w8(S + 0x1c, 4); w8(S + 0x1d, 0);
    w32(S + 0x1e, 0x3f);      // 0xf50: start with global volume 0x3f
  }
  function forEachSample(fn) {   // 0x2d1a1
    for (let ecx = u32(S + 0x60) - 1; ecx >= 0; ecx--) {
      const ebx = u32(S + 0x570 + ecx * 4); if (!ebx) continue;
      let esi = u32(S + 0x770 + ecx * 4);
      for (let k = u8(ebx); k > 0; k--) { fn(esi); esi = (esi + u32(esi)) | 0; }
    }
  }

  // ------------------------------------------------------------------ period -> "freq" (0x2d7e6)
  function periodConv(eax) {
    if (u32(S + 0x64) & 1) return eax | 0;
    if (eax < 0) eax = 0;
    const q = Math.floor((eax >>> 0) / 0x300), r = (eax >>> 0) % 0x300;
    return (-(u32(S + 0x970 + r * 4) >>> (q & 31))) | 0;
  }

  // ------------------------------------------------------------------ effects (0x2d3e8 table)
  const EFF_FLAGS = [0x08,0x18,0x19,0x14,0x15,0x14,0x15,0x1c,0x00,0x2c,0x10,0x00,0x04,0x0a,0x1a,0x06,0x14,0x15,0x28,0x00,0x00,0x0c,0x18,0x04,0x1a,0x04,0x0a,0x1a,0x04,0x04,0x04,0x04,0x04,0x04,0x14,0x0c,0x04,0x04,0x0c,0x2c,0,0,0,0,0,0,0,0,0x14];
  // handlers return true to stop processing the rest of this channel's effects (ecx=0)
  function eff_none() {}
  function eff_arpeggio(eax, ebx, esi) {            // 0x2d3e9
    let edx = s32(S + 0x23);
    do { edx -= 3; } while (edx > 0);
    if (edx === 0) return;
    edx++;
    if (edx !== 0) eax = (eax >>> 4);
    eax = eax & 0xf;
    w32(esi + 0xe0, eax);
    if (u32(S + 0x64) & 1) add32(esi + 0xb, eax << 6);
  }
  function eff_porta(eax, ebx, esi) { add32(esi + 7, eax << 2); }          // 0x2d411
  function eff_xporta(eax, ebx, esi) { add32(esi + 7, eax); }              // 0x2d414
  function eff_toneporta(eax, ebx, esi) {                                   // 0x2d418
    if (u8(esi + 0x23) === 1) {
      let e = u8(esi + 1) - 1;
      if (e < 0) return;
      e = ((e << 6) + s32(esi + 3)) | 0;
      w32(esi + 0x30, periodConv(e));
      w8(esi + 1, 0);
      return;
    }
    eax = eax << 2;
    const ebx2 = s32(esi + 0x30);
    if (ebx2 < s32(esi + 7)) {
      add32(esi + 7, -eax);
      if (ebx2 < s32(esi + 7)) return;
      w32(esi + 7, ebx2);
    } else {
      add32(esi + 7, eax);
      if (ebx2 > s32(esi + 7)) return;
      w32(esi + 7, ebx2);
    }
  }
  function eff_vibrato(eax, ebx, esi) {             // 0x2d45a
    let edx = u8(esi + 0x34) | ((u8(esi + ebx + 0xb1) & 3) << 8);
    edx = s8(S + edx + 0x1570);
    eax = Math.imul(eax, edx) >> 3;
    add32(esi + 0xb, -eax);
    if (s32(S + 0x23) !== 0) w8(esi + 0x34, u8(esi + 0x34) + ((u8(esi + ebx + 0xb0) << 2) & 0xff));
  }
  function eff_setvol(eax, ebx, esi) { w8(esi, u8(esi) | 0x80); w32(esi + 0xf, eax); w32(esi + 0x13, 0); }   // 0x2d48c
  function eff_volslide(eax, ebx, esi) {            // 0x2d49a
    eax = (eax + s32(esi + 0xf)) | 0;
    if (eax < 0) eax = 0; else if ((eax >>> 0) > 0x40) eax = 0x40;
    w32(esi + 0xf, eax); w32(esi + 0x13, 0);
  }
  function eff_tremolo(eax, ebx, esi) {             // 0x2d4b6
    let edx = u8(esi + 0x35) | ((u8(esi + ebx + 0xb1) & 3) << 8);
    edx = s8(S + edx + 0x1570);
    w32(esi + 0x13, Math.imul(eax, edx) >> 4);
    w8(esi + 0x35, u8(esi + 0x35) + ((u8(esi + ebx + 0xb0) << 2) & 0xff));
  }
  function eff_notecut(eax, ebx, esi) {             // 0x2d4e2
    if (eax !== s32(S + 0x23)) return;
    w8(esi, u8(esi) | 0x80); w32(esi + 0xf, 0); w32(esi + 0x13, 0);
  }
  function eff_tremor(eax, ebx, esi) {              // 0x2d4f9
    let edx = eax >>> 4; eax = (eax & 0xf) + 1; edx = edx + 1 + eax;
    let e = s32(S + 0x23);
    for (;;) { const before = e >>> 0; e = (e - edx) | 0; if (!(before > (edx >>> 0))) break; }   // sub ebx,edx; ja
    e = (-e) | 0;
    w8(esi, u8(esi) | 0x80);
    w32(esi + 0x13, -0x40);
    if ((e >>> 0) < (eax >>> 0)) return;
    w32(esi + 0x13, 0);
  }
  function eff_setglobal(eax) {                      // 0x2d535
    if (u8(S + 0x1c) !== 4) return;
    w32(S + 0x1e, eax);
  }
  function eff_globalslide(eax) {                    // 0x2d524
    eax = (eax + s32(S + 0x1e)) | 0;
    if (eax < 0) eax = 0; else if ((eax >>> 0) > 0x40) eax = 0x40;
    eff_setglobal(eax);
  }
  function eff_setpan(eax, ebx, esi) { w32(esi + 0x1b, eax); }   // 0x2d54c
  function eff_panslide(eax, ebx, esi) {            // 0x2d53f
    eax = (eax + s32(esi + 0x1b)) | 0;
    if ((eax & 0xff00) !== 0) { eax = (eax >> 31) + 1; eax = (eax & ~0xff) | ((-eax) & 0xff); }
    w32(esi + 0x1b, eax);
  }
  function eff_patjump(eax) { w8(S + 0x2b, 1); w32(S + 0x30, eax); w32(S + 0x34, 0); }   // 0x2d550
  function eff_patbreak(eax) { w8(S + 0x2b, 1); add32(S + 0x30, 1); w32(S + 0x34, eax); }  // 0x2d55f
  function eff_patdelay(eax) { w32(S + 0x27, Math.imul(eax, s32(S + 0x68))); }            // 0x2d56a
  function eff_patloop(eax) {                        // 0x2d572
    if (eax === 0) { w32(S + 0x43, s32(S + 0x34)); return; }
    if (s32(S + 0x47) <= 0) w32(S + 0x47, eax + 1);
    add32(S + 0x47, -1);
    if (s32(S + 0x47) === 0) return;
    w8(S + 0x2b, 1); w32(S + 0x34, s32(S + 0x43));
  }
  function eff_setspeed(eax) {                       // 0x2d598
    if (eax === 0) { w8(S + 0x2b, 1); w32(S + 0x30, s32(S + 0x54)); w32(S + 0x34, 0); w8(S + 0x36b9, 1); return; }
    w32(S + 0x68, eax);
  }
  function eff_setbpm(eax) { setBPM(eax); }          // 0x2d5ba
  function eff_sampleoffset(eax, ebx, esi) {         // 0x2d5c3
    const cl = (8 - u8(esi + 0xe4)) & 31;
    add32(esi + 0x44, eax << cl);
  }
  function eff_notedelay(eax, ebx, esi) {            // 0x2d5d3
    const t = s32(S + 0x23);
    if ((eax >>> 0) < (t >>> 0)) return;
    if (eax === t) { w8(esi + 0x23, 1); return; }
    return true;
  }
  function eff_keyoff(eax, ebx, esi) {               // 0x2d5e3
    if (!(u8(esi) & 0xc)) return;
    w8(esi, u8(esi) & 0xfe);
    const b = u32(esi + 0x3b);
    if (u8(b + 1) & 2) return;
    w8(esi, u8(esi) | 0x80); w32(esi + 0xf, 0); w32(esi + 0x13, 0);
  }
  function eff_envpos(eax, ebx, esi) {               // 0x2d5f9
    if (!(u8(esi) & 0xc)) return;
    let b = u32(esi + 0x3b); let dl = u8(b + 1); b += 2;
    if (dl & 1) b += 0x60;
    dl >>= 1;
    if (!(dl & 1)) return;
    let edx = 0, ebp = 0;
    while ((edx & 0xff) < u8(b)) {
      edx++; ebp = u16(b + edx * 4 + 4);
      const before = eax >>> 0; eax = (eax - ebp) | 0;
      if (!(before > ebp)) break;          // sub eax,ebp; ja loop
    }
    eax = (eax + ebp) | 0;
    w32(esi + 0x26, edx); w16(esi + 0x24, eax);
  }
  function eff_retrig(eax, ebx, esi) {               // 0x2d62c
    if (!(u8(esi) & 4)) return;
    let edx = s32(S + 0x23);
    if (eax === 0) { if (edx !== 0) return; }
    else { for (;;) { const before = edx >>> 0; edx = (edx - eax) | 0; if (!(before > (eax >>> 0))) break; } if (edx !== 0) return; }
    w8(esi, u8(esi) ^ 0xe);
    const b = u32(esi + 0x3f); w32(esi + 0x44, u32(b + 0xc));
  }
  function eff_retrigvol(eax, ebx, esi) {            // 0x2d64f
    add32(esi + 0x1f, 1);
    if ((u32(esi + 0x1f)) < (eax >>> 0)) return;
    w32(esi + 0x1f, 0); w32(esi + 0x13, 0);
    let dl = u8(esi + ebx + 0xb0); let cl = dl & 7; let e = 0;
    if (cl !== 0) {
      if (cl < 6) {
        e = 1; if (!(dl & 8)) e = -1;
        cl--; e = e << cl;
        e = (e + s32(esi + 0xf)) | 0;
        if (e < 0) e = 0;
      } else {
        let a = 2, b = 3;
        if (dl & 1) { a--; b--; }
        if (dl & 8) { const t = a; a = b; b = t; }
        e = Math.imul(a, s32(esi + 0xf));    // imul [esi+0xf] (edx:eax), idiv ebx -> small values
        e = (e / b) | 0;
      }
      let edx2 = 0x40; if ((e >>> 0) <= 0x40) edx2 = e;
      w32(esi + 0xf, edx2);
    }
    if (!(u8(esi) & 4)) return;
    w8(esi, u8(esi) ^ 0xe);
    const sb = u32(esi + 0x3f); w32(esi + 0x44, u32(sb + 0xc));
  }
  function eff_note(eax, ebx, esi, ecx) {            // 0x2d6cb: eax = instrument number (1-based)
    eax = (eax - 1) | 0;
    if (eax >= 0) {
      let edx = u8(esi + 1) - 1;
      if (edx >= 0) {
        if (u8(esi) & 4) w8(esi, u8(esi) ^ 6);
        const ih = u32(S + 0x570 + eax * 4);
        w32(esi + 0x3b, ih);
        if (!ih) return;
        let dh = 0;
        if (u8(ih + 1) & 1) dh = u8(ih + edx + 2);
        if (dh >= u8(ih)) return;
        let sh = u32(S + 0x770 + eax * 4);
        for (; dh > 0; dh--) sh = (sh + u32(sh)) | 0;
        w32(esi + 0x3f, sh);
        const start = s32(sh + 0xc);
        if (start === -1) return;
        w32(esi + 0x44, start);
        w32(esi + 0x48, (start + s32(sh + 4)) | 0);
        w32(esi + 0x4c, (start + s32(sh + 8)) | 0);
        const fl = u8(sh + 0x10);
        w8(esi + 0x43, fl);
        w8(esi + 0xe4, (fl & 0x80) ? u8(sh + 0x15) : 0);
        const base = ((s8(sh + 0x12) << 6) + s8(sh + 0x11) + 0x600) | 0;
        w32(esi + 3, base);
        w32(esi + 7, periodConv((base + (edx << 6)) | 0));
        w8(esi, u8(esi) | 8);
      }
      if (u8(esi + ecx + 0xa7) === 0) return;
      w8(esi, u8(esi) | 1);
      w32(esi + 0xf, 0); w32(esi + 0x13, 0); w32(esi + 0x17, 0x8000);
      w16(esi + 0x24, 0); w32(esi + 0x26, 0); w32(esi + 0x8e, 0x100);
      w16(esi + 0x2a, 0); w32(esi + 0x2c, 0); w32(esi + 0x92, 0x80);
      w8(esi + 0x36, 0); w32(esi + 0x37, 0);
      if (!(u8(esi + 0xba) & 4)) w8(esi + 0x34, 0);
      if (!(u8(esi + 0xc3) & 4)) w8(esi + 0x35, 0);
      if (!(u8(esi) & 0xc)) return;
      const sh = u32(esi + 0x3f);
      w32(esi + 0xf, u8(sh + 0x13)); w32(esi + 0x1b, u8(sh + 0x14));
    }
  }
  const EFF = [eff_arpeggio, eff_porta, eff_porta, eff_porta, eff_porta, eff_xporta, eff_xporta, eff_toneporta, eff_none, eff_vibrato,
    eff_none, eff_none, eff_setvol, eff_volslide, eff_volslide, eff_volslide, eff_volslide, eff_volslide, eff_tremolo, eff_none, eff_none,
    eff_notecut, eff_tremor, eff_setglobal, eff_globalslide, eff_setpan, eff_panslide, eff_panslide, eff_patjump, eff_patbreak, eff_patdelay,
    eff_patloop, eff_setspeed, eff_setbpm, eff_sampleoffset, eff_notedelay, eff_keyoff, eff_envpos, eff_retrig, eff_retrigvol,
    eff_none, eff_none, eff_none, eff_none, eff_none, eff_none, eff_none, eff_none, eff_note];

  // 0x2d342: per-tick effect processing
  function processEffects() {
    const nch = u32(S + 0x58);
    for (let ch = 0; ch < nch; ch++) {
      const esi = CHN + ch * CHSZ;
      w32(esi + 0xb, 0);
      for (let ecx = u8(esi + 0x9e) - 1; ecx >= 0; ecx--) {
        const ebx = u8(esi + ecx + 0x9f);
        const dl = EFF_FLAGS[ebx];
        let call = false;
        if (u8(esi + 0x23) !== 0) {
          let al = u8(esi + ecx + 0xa7);
          let store = true;
          if (dl & 0x30) {
            if (al === 0) store = false;
            else if (dl & 0x20) {
              const ah = al >> 4;
              if (ah !== 0) w8(esi + ebx + 0xb0, ah);
              al &= 0xf;
              if (al === 0) store = false;
            }
          }
          if (store) w8(esi + ebx + 0xaf, al);
          call = (dl & 4) !== 0;
        } else call = (dl & 8) !== 0;
        if (!call) continue;
        let eax = u8(esi + ebx + 0xaf);
        if (dl & 1) eax = -eax; else if (dl & 2) eax = (eax << 24) >> 24;
        if (EFF[ebx](eax | 0, ebx, esi, ecx) === true) ecx = 0;
      }
      w8(esi + 0x23, 0);
    }
  }

  // 0x2d28e: advance to next row / pattern
  function nextRow() {
    let ecx = s32(S + 0x34), ebp = s32(S + 0x38), ebx = s32(S + 0x30), edx = u32(S + 0x3d);
    const jump = u8(S + 0x2b) & 1; w8(S + 0x2b, u8(S + 0x2b) >> 1);
    let load = false;
    if (!jump) {
      ecx++;
      if (ecx < ebp) { load = false; }
      else { ebx++; ecx = 0; load = true; }
    } else load = true;
    if (load) {
      for (;;) {
        w32(S + 0x2c, ecx); w8(S + 0x42, 0);
        if ((ebx >>> 0) >= u32(S + 0x50)) { ebx = s32(S + 0x54); w8(S + 0x36b9, 1); }
        edx = u32(S + 0x170 + u8(S + ebx + 0x70) * 4);
        ebp = 0x40;
        if (edx !== 0) {
          ebp = s32(edx + 4); const len = u32(edx); edx = (edx + 8) >>> 0;
          if (len > 8) {
            if (ecx < ebp) break;           // 0x2d2a0: cmp ecx,ebp; jb 0x2d2e1
            ebx++; ecx = 0; continue;       // next pattern
          }
        }
        edx = 0;
        break;
      }
    }
    w32(S + 0x34, ecx); w32(S + 0x38, ebp); w32(S + 0x30, ebx);
    // read rows (skipping [0x2c] rows)
    const nch = u32(S + 0x58);
    do {
      for (let ch = 0; ch < nch; ch++) {
        const esi = CHN + ch * CHSZ;
        let al = 0; w8(esi + 1, 0);
        if (edx !== 0) { al = u8(edx); edx++; }
        w8(esi + 0x9e, al);
        for (let c = al - 1; c >= 0; c--) {
          let w = u16(edx); edx += 2;
          let lo = w & 0xff, hi = w >> 8;
          if (lo & 0x80) { w8(esi + 1, lo & 0x7f); lo = 0x30; }
          w8(esi + c + 0x9f, lo); w8(esi + c + 0xa7, hi);
        }
        w8(esi + 0x23, 1);
      }
      add32(S + 0x2c, -1);
    } while (s32(S + 0x2c) >= 0);
    w32(S + 0x3d, edx);
  }

  // 0x2d9cf: envelope step. returns {eax, ecx, bp}
  const envR = { eax: 0, ecx: 0, bp: 0 };
  function envelope(ebx, ecx, bp, esi) {
    let eax = u16(ebx + ecx * 4 + 6);
    if (bp < u16(ebx + ecx * 4 + 4)) {
      let ax = (eax - u16(ebx + ecx * 4 + 2)) & 0xffff; ax = (ax << 16) >> 16;
      const prod = Math.imul(ax, (bp << 16) >> 16);         // imul bp: dx:ax = ax*bp (signed 16x16)
      const divisor = s16(ebx + ecx * 4 + 4);
      let q = (prod / divisor) | 0;                          // idiv word
      eax = (q + s16(ebx + ecx * 4 + 2)) & 0xffff;           // add ax,...
      envR.eax = eax; envR.ecx = ecx; envR.bp = (bp + 1) & 0xffff; return envR;
    }
    let dl = (u8(esi) & 1) ? 1 : 0;
    if ((ecx & 0xff) === u8(ebx + 3)) dl |= 2;
    if ((ecx & 0xff) === u8(ebx + 1)) dl |= 4;
    if (dl === 5) { envR.eax = eax; envR.ecx = ecx; envR.bp = bp; return envR; }
    let ebp = -1;
    if (dl !== 6 && (dl & 2)) { ecx = (ecx & ~0xff) | u8(ebx + 2); eax = u16(ebx + ecx * 4 + 6); }
    if ((ecx & 0xff) >= u8(ebx)) { envR.eax = eax; envR.ecx = ecx; envR.bp = ebp & 0xffff; return envR; }
    ecx++; ebp++; ebp++;
    envR.eax = eax; envR.ecx = ecx; envR.bp = ebp & 0xffff; return envR;
  }

  // 0x2d80e: per-tick voice parameter computation
  function updateVoices() {
    const nch = u32(S + 0x58);
    for (let ch = 0; ch < nch; ch++) {
      const esi = CHN + ch * CHSZ;
      if (!(u8(esi) & 0xc)) continue;
      let edx = (s32(esi + 0xf) + s32(esi + 0x13)) | 0;
      let eax = 0;
      if (edx >= 0) { eax = 0x40; if ((edx >>> 0) <= 0x40) eax = edx; }
      eax = Math.imul(eax, s32(S + 0x1e)) >>> 4;        // imul [0x1e]; shr eax,4 (low 32 bits)
      w32(esi + 0x54, eax); w32(esi + 0x86, eax);
      eax = s32(esi + 0x1b); w32(esi + 0x58, eax); w32(esi + 0x8a, eax);
      let ebx = u32(esi + 0x3b);
      let al = u8(ebx + 1); ebx += 2;
      if (al & 1) ebx += 0x60;
      al >>= 1;
      w8(S + 0x22, al);
      if (al & 1) {    // volume envelope
        const r = envelope(ebx, s32(esi + 0x26), u16(esi + 0x24), esi);
        w32(esi + 0x26, r.ecx); w16(esi + 0x24, r.bp);
        eax = r.eax;
        edx = u8(ebx); ebx += edx * 4 + 0xa;
        edx = s32(esi + 0x17);
        if (!(u8(esi) & 1)) {
          edx = (edx - u16(ebx - 2)) | 0;
          if (edx < 0) edx = 0;
          w32(esi + 0x17, edx);
        }
        eax = Math.imul(eax, edx) >>> 15;
        w32(esi + 0x8e, eax);
        eax = Math.imul(eax, s32(esi + 0x54)) >>> 8;
        w32(esi + 0x54, eax);
      }
      al = u8(S + 0x22) >> 1; w8(S + 0x22, al);
      if (al & 1) {    // panning envelope
        const r = envelope(ebx, s32(esi + 0x2c), u16(esi + 0x2a), esi);
        w32(esi + 0x2c, r.ecx); w16(esi + 0x2a, r.bp);
        eax = r.eax;
        w32(esi + 0x92, eax);
        edx = u8(ebx); ebx += edx * 4 + 8;
        edx = s32(esi + 0x58); const ebp = edx;
        edx = (edx - 0x80) | 0; if (edx >= 0) edx = -edx; edx = (edx + 0x80) | 0;
        eax = (eax - 0x80) | 0;
        eax = Math.imul(eax, edx) >> 7;
        eax = (eax + ebp) | 0;
        w32(esi + 0x58, eax);
      }
      al = u8(S + 0x22) >> 1; w8(S + 0x22, al);
      if (al & 1) {    // auto vibrato
        edx = u8(esi + 0x36);
        w8(esi + 0x36, edx + u8(ebx + 3));
        edx |= u8(ebx) << 8;
        eax = s8(S + edx + 0x1570);
        edx = u8(ebx + 2);
        eax = Math.imul(eax, edx);
        const ebp = u8(ebx + 1);
        if (ebp !== 0) {
          edx = s32(esi + 0x37);
          if ((edx >>> 0) <= ebp) {
            if (!(u8(esi) & 1)) { /* fallthrough to shift with current eax? no: je 0x2d934 -> skip entirely */ eax = null; }
            else { add32(esi + 0x37, 1); eax = (Math.imul(eax, edx) / ebp) | 0; }
          }
        }
        if (eax !== null) { eax = eax >> 6; add32(esi + 0xb, eax); }
      }
      // frequency
      if (!(u32(S + 0x64) & 1)) {   // 0x2d93d: Amiga period path (unused: the module uses linear frequencies)
        let ebx2 = (-((s32(esi + 7) + s32(esi + 0xb)) | 0)) | 0;
        eax = 0x105580;
        if (ebx2 >= 0xe) { eax = Math.floor(0xda7790 / (ebx2 >>> 0)); if (!(eax > 0x83)) eax = 0x83; }
        const sh = u32(esi + 0xe0);
        eax = Math.imul(eax, u32(S + sh * 4 + 0x3679)) >>> 0;   // mul: low dword
        w32(esi + 0xe0, 0);
        eax = eax >>> (u8(esi + 0xe4) & 31);
      } else {
        eax = (s32(esi + 7) + s32(esi + 0xb)) | 0;
        if (eax < 0) eax = 0;
        let q = Math.floor((eax >>> 0) / 0x300), r = (eax >>> 0) % 0x300;
        let ecx = 0xc - q;
        if (ecx < 0) { r = 0x2ff; ecx = 0; }
        eax = (u32(S + r * 4 + 0x970) << 8) >>> 0;
        ecx = (ecx + u8(esi + 0xe4)) & 0xff;
        eax = eax >>> (ecx & 31);
      }
      w32(esi + 0x50, mulhi(eax, u32(S + 0x4b)));
    }
  }

  // 0x2d246: per-tick bookkeeping (before row processing)
  function tickPrep() {
    const nch = u32(S + 0x58);
    for (let ch = 0; ch < nch; ch++) {
      const esi = CHN + ch * CHSZ;
      w32(esi + 0x64, u32(esi + 0x54)); w32(esi + 0x6c, u32(esi + 0x60)); w32(esi + 0x68, u32(esi + 0x5c));
      w32(esi + 0x96, u32(esi + 0x8e)); w32(esi + 0x9a, u32(esi + 0x92));
      if (u8(esi) & 8) w8(esi, u8(esi) ^ 0xc);
      w8(esi, u8(esi) & 0x7d);
    }
  }

  // 0x2d1d0: player tick
  function tick() {
    tickPrep();
    if (u8(S + 0x1c) >= 3) {
      if (s32(S + 0x23) === 0) { w32(S + 0x27, 0); nextRow(); }
      processEffects();
      updateVoices();
      add32(S + 0x23, 1);
      if (((s32(S + 0x68) + s32(S + 0x27)) | 0) === s32(S + 0x23)) w32(S + 0x23, 0);
      if (u8(S + 0x1c) === 3) { add32(S + 0x1e, -1); if (s32(S + 0x1e) < 0) w8(S + 0x1c, u8(S + 0x1c) - 1); }
    } else if (u8(S + 0x1c) !== 0) {
      if (u8(S + 0x1c) === 2) {
        const nch = u32(S + 0x58);
        for (let ch = 0; ch < nch; ch++) { const esi = CHN + ch * CHSZ; if (u8(esi) & 4) w8(esi, u8(esi) ^ 6); }
      }
      w8(S + 0x1c, u8(S + 0x1c) - 1);
    }
  }

  // ------------------------------------------------------------------ mixer (0x2eb6a etc.)
  // 0x2e953: clip sample run to loop/end; returns count (ecx) and step (ebp, signed) ; updates esi+0x7a.. via edi
  const run = { ecx: 0, ebp: 0, edi: 0 };
  function clipRun(esi, ecx, edi) {
    let ebp = s32(esi + 0x82);
    for (;;) {
      if (u8(esi + 0x79) !== 1) {
        let edx = (edi - s32(esi + 0x75)) | 0;
        if (edx >= 0) {   // 0x2e99a
          const fl = u8(esi + 0x70);
          if (!(fl & 8)) { edi = s32(esi + 0x75); w8(esi + 0x79, 2); ebp = 0; break; }
          if (!(fl & 0x10)) { edi = (edx + s32(esi + 0x71)) | 0; continue; }
          // ping-pong reflect at end
          const fr = s32(esi + 0x7e); const nf = (-fr) | 0; w32(esi + 0x7e, nf);
          const borrow = fr !== 0 ? 1 : 0;
          edi = (s32(esi + 0x75) - edx - borrow) | 0;
          w8(esi + 0x79, 1);
          continue;
        }
        // distance check (forward)
        const frac = u32(esi + 0x7e) >>> 16;
        const d64 = edx * 65536 + frac;                 // (pos-end)*2^16 + frac, negative
        const edxh = edx >> 16;
        ebp = (-ebp) | 0;
        if (edxh > ebp) {
          let n = Math.trunc(d64 / ebp) + 1;
          ebp = (-ebp) | 0;
          if ((n >>> 0) <= (ecx >>> 0)) ecx = n;
        }
        break;   // (far from the end: the asm leaves ebp negated here; unreachable in practice)
      } else {
        let edx = (edi - s32(esi + 0x71)) | 0;
        if (edx < 0) {   // 0x2e9bb: reflect at loop start
          const fr = s32(esi + 0x7e); const nf = (-fr) | 0; w32(esi + 0x7e, nf);
          const borrow = fr !== 0 ? 1 : 0;
          edi = (s32(esi + 0x71) - edx - borrow) | 0;
          w8(esi + 0x79, 0);
          continue;
        }
        const frac = u32(esi + 0x7e) >>> 16;
        const d64 = edx * 65536 + frac;
        const edxh = edx >> 16;
        if (edxh >= ebp) break;
        let n = Math.trunc(d64 / ebp) + 1;
        ebp = (-ebp) | 0;
        if ((n >>> 0) <= (ecx >>> 0)) ecx = n;
        break;
      }
    }
    add32(MIX + 8, -ecx);
    run.ecx = ecx; run.ebp = ebp; run.edi = edi;
    return run;
  }
  // 0x2e9d6: advance position by ecx steps without mixing
  function advance(esi, ebp, ecx, edi) {
    const prod = ebp * ecx;                         // signed, exact in double
    const hi = Math.floor(prod / 65536);
    const lo = prod - hi * 65536;
    edi = (edi + hi) | 0;
    add32(esi + 0x7e, (lo << 16) | 0);
    return edi;
  }
  // 0x2e9e7: start voice
  function startVoice(esi) {
    const edi = s32(esi + 0x44);
    w32(esi + 0x7a, edi);
    w32(esi + 0x71, u32(esi + 0x48)); w32(esi + 0x75, u32(esi + 0x4c));
    w8(esi + 0x70, u8(esi + 0x43));
    w32(esi + 0x7e, 0); w8(esi + 0x79, 0);
    return edi;
  }
  // 0x2ed09: 64-sample volume ramp mix
  function rampMix(esi, edi) {
    let req = 0x40;                                  // 0x2ed09: first run asks for 64 samples,
    do {                                             // re-entries (0x2ed0e) ask for the ramp remainder
      let r = clipRun(esi, req, edi);
      let ecx = r.ecx, ebp = r.ebp; edi = r.edi;
      ecx = (ecx + s32(MIX + 8)) | 0;
      ecx--;
      const rem = s32(MIX + 8);
      if (!(u8(esi + 0x70) & 4)) {
        const stepLo = ebp & 0xffff, stepHi = ebp >> 16;
        let bp = u32(esi + 0x7e) >>> 16;
        let vl = s32(MIX + 0x10);
        let vr = s32(MIX + 0x14);
        const dl = s32(MIX + 0x1c), dr = s32(MIX + 0x20);
        do {
          let eax = s8(edi), edx = (s8(edi + 1) - eax) | 0;
          edx = Math.imul(edx, bp);
          eax = (eax << 8) + (edx >> 8);
          edx = Math.imul(eax, vl); eax = Math.imul(eax, vr);
          edx = edx >> 6; eax = eax >> 6;
          add32(ACC + ecx * 8 + 4, edx); add32(ACC + ecx * 8, eax);
          ecx--;
          const sum = bp + stepLo; bp = sum & 0xffff; edi = (edi + stepHi + (sum >> 16)) | 0;
          vr = (vr - dr) | 0; vl = (vl - dl) | 0;
          w32(MIX + 0x14, vr);
        } while (ecx >= rem);
        w32(esi + 0x7e, (bp << 16) | 0);
        w32(MIX + 0x10, vl);
      } else {
        const stepRaw = ((ebp >>> 1) | 0xffff8000) | 0, stepHi = ebp >> 16;
        let bp = u32(esi + 0x7e) >>> 17;
        let vl = s32(MIX + 0x10);
        let vr = s32(MIX + 0x14);
        const dl = s32(MIX + 0x1c), dr = s32(MIX + 0x20);
        do {
          let eax = s16(edi * 2), edx = (s16(edi * 2 + 2) - eax) | 0;
          edx = Math.imul(edx, bp) >> 15;
          eax = (eax + edx) | 0;
          edx = Math.imul(eax, vl); eax = Math.imul(eax, vr);
          edx = edx >> 6; eax = eax >> 6;
          add32(ACC + ecx * 8 + 4, edx); add32(ACC + ecx * 8, eax);
          ecx--;
          const sum = (bp + stepRaw);             // 32-bit add with carry detection
          const carry = (bp + (stepRaw >>> 0)) >= 4294967296 ? 1 : 0;
          edi = (edi + stepHi + carry) | 0;
          bp = sum & 0x7fff;
          vr = (vr - dr) | 0; vl = (vl - dl) | 0;
          w32(MIX + 0x14, vr);
        } while (ecx >= rem);
        w32(esi + 0x7e, (bp << 17) | 0);
        w32(MIX + 0x10, vl);
      }
      req = (s32(MIX + 8) + 0x40 - s32(MIX + 0x18)) | 0;
    } while (req > 0);
    return edi;
  }
  // 0x2eb6a: mix one channel for the current tick (esi = channel); edi = position in/out ([esi+0x7a])
  function mixChannel(esi) {
    let edi = s32(esi + 0x7a);
    const frames = s32(MIX + 0x18);
    let fl = u8(esi);
    if (fl & 2) {   // ramp out the previous voice
      const eax = s32(esi + 0x68), edx = s32(esi + 0x6c);
      w32(MIX + 0x1c, eax); w32(MIX + 0x20, edx);
      w32(MIX + 0x10, eax << 6); w32(MIX + 0x14, edx << 6);
      w32(MIX + 8, frames);
      edi = rampMix(esi, edi);
    }
    for (;;) {
      fl = u8(esi);
      if (!(fl & 0xc)) { w32(esi + 0x7a, edi); return; }
      let eax = Math.imul(s32(esi + 0x54), s32(MIX + 0x24)) >>> 3; eax = (-eax) | 0;
      let edx = s32(esi + 0x58);
      edx = (Math.imul(edx, edx) - 0x10000) | 0; edx = Math.imul(edx, eax) >>> 16;
      w32(esi + 0x5c, edx);
      edx = (s32(esi + 0x58) - 0x100) | 0;
      edx = (Math.imul(edx, edx) - 0x10000) | 0; edx = Math.imul(edx, eax) >>> 16;
      w32(esi + 0x60, edx);
      w32(esi + 0x82, u32(esi + 0x50));
      w32(MIX + 8, frames);
      let startNew = false;
      if (fl & 8) { edi = startVoice(esi); startNew = true; }
      else if (u8(esi + 0x79) === 2) {
        // voice ended last tick: ramp it out and stop
        w8(esi, fl & 0xfb);
        const a = s32(esi + 0x68), d = s32(esi + 0x6c);
        w32(MIX + 0x1c, a); w32(MIX + 0x20, d);
        w32(MIX + 0x10, a << 6); w32(MIX + 0x14, d << 6);
        w32(MIX + 8, frames);
        edi = rampMix(esi, edi);
        continue;
      }
      let pl, pr;
      if (startNew) { pl = 0; pr = 0; } else { pl = s32(esi + 0x68); pr = s32(esi + 0x6c); }
      w32(MIX + 0x10, pl); w32(MIX + 0x14, pr);
      const dl = (pl - s32(esi + 0x5c)) | 0, dr = (pr - s32(esi + 0x60)) | 0;
      w32(MIX + 0x1c, dl); w32(MIX + 0x20, dr);
      if ((dl | dr) !== 0) {
        w32(MIX + 0x10, pl << 6); w32(MIX + 0x14, pr << 6);
        edi = rampMix(esi, edi);
      }
      w32(MIX + 0x10, s32(esi + 0x5c)); w32(MIX + 0x14, s32(esi + 0x60));
      do {
        const r = clipRun(esi, s32(MIX + 8), edi);
        let ecx = r.ecx, ebp = r.ebp; edi = r.edi;
        if (s32(esi + 0x54) === 0) { edi = advance(esi, ebp, ecx, edi); continue; }
        ecx--;
        const rem = s32(MIX + 8);
        const vl = s32(MIX + 0x10), vr = s32(MIX + 0x14);
        if (!(u8(esi + 0x70) & 4)) {
          const stepLo = ebp & 0xffff, stepHi = ebp >> 16;
          let bp = u32(esi + 0x7e) >>> 16;
          let acc = ACC + rem * 8;
          while (ecx >= 0) {
            let eax = s8(edi), edx = (s8(edi + 1) - eax) | 0;
            edx = Math.imul(edx, bp);
            eax = (eax << 8) + (edx >> 8);
            edx = Math.imul(eax, vl); eax = Math.imul(eax, vr);
            add32(acc + ecx * 8 + 4, edx); add32(acc + ecx * 8, eax);
            const sum = bp + stepLo; bp = sum & 0xffff; edi = (edi + stepHi + (sum >> 16)) | 0;
            ecx--;
          }
          w32(esi + 0x7e, (bp << 16) | 0);
        } else {
          const stepRaw = ((ebp >>> 1) | 0xffff8000) | 0, stepHi = ebp >> 16;
          let bp = u32(esi + 0x7e) >>> 17;
          let acc = ACC + rem * 8;
          while (ecx >= 0) {
            let eax = s16(edi * 2), edx = (s16(edi * 2 + 2) - eax) | 0;
            edx = Math.imul(edx, bp) >> 15;
            eax = (eax + edx) | 0;
            edx = Math.imul(eax, vl); eax = Math.imul(eax, vr);
            add32(acc + ecx * 8 + 4, edx); add32(acc + ecx * 8, eax);
            const carry = (bp + (stepRaw >>> 0)) >= 4294967296 ? 1 : 0;
            edi = (edi + stepHi + carry) | 0;
            bp = (bp + stepRaw) & 0x7fff;
            ecx--;
          }
          w32(esi + 0x7e, (bp << 17) | 0);
        }
      } while (s32(MIX + 8) > 0);
      w32(esi + 0x7a, edi);
      return;
    }
  }

  // 0x2e922: convert accumulator to output words (n frames), reset accumulator
  function convert(out, outPos, n) {
    let ecx = n * 2 - 1;
    let k = 0;
    for (; ecx >= 0; ecx--) {
      let eax = s32(ACC + ecx * 4) >> 10;
      if ((eax >>> 0) >= 0x10000) eax = ~(eax >> 31);
      w32(ACC + ecx * 4, 0x2000001);
      out[outPos + k] = ((eax & 0xffff) ^ 0x8000) << 16 >> 16;
      k++;
    }
  }

  // ------------------------------------------------------------------ driver loop (0x2e823, sequential)
  let tickCount = 0;
  let totalFrames = 0;
  let pendingJump = null;
  const tickLog = [];          // per tick: frame index of its first output frame, order, row, tick (for positionAtFrame)
  let pending = new Int16Array(0x1d4c * 2), pendingLen = 0, pendingPos = 0;
  const hooks = { beforeTick: null, afterTick: null, beforeMixChannel: null };

  function runTick() {
    // output conversion of what was mixed for the previous tick
    const n = s32(D + 0x64);
    w16(D + 0x22, u16(D + 0x22) + n); add32(D + 0x22, 0);
    convert(pending, 0, n); pendingLen = n * 2; pendingPos = 0;
    totalFrames += n;
    if (hooks.beforeTick) hooks.beforeTick(api);
    if (pendingJump !== null && u8(S + 0x1c) === 0) {      // continuation of 0x2d161
      w8(S + 0x2b, 1); add32(S + 0x30, pendingJump); if (s32(S + 0x30) < 0) w32(S + 0x30, 0);
      w32(S + 0x34, 0); w32(S + 0x23, 0); pendingJump = null;
      w8(S + 0x1d, u8(S + 0x1d) - 1);
      if (u8(S + 0x1d) === 0 && u32(S + 0x58) !== 0) w8(S + 0x1c, 4);
    }
    tick();
    tickCount++;
    const fpt = s32(D + 0x3e);
    w32(D + 0x64, fpt);
    w32(MIX + 0x18, fpt);
    tickLog.push(totalFrames, s32(S + 0x30), s32(S + 0x34), s32(S + 0x23));
    if (hooks.afterTick) hooks.afterTick(api);
    const nch = u32(D + 0x32);
    for (let ch = 0; ch < nch; ch++) {
      if (hooks.beforeMixChannel) hooks.beforeMixChannel(api, ch);
      mixChannel(CHN + ch * CHSZ);
    }
  }

  const api = {
    mem, S, D, MOD, CHN, CHSZ, MIX, ACC,
    u8, s8, u16, s16, u32, s32, w8, w16, w32,
    hooks,
    random,
    // render nframes of interleaved stereo int16 into out (starting at offset); returns frames written
    render(out, nframes, offset) {
      offset = offset | 0;
      let done = 0;
      while (done < nframes) {
        if (pendingPos >= pendingLen) runTick();
        const avail = (pendingLen - pendingPos) >> 1;
        const take = Math.min(avail, nframes - done);
        out.set(pending.subarray(pendingPos, pendingPos + take * 2), offset + done * 2);
        pendingPos += take * 2; done += take;
      }
      return done;
    },
    // run one tick, returning the Int16 frames produced for the *previous* tick
    tickOnce() { runTick(); return pending.subarray(0, pendingLen); },
    // position of the player state (i.e. after the last tick processed; its audio is the most recently produced frames)
    position() {
      return { order: s32(S + 0x30), row: s32(S + 0x34), tick: s32(S + 0x23), speed: s32(S + 0x68), bpm: curBPM,
        ticks: tickCount, frames: totalFrames, framesPerTick: s32(D + 0x3e), playState: u8(S + 0x1c),
        globalVolume: s32(S + 0x1e), looped: u8(S + 0x36b9), pattern: u8(S + 0x70 + s32(S + 0x30)) };
    },
    // song position audible at output frame f (0 = first rendered frame): {order,row,tick,tickIndex}
    positionAtFrame(f) {
      let lo = 0, hi = (tickLog.length >> 2) - 1;
      if (hi < 0) return null;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (tickLog[mid * 4] <= f) lo = mid; else hi = mid - 1; }
      return { order: tickLog[lo * 4 + 1], row: tickLog[lo * 4 + 2], tick: tickLog[lo * 4 + 3], tickIndex: lo + 1, tickFrame: tickLog[lo * 4] };
    },
    get channels() { return u32(S + 0x58); },
    channel(i) {
      const esi = CHN + i * CHSZ;
      return { flags: u8(esi), note: u8(esi + 1), period: s32(esi + 7), volume: s32(esi + 0xf), pan: s32(esi + 0x1b),
        finalVolume: s32(esi + 0x54), finalPan: s32(esi + 0x58), envVolume: s32(esi + 0x8e), instrument: u32(esi + 0x3b),
        sample: u32(esi + 0x3f), active: (u8(esi) & 0xc) !== 0, keyOn: (u8(esi) & 1) !== 0 };
    },
    setMasterVolume(v) { w32(D + 0x70, v); },                 // 0x2e51f (setvol) — default 12
    getMasterVolume() { return s32(D + 0x70); },
    setGlobalVolume(v) { w32(S + 0x1e, v); },                // 0xf6c
    jumpOrder(delta) {                                        // 0x2d161: stop (0x2d131), wait until [0x1c]==0, then jump & resume (0x2d14b)
      w8(S + 0x1d, u8(S + 0x1d) + 1);
      if (u8(S + 0x1c) !== 0) w8(S + 0x1c, 2);
      pendingJump = delta;
    },
    stop() { w8(S + 0x1d, u8(S + 0x1d) + 1); if (u8(S + 0x1c) !== 0) w8(S + 0x1c, 2); },
    // snapshot/restore of the whole player (memory + the driver loop's JS-side state), for seeking
    saveState() {
      return { mem: mem.slice(), rnd1, rnd2, curBPM, tickCount, totalFrames, pendingJump, tickLogLen: tickLog.length,
               pending: pending.slice(), pendingLen, pendingPos, glitch: api.glitch };
    },
    restoreState(st) {
      mem.set(st.mem); rnd1 = st.rnd1; rnd2 = st.rnd2; curBPM = st.curBPM; tickCount = st.tickCount; totalFrames = st.totalFrames;
      pendingJump = st.pendingJump; tickLog.length = st.tickLogLen; pending.set(st.pending); pendingLen = st.pendingLen; pendingPos = st.pendingPos;
      api.glitch = st.glitch;
    },
    // volume glitch mechanism of the intro (timer IRQ 0x2eeb1): every 30 ms, if glitch>0: random(0x400) >= glitch ? 12 : 0
    glitch: 0,
    timerGlitchStep() { if (api.glitch) { const r = (opts.random || random)(0x400); api.setMasterVolume(r >= api.glitch ? 0xc : 0); } },
  };
  return api;
}

// module location inside the intro's 32-bit image (image32.bin / selector 08 base)
const MODULE_OFFSET = 0x1090, MODULE_SIZE = 0xbc08;
function extractModule(image32) { return decrypt(image32.subarray(MODULE_OFFSET, MODULE_OFFSET + MODULE_SIZE)); }
const HPlusPlayer = { create, decrypt, extractModule, MODULE_OFFSET, MODULE_SIZE, RATE, MOD, S, D };
if (typeof module !== 'undefined' && module.exports) module.exports = HPlusPlayer;
else root.HPlusPlayer = HPlusPlayer;
})(typeof self !== 'undefined' ? self : this);
