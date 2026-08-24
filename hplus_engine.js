// hplus port — engine (3D pipeline, rasterizers, video layer). Generated from engine_p1..p4.js
// hplus port — engine part 1: vector/matrix math, rsqrt, object preparation, textures, scene loader,
// scene init.  Memory-image port: all state lives in HP.M (see PORT_CONVENTIONS.md).
//
// External functions this file needs (provided by other parts of the port):
//   HP.fn_29a (himem alloc, hplus_core.js), HP.fn_2c2c8 (RNG, core), HP.fn_2c2 (free himem, core),
//   HP.fn_e27a (main's procedural texture generator callback, installed at [0x2438a]; called as
//               HP.callTexGen(bh, bl, ecx, edx, ebx, edi) — see fn_2438e),
//   HP.fn_2c1e6 (DOS print — part 4), HP.fn_2c845 (video init — part 4).
import { HP } from './hplus_core.js';
import { ADDR } from './hplus_addr.js';

// functions this file calls from elsewhere (forwarding, so the HP entry stays late-bound
// and tools/replay.js can still swap it at runtime)
const alloc          = (...a) => HP.fn_29a(...a);     // core: fn_29a — high memory
const himemFree      = (...a) => HP.fn_2c2(...a);     // core: fn_2c2
const rand           = (...a) => HP.fn_2c2c8(...a);   // core: fn_2c2c8 — eax = range
const texGenCallback = (...a) => HP.fn_e27a(...a);    // main: fn_e27a — procedural texture generator callback

(function () {
  const { rd8, rds8, rd16, rds16, rd32, rds32, wr8, wr16, wr32, rdf, wrf, roundHalfEven, mulhi } = HP;
  const F = Math.fround;
  const rne = roundHalfEven;       // fist/fistp with RC=nearest (outside the draw loop)

  // ------------------------------------------------------------ small vector helpers (x87 routines)
  // fn_24dd0(esi=a, edi=b, ebp=dst): [dst] = a.b   (float32 result)
  HP.fn_24dd0 = function (esi, edi, ebp) {
    wrf(ebp, rdf(esi) * rdf(edi) + rdf(esi + 4) * rdf(edi + 4) + rdf(esi + 8) * rdf(edi + 8));
  };
  // fn_24dea(esi=a, edi=b, ebp=dst): dst = a x b
  HP.fn_24dea = function (esi, edi, ebp) {
    const ax = rdf(esi), ay = rdf(esi + 4), az = rdf(esi + 8), bx = rdf(edi), by = rdf(edi + 4), bz = rdf(edi + 8);
    // x87: fsubrp st(i) computes st(i) = st(0) - st(i) -> the result is b x a (NOT a x b)
    const x = az * by - ay * bz, y = ax * bz - az * bx, z = ay * bx - ax * by;
    wrf(ebp, x); wrf(ebp + 4, y); wrf(ebp + 8, z);
  };
  // fn_24e1e(esi=v): normalize v in place
  HP.fn_24e1e = function (esi) {
    const x = rdf(esi), y = rdf(esi + 4), z = rdf(esi + 8);
    const r = 1 / Math.sqrt(x * x + y * y + z * z);
    wrf(esi + 4, y * r); wrf(esi + 8, z * r); wrf(esi, x * r);
  };
  // fn_24e53(esi=v, edi=matrix(4 rows of 4 floats), ebx=dst): dst = v * M (3x3 + translation row)
  HP.fn_24e53 = function (esi, edi, ebx) {
    const x = rdf(esi), y = rdf(esi + 4), z = rdf(esi + 8);
    for (let i = 0; i < 3; i++) {
      const o = edi + i * 4;
      wrf(ebx + i * 4, x * rdf(o) + y * rdf(o + 0x10) + z * rdf(o + 0x20) + rdf(o + 0x30));
    }
  };
  // fn_24e81(esi=camera block): build the camera matrix at camera+0x24 (look-at).
  //   camera: +0 pos, +0xc target, +0x18 up, +0x24 4x4 matrix (columns right/up/dir, translation row at +0x54)
  HP.fn_24e81 = function (esi) {
    const ebp = esi;
    HP.copy(0x28e84, ebp + 0x18, 12);                  // up
    wrf(0x28e90, rdf(ebp) - rdf(ebp + 0xc));           // dir = pos - target
    wrf(0x28e94, rdf(ebp + 4) - rdf(ebp + 0x10));
    wrf(0x28e98, rdf(ebp + 8) - rdf(ebp + 0x14));
    HP.fn_24e1e(0x28e90);
    HP.fn_24dea(0x28e90, 0x28e84, 0x28e78);            // right = dir x up
    HP.fn_24e1e(0x28e78);
    HP.fn_24dea(0x28e90, 0x28e78, 0x28e84);            // up' = dir x right
    HP.fn_24e1e(0x28e84);
    wrf(ebp + 0x24, rdf(0x28e78)); wrf(ebp + 0x34, rdf(0x28e7c)); wrf(ebp + 0x44, rdf(0x28e80));
    wrf(ebp + 0x28, rdf(0x28e84)); wrf(ebp + 0x38, rdf(0x28e88)); wrf(ebp + 0x48, rdf(0x28e8c));
    wrf(ebp + 0x2c, rdf(0x28e90)); wrf(ebp + 0x3c, rdf(0x28e94)); wrf(ebp + 0x4c, rdf(0x28e98));
    const px = rdf(ebp), py = rdf(ebp + 4), pz = rdf(ebp + 8);
    wrf(ebp + 0x54, -(px * rdf(ebp + 0x24) + py * rdf(ebp + 0x34) + pz * rdf(ebp + 0x44)));
    wrf(ebp + 0x58, -(px * rdf(ebp + 0x28) + py * rdf(ebp + 0x38) + pz * rdf(ebp + 0x48)));
    wrf(ebp + 0x5c, -(px * rdf(ebp + 0x2c) + py * rdf(ebp + 0x3c) + pz * rdf(ebp + 0x4c)));
  };
  // fn_24fc4(ebx=dst 4x4): rotation matrix from angles [0x24fb8],[0x24fbc],[0x24fc0] (radians), scale [0x24fa8],
  // translation [0x24fac..0x24fb4]
  HP.fn_24fc4 = function (ebx) {
    const a = rdf(0x24fb8), b = rdf(0x24fbc), c = rdf(0x24fc0), s = rdf(0x24fa8);
    const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cc = Math.cos(c), sc = Math.sin(c);
    wrf(ebx + 0x00, (cc * cb + sc * sa * sb) * s);
    wrf(ebx + 0x04, (sc * ca) * s);
    wrf(ebx + 0x08, (cc * (-sb) + sc * sa * cb) * s);
    wrf(ebx + 0x0c, 0);
    wrf(ebx + 0x10, ((-sc) * cb + cc * sa * sb) * s);
    wrf(ebx + 0x14, (cc * ca) * s);
    wrf(ebx + 0x18, ((-sc) * (-sb) + cc * sa * cb) * s);
    wrf(ebx + 0x1c, 0);
    wrf(ebx + 0x20, (ca * sb) * s);
    wrf(ebx + 0x24, (-sa) * s);
    wrf(ebx + 0x28, (ca * cb) * s);
    wrf(ebx + 0x2c, 0);
    wrf(ebx + 0x30, rdf(0x24fac)); wrf(ebx + 0x34, rdf(0x24fb0)); wrf(ebx + 0x38, rdf(0x24fb4)); wrf(ebx + 0x3c, 1);
  };
  // fn_2515e(eax=A, ebx=B, ecx=C): C = A*B (4x4, row-major)
  HP.fn_2515e = function (eax, ebx, ecx) {
    for (let i = 0; i < 0x40; i += 0x10)
      for (let j = 0; j < 0x10; j += 4)
        wrf(ecx + i + j, rdf(eax + i) * rdf(ebx + j) + rdf(eax + i + 4) * rdf(ebx + j + 0x10) + rdf(eax + i + 8) * rdf(ebx + j + 0x20) + rdf(eax + i + 0xc) * rdf(ebx + j + 0x30));
  };

  // ------------------------------------------------------------ fast inverse sqrt (0x23f34 table, 0x23f8c)
  HP.fn_23f34 = function () {
    const p = (alloc(0x8010) | 0xf) + 1;
    wr32(0x23f30, p);
    for (let i = 0; i < 0x2000; i++) {
      const bits = ((i << 11) | 0x3f000000) >>> 0;
      const fv = new Float32Array(new Uint32Array([bits]).buffer)[0];
      const r = F(1 / Math.sqrt(fv));
      const rb = new Uint32Array(new Float32Array([r]).buffer)[0];
      wr32(p + i * 4, ((rb + 0x200) & 0x7ff800) >>> 0);
    }
    wr32(p + 0x4000, 0x7ff800);
  };
  // fn_23f8c(eax=float bits) -> ecx = float bits of ~1/sqrt(x)
  HP.fn_23f8c = function (eax) {
    eax >>>= 0;
    let ecx = 0x5f000000, ebx = ((eax >>> 1) & 0x3fc00000) >>> 0;
    ecx = (ecx - ebx) >>> 0;
    const idx = (eax >>> 9) & 0x7ffc;
    ecx = ((ecx & 0xff800000) | rd32(rd32(0x23f30) + idx)) >>> 0;
    return ecx;
  };
  const f32bits = (v) => { tmpF[0] = v; return tmpU[0]; };
  const bitsf32 = (b) => { tmpU[0] = b >>> 0; return tmpF[0]; };
  const tmpB = new ArrayBuffer(4), tmpF = new Float32Array(tmpB), tmpU = new Uint32Array(tmpB);
  HP.f32bits = f32bits; HP.bitsf32 = bitsf32;

  // ------------------------------------------------------------ object preparation (0x23fd4 .. 0x242e3)
  // object block (0x3c): +0 tag, +4 flags, +8..+0x10 center, +0x14..+0x1c angles(int), +0x20 radius, +0x24 scale,
  //   +0x28 texture/sort bias, +0x2c nverts, +0x30 nfaces, +0x34 verts, +0x38 faces
  // vertex (0x3c): +0 flags, +4 xyz, +0x10 sx, +0x14 sy, +0x18 z, +0x1c 1/z, +0x20 normal, +0x2c u, +0x30 v,
  //   +0x34 light, +0x38 1/facecount
  // face (0x30): +0 draw fn, +4 filler, +8 flags, +0xc,+0x10,+0x14 vertex ptrs, +0x18 normal, +0x24 d, +0x28 shade, +0x2c texture
  HP.fn_23fd4 = function (ebp) {   // per-vertex face counts -> 1/count at +0x38
    let edi = rd32(ebp + 0x34), ecx = rd32(ebp + 0x2c);
    for (; ecx > 0; ecx--, edi += 0x3c) wr32(edi + 0x38, 0);
    edi = rd32(ebp + 0x38); ecx = rd32(ebp + 0x30);
    for (; ecx > 0; ecx--, edi += 0x30) {
      const b = rd32(edi + 0xc), d = rd32(edi + 0x10), s = rd32(edi + 0x14);
      wr32(b + 0x38, rd32(b + 0x38) + 1); wr32(d + 0x38, rd32(d + 0x38) + 1); wr32(s + 0x38, rd32(s + 0x38) + 1);
    }
    edi = rd32(ebp + 0x34); ecx = rd32(ebp + 0x2c);
    for (; ecx > 0; ecx--, edi += 0x3c) wrf(edi + 0x38, 1 / rds32(edi + 0x38));
  };
  HP.fn_24018 = function (ebp) {   // face normals + plane d, accumulate vertex normals
    wrf(0x28e44, 0);
    let edi = rd32(ebp + 0x34), ecx = rd32(ebp + 0x2c);
    for (; ecx > 0; ecx--, edi += 0x3c) { wr32(edi + 0x20, 0); wr32(edi + 0x24, 0); wr32(edi + 0x28, 0); }
    edi = rd32(ebp + 0x38); ecx = rd32(ebp + 0x30);
    for (; ecx > 0; ecx--, edi += 0x30) {
      const ebx = rd32(edi + 0xc), edx = rd32(edi + 0x10), esi = rd32(edi + 0x14);
      const nx = F((rdf(edx + 8) - rdf(ebx + 8)) * (rdf(esi + 0xc) - rdf(ebx + 0xc)) - (rdf(esi + 8) - rdf(ebx + 8)) * (rdf(edx + 0xc) - rdf(ebx + 0xc)));
      const ny = F(-((rdf(edx + 4) - rdf(ebx + 4)) * (rdf(esi + 0xc) - rdf(ebx + 0xc)) - (rdf(esi + 4) - rdf(ebx + 4)) * (rdf(edx + 0xc) - rdf(ebx + 0xc))));
      const nz = F((rdf(edx + 4) - rdf(ebx + 4)) * (rdf(esi + 8) - rdf(ebx + 8)) - (rdf(esi + 4) - rdf(ebx + 4)) * (rdf(edx + 8) - rdf(ebx + 8)));
      wrf(0x28e78, nx); wrf(0x28e7c, ny); wrf(0x28e80, nz);
      wrf(ADDR.tmpF, nx * nx + ny * ny + nz * nz);
      wr32(ADDR.tmpF, HP.fn_23f8c(rd32(ADDR.tmpF)));
      const r = rdf(ADDR.tmpF);
      wr32(ADDR.tmpF, 0xff);
      const k = r * 255;                 // fimul 255 (int); stays on the x87 stack (unrounded)
      const px = nx * k;                 // fst [edi+0x18] rounds; the additions use the unrounded product
      wrf(edi + 0x18, px); wrf(ebx + 0x20, rdf(ebx + 0x20) + px); wrf(edx + 0x20, rdf(edx + 0x20) + px); wrf(esi + 0x20, rdf(esi + 0x20) + px);
      const py = ny * k;
      wrf(edi + 0x1c, py); wrf(ebx + 0x24, rdf(ebx + 0x24) + py); wrf(edx + 0x24, rdf(edx + 0x24) + py); wrf(esi + 0x24, rdf(esi + 0x24) + py);
      const pz = nz * k;
      wrf(edi + 0x20, pz); wrf(ebx + 0x28, rdf(ebx + 0x28) + pz); wrf(edx + 0x28, rdf(edx + 0x28) + pz); wrf(esi + 0x28, rdf(esi + 0x28) + pz);
      wrf(edi + 0x24, -(rdf(edi + 0x18) * rdf(ebx + 4) + rdf(edi + 0x1c) * rdf(ebx + 8) + rdf(edi + 0x20) * rdf(ebx + 0xc)));
    }
    edi = rd32(ebp + 0x34); ecx = rd32(ebp + 0x2c);
    for (; ecx > 0; ecx--, edi += 0x3c) {
      const w = rdf(edi + 0x38);
      const a = rdf(edi + 0x20) * w, b = rdf(edi + 0x24) * w, c = rdf(edi + 0x28) * w;
      wrf(edi + 0x24, b); wrf(edi + 0x28, c); wrf(edi + 0x20, a);
    }
  };
  HP.fn_241be = function (ebp) {   // bounding box center -> ebp+8.., re-center vertices
    let edi = rd32(ebp + 0x34), ecx = rd32(ebp + 0x2c);
    let minx = rdf(edi + 4), maxx = minx, miny = rdf(edi + 8), maxy = miny, minz = rdf(edi + 0xc), maxz = minz;
    wrf(ADDR.bboxMinX, minx); wrf(0x23fbc, minx); wrf(0x23fc0, miny); wrf(0x23fc4, miny); wrf(0x23fc8, minz); wrf(0x23fcc, minz);
    for (; ecx > 0; ecx--, edi += 0x3c) {
      const x = rdf(edi + 4), y = rdf(edi + 8), z = rdf(edi + 0xc);
      if (!(minx >= x)) { minx = x; wrf(ADDR.bboxMinX, x); }      // jae: if min >= x keep else store
      if (!(maxx <= x)) { maxx = x; wrf(0x23fbc, x); }
      if (!(miny >= y)) { miny = y; wrf(0x23fc0, y); }
      if (!(maxy <= y)) { maxy = y; wrf(0x23fc4, y); }
      if (!(minz >= z)) { minz = z; wrf(0x23fc8, z); }
      if (!(maxz <= z)) { maxz = z; wrf(0x23fcc, z); }
    }
    wrf(ebp + 8, (rdf(ADDR.bboxMinX) + rdf(0x23fbc)) / rdf(ADDR.const2));
    wrf(ebp + 0xc, (rdf(0x23fc0) + rdf(0x23fc4)) / rdf(ADDR.const2));
    wrf(ebp + 0x10, (rdf(0x23fc8) + rdf(0x23fcc)) / rdf(ADDR.const2));
    edi = rd32(ebp + 0x34); ecx = rd32(ebp + 0x2c);
    for (; ecx > 0; ecx--, edi += 0x3c) {
      wrf(edi + 4, rdf(edi + 4) - rdf(ebp + 8)); wrf(edi + 8, rdf(edi + 8) - rdf(ebp + 0xc)); wrf(edi + 0xc, rdf(edi + 0xc) - rdf(ebp + 0x10));
    }
  };
  HP.fn_242e3 = function (ebp) {   // bounding radius -> ebp+0x20
    wrf(ADDR.bboxMinX, 0);
    let edi = rd32(ebp + 0x34), ecx = rd32(ebp + 0x2c), m = 0;
    for (; ecx > 0; ecx--, edi += 0x3c) {
      const x = rdf(edi + 4), y = rdf(edi + 8), z = rdf(edi + 0xc);
      const d = x * x + y * y + z * z;
      if (!(m >= d)) { m = d; wrf(ADDR.bboxMinX, d); }
    }
    wrf(ebp + 0x20, Math.sqrt(rdf(ADDR.bboxMinX)));
  };

  // ------------------------------------------------------------ textures
  // texture entry (0x18, at scene+0x454+i*0x18): +0 w-0.5 (float), +4 h-0.5, +8 palette (0x300 bytes RGB),
  //   +0xc pixels (256x256 8-bit, 64K aligned), +0x10 shade table (256 levels x 256 colors, dwords), +0x14 ambient offset
  // [0x2436b..0x24377]: 13-byte texture descriptor (copied from the scene data), [0x24378] = its last dword,
  // [0x2437c]/[0x2437e] = w/h words (part of the descriptor), [0x24382] = palette alloc ptr, [0x24386] = pixel alloc ptr
  HP.callTexGen = function (bh, bl, ecx, edx, ebx, edi) {
    // calls main's generator [0x2438a]; only 0xe27a exists. The port provides texGenCallback(regs) -> regs.
    if (!HP.fn_e27a) throw new Error('HP.fn_e27a (texture generator) not installed');
    return texGenCallback({ bh, bl, ecx, edx, ebx, edi });
  };
  HP.fn_2438e = function (ebp) {   // create texture entry in scene ebp from descriptor at 0x2436b
    const n = rd32(ebp + 0x64);
    wr32(ebp + 0x64, n + 1);
    wr32(0x244f4, rd32(0x244f4) + 1);
    ebp = ebp + 0x454 + n * 0x18;
    if (rd32(0x2438a) !== 0xffffffff) HP.callTexGen(1, rd8(0x2436b), 0xa, 0x24378, 0, 0);
    const pal = rd32(0x24382);
    wr32(ebp + 8, pal); wr32(0x24382, pal + 0x300);
    if (rd32(0x2438a) !== 0xffffffff) HP.callTexGen(0, rd8(0x2436b), 0x300, pal, 0, 0);
    const pix = rd32(0x24386);
    wr32(ebp + 0xc, pix); wr32(ebp + 0x10, pix + 0x10000);
    wr32(0x24386, pix + 0x50000);
    wrf(ebp, rds16(0x2437c) - rdf(ADDR.const1));
    wrf(ebp + 4, rds16(0x2437e) - rdf(ADDR.const1));
    const w = rd16(0x2437c), h = rd16(0x2437e);
    // per row (0x24435..0x24478): the generator callback fills w bytes at the row start (ecx=w, edx=row ptr, bh=0:
    // continue the stream), then the row is replicated across 256 bytes; finally the h rows are replicated down to 256
    let edi = pix;
    for (let row = 0; row < h; row++) {
      if (rd32(0x2438a) !== 0xffffffff) HP.callTexGen(0, rd8(0x2436b), w, edi, h - row, edi);
      let reps = ((0x100 / w) | 0) - 1, d = edi;
      for (; reps > 0; reps--) { HP.copy(d + w, d, (w >> 2) << 2); d += w; }   // rep movsd with ecx=w>>2
      edi += 0x100;
    }
    {
      let reps = ((0x100 / h) | 0) - 1, d = pix;
      const len = h << 8;
      for (; reps > 0; reps--) { HP.copy(d + len, d, (len >> 2) << 2); d += len; }
    }
  };
  HP.fn_2432c = function (edx, ebp) {   // create one texture from descriptor at edx (allocs palette/pixel pools)
    wr32(0x24382, (alloc(0x310) | 0xf) + 1);
    wr32(0x24386, (alloc(0x60000) | 0xffff) + 1);
    HP.copy(0x2436b, edx, 0xd);
    wr32(ebp + 0x5c, rd32(ebp + 0x5c) + 1);
    HP.fn_2438e(ebp);
  };
  // fn_24c00(esi=palette RGB, edi=shade table (256*256 dwords), ebp=scene): builds the shade x palette table
  HP.fn_24c00 = function (esi, edi, ebp) {
    wr32(0x24c63, esi);
    const mode = rd32(ebp + 0x28); wr32(0x24bf4, mode);
    const t3 = rd8(ebp + 0x2c), t2 = rd8(ebp + 0x2d), t1 = rd8(ebp + 0x2e);
    wr8(0x24bfb, t3); wr8(0x24bfa, t2); wr8(0x24bf9, t1);
    for (let i = 0; i < 256; i++) { wr8(0x248f0 + i * 3, i); wr8(0x248f1 + i * 3, i); wr8(0x248f2 + i * 3, i); }
    const off = rds32(0x24bfc);
    let lvl = 0;           // esi
    do {
      let pi = 0;          // ebp (palette byte index)
      do {
        let sum = 0;
        edi += 3; wr8(edi, 0); edi--;
        for (let ecx = 3; ecx >= 1; ecx--) {
          let eax = rd8(esi + pi) - off;
          if (eax <= 0) eax = 0;
          sum += eax;
          if (mode === 1) {
            eax = (Math.imul(eax, 7) >>> 2);
            const ebx = rd8(0x24bf8 + ecx);
            const edx = 0x300 - lvl;
            eax = Math.imul(eax, lvl) + Math.imul(ebx, edx);
            eax = ((eax / 0x300) | 0);          // idiv (truncation)
            eax = Math.imul(eax, 0xb) >>> 2;
            eax = (eax - 0x26) | 0;
          } else {
            const ebx = rd8(0x248f0 + lvl);
            eax = (Math.imul(eax, ebx) >> 4) + (ebx >> 2);
          }
          if (eax <= 0) eax = 0;
          if (eax >= 0xff) eax = 0xff;
          wr8(edi, eax); edi--;
          pi++; lvl++;
        }
        wr32(0x24bf0, sum);
        if (sum <= 0x10) wr8(edi + 4, 0xff);
        edi += 5;
        lvl -= 3;
      } while (pi !== 0x300);
      lvl += 3;
    } while (lvl !== 0x300);
  };

  // ------------------------------------------------------------ scene loader (0x24508) and readers
  HP.fn_244ad = function (esi) { return { v: rdf(esi) * rdf(0x2905c), esi: esi + 4 }; };
  HP.fn_244b9 = function (esi) { return { v: rdf(esi), esi: esi + 4 }; };
  HP.fn_244bf = function (esi) { return { v: rds16(esi) / rdf(0x244f8) * rdf(0x2905c), esi: esi + 2 }; };
  HP.fn_244d1 = function (esi) { return { v: rds16(esi) / rdf(0x244fc), esi: esi + 2 }; };
  // scene block: +0x5c texture base count, +0x60 nobjects, +0x64 ntextures, +0x68 nparticles, +0x94 objects[16]
  //   (0x3c each), +0x454 textures[8] (0x18 each), +0x514 particle array ptr
  HP.fn_24508 = function (ebp) {
    wr32(0x244f4, 0);
    wr32(0x244f0, rd32(ebp + 0x5c));
    wr32(0x244ec, ebp);
    let esi = rd32(0x29054);
    for (;;) {
      wr32(0x24500, 0x244ad); wr32(0x24504, 0x244b9);
      let rdPos = HP.fn_244ad, rdUV = HP.fn_244b9;
      if (rd32(esi + 4) === 0x64726f57) { wr32(0x24500, 0x244bf); wr32(0x24504, 0x244d1); rdPos = HP.fn_244bf; rdUV = HP.fn_244d1; }
      const tag = rd32(esi);
      if (tag === 0x656e694c) {              // 'Line'
        const oi = rd32(ebp + 0x60); wr32(ebp + 0x60, oi + 1);
        const ob = ebp + 0x94 + oi * 0x3c;
        wr32(ob, 0x4c696e65); esi += 4;
        wr32(ob + 4, rd32(0x29050));
        wrf(ob + 0x24, 1);
        if (rd32(esi) === 0x64726f57) esi += 4;
        let nv = rd16(esi); wr32(ob + 0x2c, nv);
        if (rd32(ob + 4) & 1) wr32(0x244e8, nv);
        esi += 2;
        let p = (alloc(nv * 0x3c + 0x10) | 0xf) + 1;
        wr32(ob + 0x34, p); HP.fill8(p, 0, nv * 0x3c + 0x10);
        for (let edi = p, c = nv; c > 0; c--, edi += 0x3c) {
          let r = rdPos(esi); wrf(edi + 4, r.v); esi = r.esi;
          r = rdPos(esi); wrf(edi + 8, r.v); esi = r.esi;
          r = rdPos(esi); wrf(edi + 0xc, r.v); esi = r.esi;
        }
        let nf = rd16(esi); wr32(ob + 0x30, nf);
        if (rd32(ob + 4) & 1) wr32(0x244e4, nf);
        esi += 2;
        let fp = (alloc(nf * 0x10 + 0x10) | 0xf) + 1;
        wr32(ob + 0x38, fp); HP.fill8(fp, 0, nf * 0x10 + 0x10);
        const lflags = rd32(0x29050) & 0x100;
        for (let edi = fp, c = nf; c > 0; c--, edi += 0x10) {
          wr32(edi, 0x2a81b); wr32(edi + 4, lflags);
          wr32(edi + 8, rd16(esi) * 0x3c + p); esi += 2;
          wr32(edi + 0xc, rd16(esi) * 0x3c + p); esi += 2;
        }
        HP.fn_241be(ob); HP.fn_242e3(ob);
        wr32(ob + 0x14, 0); wr32(ob + 0x18, 0); wr32(ob + 0x1c, 0);
        wr32(ebp + 0x38, rd32(ebp + 0x38) + rd32(0x244e8));
        wr32(ebp + 0x40, rd32(ebp + 0x40) + rd32(0x244e4));
        continue;
      }
      if (tag !== 0x2175624f) break;          // 'Obu!'
      const oi = rd32(ebp + 0x60); wr32(ebp + 0x60, oi + 1);
      const ob = ebp + 0x94 + oi * 0x3c;
      wr32(ob + 0x28, rd32(0x23fd0));
      wr32(ob, 0x4f627521); esi += 4;
      wr32(ob + 4, rd32(0x29050));
      wrf(ob + 0x24, 1);
      if (rd32(esi) === 0x64726f57) esi += 4;
      if (rd32(esi) === 0x72747854) {         // 'Txtr'
        esi += 4;
        let edx = rd16(esi); esi += 2;
        wr32(0x24382, (alloc(edx * 0x300 + 0x10) | 0xf) + 1);
        wr32(0x24386, (alloc(edx * 0x50000 + 0x10000) | 0xffff) + 1);
        for (; edx > 0; edx--) {
          HP.copy(0x2436b, esi, 0xd); esi += 0xd;
          HP.fn_2438e(rd32(0x244ec));
        }
      }
      let nv = rd16(esi); wr32(ob + 0x2c, nv);
      if (rd32(ob + 4) & 1) wr32(0x244e8, nv);
      esi += 2;
      let p = (alloc(nv * 0x3c + 0x10) | 0xf) + 1;
      wr32(ob + 0x34, p); HP.fill8(p, 0, nv * 0x3c + 0x10);
      for (let edi = p, c = nv; c > 0; c--, edi += 0x3c) {
        let r = rdPos(esi); wrf(edi + 4, r.v); esi = r.esi;
        r = rdPos(esi); wrf(edi + 8, r.v); esi = r.esi;
        r = rdPos(esi); wrf(edi + 0xc, r.v); esi = r.esi;
      }
      if (rd32(esi) === 0x65767555) {         // 'Uuve'
        esi += 4;
        for (let edi = p, c = nv; c > 0; c--, edi += 0x3c) {
          let r = rdUV(esi); wrf(edi + 0x2c, r.v); esi = r.esi;
          r = rdUV(esi); wrf(edi + 0x30, -r.v); esi = r.esi;
        }
      }
      let nf = rd16(esi); wr32(ob + 0x30, nf);
      if (rd32(ob + 4) & 1) wr32(0x244e0, nf);
      esi += 2;
      let fp = (alloc(nf * 0x30 + 0x10) | 0xf) + 1;
      wr32(ob + 0x38, fp); HP.fill8(fp, 0, nf * 0x30 + 0x10);
      for (let edi = fp, c = nf; c > 0; c--, edi += 0x30) {
        wr32(edi, 0x2a92f); wr32(edi + 4, rd32(0x29058));
        wr32(edi + 0xc, rd16(esi) * 0x3c + p); esi += 2;
        wr32(edi + 0x10, rd16(esi) * 0x3c + p); esi += 2;
        wr32(edi + 0x14, rd16(esi) * 0x3c + p); esi += 2;
        wr32(edi + 0x2c, 0);
      }
      let edi = fp;
      while (rd32(esi) === 0x6574614d) {      // 'Mate'
        esi += 4;
        let eax = rd16(esi); esi += 2;
        let ecx = rd16(esi); esi += 2;
        eax += rd32(0x244f0);
        if (rd32(esi) === 0x4b435546) {       // 'FUCK'
          esi += 4;
          for (; ecx > 0; ecx--) { const b = rd16(esi); esi += 2; wr32(fp + b * 0x30 + 0x2c, eax); }
        } else {
          for (; ecx > 0; ecx--, edi += 0x30) wr32(edi + 0x2c, eax);
        }
      }
      HP.fn_23fd4(ob); HP.fn_241be(ob); HP.fn_242e3(ob); HP.fn_24018(ob);
      wr32(ob + 0x14, 0); wr32(ob + 0x18, 0); wr32(ob + 0x1c, 0);
      wr32(ebp + 0x38, rd32(ebp + 0x38) + rd32(0x244e8));
      wr32(ebp + 0x3c, rd32(ebp + 0x3c) + rd32(0x244e0));
    }
    wr32(ebp + 0x5c, rd32(ebp + 0x5c) + rd32(0x244f4));
  };
  // fn_29060(eax=filler index (0..3), ebx=object flags, ecx=?, edx=?, esi=scale, edi=scene data, ebp=scene)
  HP.fn_29060 = function (eax, ebx, ecx, edx, esi, edi, ebp) {
    wr32(0x29058, rd32(0x29040 + eax * 4));
    wr32(0x29050, ebx); wr32(0x29054, edi); wr32(0x2905c, esi);
    HP.fn_24508(ebp);
  };

  // ------------------------------------------------------------ engine / scene init
  // fn_286ec(ecx=w, edx=h, ebp=radius, edi=dst): radial blob texture (2w x 2h, stride 256)
  HP.fn_286ec = function (ecx, edx, ebp, edi) {
    wr32(0x28e44, -edx | 0);
    for (let y = -edx; y < edx; y++) {
      wr32(ADDR.tmpF, -ecx | 0);
      for (let x = -ecx; x < ecx; x++) {
        const d = Math.sqrt(x * x + y * y);      // fild/fmul/fadd/fsqrt
        wr32(ADDR.tmpF2, ebp);
        let v = d / (ebp / rdf(ADDR.const4));        // fild ebp; fdiv 4.0; fdivp st1 -> st1/st0
        wr32(ADDR.tmpF2, 0x11);
        v = -v + 0x11;                           // fchs; fild 17; faddp
        wrf(ADDR.tmpF2, v);                         // fst (float32)
        if (rd32(ADDR.tmpF2) & 0x80000000) v = 0;   // negative -> 0
        wrf(0x28e50, v); wrf(ADDR.tmpF2, v);
        const vf = rdf(ADDR.tmpF2);
        let t = v * v; t = t * t; t = t * vf;    // fmul st0; fmul st0; fmul [0x28e48] -> v^5
        wr32(ADDR.tmpF2, 0x9c40);
        t = t / 0x9c40;                          // fild 40000; fdivp st1
        t = t + rdf(0x28e50) / rdf(ADDR.const2);     // + v/2.0
        t = t * rdf(ADDR.const4);                    // * 4.0
        const ival = rne(t) | 0;
        wr32(ADDR.tmpF2, ival);
        let eax = ival;
        if (eax <= 0) eax = 0;
        if (eax >= 0xff) eax = 0xff;
        wr8(edi, eax); edi++;
        wr32(ADDR.tmpF, rd32(ADDR.tmpF) + 1);
      }
      edi += 0x100 - 2 * ecx;
      wr32(0x28e44, rd32(0x28e44) + 1);
    }
  };
  HP.fn_28f4a = function () {      // engine init (called once at start)
    wr32(0x28e54, himemFree());
    // fninit (x87 defaults) — nothing to do
    HP.fn_2c500();
    HP.fn_23f34();
    const p = (alloc(0x30000) | 0xffff) + 1;
    wr32(0x28e5c, p);
    HP.fn_286ec(0x80, 0x80, 0x20, p);
    HP.fn_286ec(0x40, 0x40, 0x10, p + 0x10000);
    HP.fn_286ec(0x20, 0x20, 8, p + 0x18000);
    HP.fn_286ec(0x10, 0x10, 4, p + 0x1c000);
    HP.fn_286ec(8, 8, 2, p + 0x1e000);
    HP.fn_286ec(4, 4, 1, p + 0x1f000);
    wr8(p + 0x1f404, rd8(p + 0x1f404) >> 1);
  };
  // fn_28ed8(eax=video mode index (0=320x200 mode13h,1=320x240 VESA), ebp=scene): scene viewport setup
  HP.fn_28ed8 = function (eax, ebp) {
    wr32(ebp, eax);
    const w = rd32(0x28eb4 + eax * 8), h = rd32(0x28eb8 + eax * 8);
    wr32(ebp + 4, w); wr32(ebp + 8, h); wr32(ebp + 0x14, w); wr32(ebp + 0x1c, h);
    wrf(ebp + 0x10, 0); wrf(ebp + 0x18, 0);
    wr32(ebp + 0x20, rd32(0x28ec4)); wr32(ebp + 0x24, rd32(0x28ec8));
    wr32(ebp + 0xc, rd32(0x28ecc + eax * 4));
    if (eax === 1) {
      if (rd32(0x28ed4) === 1) HP.fn_2c845();
    } else if (eax === 0) {
      wr32(0x2c538, 0xa000);
      if (HP.setVideoMode13) HP.setVideoMode13();
    }
  };
  // fn_2a094(ecx=particle count, ebp=scene): shade tables for all textures, 1/n table, particles, color ramp
  HP.fn_2a094 = function (ecx, ebp) {
    wr32(0x2908a, ecx);
    let n = rd32(ebp + 0x64);
    for (let edx = ebp + 0x454; n > 0; n--, edx += 0x18) {
      wr32(0x24bfc, rd32(edx + 0x14));
      HP.fn_24c00(rd32(edx + 8), rd32(edx + 0x10), ebp);
    }
    for (let i = 0; i < 0x11; i++) { wr32(ADDR.tmpF, i + 1); wrf(ADDR.recipTable + i * 4, 1 / (i + 1)); }
    const cnt = rd32(0x2908a);
    wr32(ebp + 0x68, cnt);
    if (cnt !== 0) {
      const sz = cnt * 0x2c;
      const p = (alloc(sz + 0x10) | 0xf) + 1;
      wr32(ebp + 0x514, p);
      HP.fill8(p, 0, sz);
      let q = p;
      for (let i = 0; i < cnt; i++, q += 0x2c) {
        wr32(q, 0x2a86e);
        let r = (rand(0xc8) - 0x64) | 0; wr32(ADDR.tmpF, r); wrf(q + 4, r);
        r = (rand(0xc8) - 0x64) | 0; wr32(ADDR.tmpF, r); wrf(q + 8, r);
        r = (rand(0xc8) - 0x64) | 0; wr32(ADDR.tmpF, r); wrf(q + 0xc, r);
        wr32(ADDR.tmpF, -12 >>> 0); wrf(q + 0x20, -12);
      }
    }
    wr32(ADDR.tmpF, 0x100);
    wrf(ADDR.tmpF, 1 / 256);
    const step = rdf(ADDR.tmpF);
    let t = 0;
    for (let i = 0, edi = 0x29090; i < 0x100; i++, edi += 4) {
      let v = rd8(ebp + 0x30); wr32(0x2a090, v); v = rne(v * t); wr32(0x2a090, v); wr8(edi + 2, v);
      v = rd8(ebp + 0x31); wr32(0x2a090, v); v = rne(v * t); wr32(0x2a090, v); wr8(edi + 1, v);
      v = rd8(ebp + 0x32); wr32(0x2a090, v); v = rne(v * t); wr32(0x2a090, v); wr8(edi, v);
      t += step;
    }
  };
})();
// hplus port — engine part 2: per-frame pipeline (fn_2a2ac render scene + everything it calls except drawing).
(function () {
  const { rd8, rd16, rd32, rds32, wr8, wr16, wr32, rdf, wrf, roundHalfEven } = HP;
  const F = Math.fround;
  const rne = roundHalfEven;
  const sign = (a) => (rd32(a) & 0x80000000) !== 0;     // sign bit of a stored float32

  // ------------------------------------------------------------ fn_2a2ac(esi=camera, ebp=scene, edi=dest buffer)
  HP.fn_2a2ac = function (esi, ebp, edi) {
    wr32(0x2a250, rd32(ebp + 0x90)); wr32(0x2a254, rd32(ebp + 0x88)); wr32(0x2a258, rd32(ebp + 0x8c));
    wr32(0x2a248, esi); wr32(0x2a24c, ebp); wr32(0x2a244, edi);
    const focal = rdf(ebp + 0x34);
    wrf(0x254f8, focal); wrf(0x28ea8, focal * rdf(ebp + 0xc));
    HP.fn_24e81(esi);
    wr32(0x251d4, 0); wr32(0x251d8, 0);
    if (rd32(ebp + 0x60) !== 0) HP.fn_251e0(esi, ebp);
    const savedHeap = rd32(8);
    HP.fn_26230(ebp);
    wr32(0x28e58, (rd32(0x28e54) - himemFree()) >>> 0);
    wr32(0x28808, rne(rdf(ebp + 4))); wrf(0x2880c, rdf(ebp + 4));
    wr32(0x2a240, rd32(ebp + 0x20));
    { const a = rdf(ebp + 0x10), b = rdf(ebp + 0x18);
      wr32(0x287f4, rne(b)); wrf(0x254e4, b); wr32(0x287f0, rne(a)); wrf(0x254e0, a); }
    { const a = rdf(ebp + 0x14), b = rdf(ebp + 0x1c);
      wr32(0x287fc, rne(b)); wrf(0x254ec, b); wr32(0x287f8, rne(a)); wrf(0x254e8, a); }
    wrf(0x254f0, (rdf(ebp + 0x14) - rdf(ebp + 0x10)) / rdf(ADDR.const2) + rdf(ebp + 0x10));
    wrf(0x254f4, (rdf(ebp + 0x1c) - rdf(ebp + 0x18)) / rdf(ADDR.const2) + rdf(ebp + 0x18));
    { const a = rdf(0x254e8) - rdf(ADDR.const1), b = rdf(0x254ec) - rdf(ADDR.const1);
      wr32(0x28804, rne(b)); wrf(0x28034, b); wr32(0x28800, rne(a)); wrf(0x28030, a); }
    wr32(ADDR.listAWrite, rd32(0x25a18)); wr32(ADDR.listBWrite, rd32(0x25a1c));
    wr32(ADDR.drawItemCount, 0); wr32(0x2a22c, 0);
    wr32(0x25a20, rd32(0x25a10));
    let ecx = rd32(ebp + 0x60);
    if (ecx !== 0) {
      let ob = ebp + 0x94;
      for (; ecx > 0; ecx--, ob += 0x3c) {
        const fl = rd32(ob + 4);
        if (!(fl & 1) || !(fl & 2)) continue;
        wrf(0x24fa8, rdf(ob + 0x24));
        wrf(0x24fb8, rds32(ob + 0x14) / rdf(ADDR.angle16Scale));
        wrf(0x24fbc, rds32(ob + 0x18) / rdf(ADDR.angle16Scale));
        wrf(0x24fc0, rds32(ob + 0x1c) / rdf(ADDR.angle16Scale));
        wrf(0x24fac, rdf(ob + 8)); wrf(0x24fb0, rdf(ob + 0xc)); wrf(0x24fb4, rdf(ob + 0x10));
        HP.fn_24fc4(0x24d50);
        HP.fn_2515e(0x24d50, rd32(0x2a248) + 0x24, 0x24d10);
        if (fl & 4) HP.fn_24018(ob);
        if (rd32(ob) !== 0x4f627521) HP.fn_2a542(ob);
        else if (rd8(0x9e6) !== 1) HP.fn_2a5b4(ob);
      }
    }
    HP.fn_2a672();
    wr32(ebp + 0x58, rd32(ADDR.drawItemCount)); wr32(ebp + 0x4c, rd32(0x2a22c));
    wr32(0x2a25c, 0); wr32(0x2a260, 0); wr32(0x2a264, 0);
    HP.fn_2a7d0(ebp);
    wr32(ebp + 0x48, rd32(0x2a25c)); wr32(ebp + 0x50, rd32(0x2a260)); wr32(ebp + 0x54, rd32(0x2a264));
    wr32(8, savedHeap);
  };

  // ------------------------------------------------------------ fn_251e0(esi=camera, ebp=scene): frustum culling
  HP.fn_251e0 = function (esi, ebp) {
    wrf(0x251c8, Math.atan2(rdf(ebp + 0x34), (rdf(ebp + 0x14) - rdf(ebp + 0x10)) / rdf(ADDR.const2)));
    wrf(0x251cc, Math.atan2(rdf(0x28ea8), (rdf(ebp + 0x1c) - rdf(ebp + 0x18)) / rdf(ADDR.const2)));
    wr32(0x251b0, rd32(ebp + 0x24));
    const big = rdf(0x251bc);
    wrf(0x251c0, big); wrf(0x251c4, -big);
    let ecx = rd32(ebp + 0x60);
    let ob = ebp + 0x94;
    for (; ecx > 0; ecx--, ob += 0x3c) {
      const px = rdf(ob + 8), py = rdf(ob + 0xc), pz = rdf(ob + 0x10);
      for (let i = 0; i < 3; i++) {
        const o = esi + i * 4;
        wrf(0x28e9c + i * 4, px * rdf(o + 0x24) + py * rdf(o + 0x34) + pz * rdf(o + 0x44) + rdf(o + 0x54));
      }
      let eax = 0;
      wr32(ob + 4, rd32(ob + 4) & 0x10d);
      if (rd32(ob + 4) & 1) {
        do {
          wrf(0x251dc, rdf(ob + 0x20) * rdf(ob + 0x24));
          wrf(ADDR.cullTmp, rdf(0x28ea4) + rdf(0x251dc) - rdf(0x251b0));
          if (sign(ADDR.cullTmp)) break;
          eax = 1;
          if (!sign(0x28e9c)) wrf(0x28e9c, -rdf(0x28e9c));
          {
            const x = rdf(0x28e9c), z = rdf(0x28ea4);
            const s = Math.sqrt(x * x + z * z);
            const ang = Math.atan2(z, x);
            wrf(ADDR.cullTmp, s * Math.sin(ang - rdf(0x251c8)) - rdf(0x251dc));
            if (!sign(ADDR.cullTmp)) { eax = 0; break; }
          }
          if (!sign(0x28ea0)) wrf(0x28ea0, -rdf(0x28ea0));
          {
            const y = rdf(0x28ea0), z = rdf(0x28ea4);
            const s = Math.sqrt(y * y + z * z);
            const ang = Math.atan2(z, y);
            wrf(ADDR.cullTmp, s * Math.sin(ang - rdf(0x251cc)) - rdf(0x251dc));
            if (!sign(ADDR.cullTmp)) { eax = 0; break; }
          }
          {
            const a = rdf(0x28ea4) - rdf(0x251dc);
            wrf(ADDR.cullTmp, a - rdf(0x251c0));
            if (sign(ADDR.cullTmp)) wrf(0x251c0, a);
            const b = rdf(0x28ea4) + rdf(0x251dc);
            wrf(ADDR.cullTmp, b - rdf(0x251c4));
            if (!sign(ADDR.cullTmp)) wrf(0x251c4, b);
          }
          wr32(0x251d4, rd32(0x251d4) + rd32(ob + 0x30));
          wr32(0x251d8, rd32(0x251d8) + 1);
        } while (false);
      }
      wr32(ob + 4, rd32(ob + 4) | (eax << 1));
    }
    wrf(0x251b4, rdf(ADDR.sortZScale));
    wr32(ebp + 0x44, rd32(0x251d8));
  };

  // ------------------------------------------------------------ fn_25414(ebp=object): transform flagged (0x40) vertices
  HP.fn_25414 = function (ebp) {
    let ecx = rd32(ebp + 0x2c), ebx = rd32(ebp + 0x34);
    const m00 = rdf(0x24d10), m01 = rdf(0x24d14), m02 = rdf(0x24d18), m10 = rdf(0x24d20), m11 = rdf(0x24d24), m12 = rdf(0x24d28);
    const m20 = rdf(0x24d30), m21 = rdf(0x24d34), m22 = rdf(0x24d38), m30 = rdf(0x24d40), m31 = rdf(0x24d44), m32 = rdf(0x24d48);
    const near = rdf(0x2a240);
    for (; ecx > 0; ecx--, ebx += 0x3c) {
      if (!(rd32(ebx) & 0x40)) continue;
      wr32(0x2a22c, rd32(0x2a22c) + 1);
      const x = rdf(ebx + 4), y = rdf(ebx + 8), z = rdf(ebx + 0xc);
      const X = ((x * m00 + y * m10) + z * m20) + m30;
      const Y = ((x * m01 + y * m11) + z * m21) + m31;
      const Z = ((x * m02 + y * m12) + z * m22) + m32;
      wrf(ADDR.cullTmp, near - Z);
      const edx = sign(ADDR.cullTmp) ? 0x10 : 0;
      wr32(ebx, ((rd32(ebx) & 0xef) | edx) >>> 0);
      wrf(ebx + 0x18, Z); wrf(ebx + 0x10, X); wrf(ebx + 0x14, Y);
    }
  };

  // ------------------------------------------------------------ fn_254fc(ebp=object): project + screen clip flags
  HP.fn_254fc = function (ebp) {
    let edi = rd32(ebp + 0x34), ecx = rd32(ebp + 0x2c);
    if (ecx === 0) return;
    const fx = rdf(0x254f8), fy = rdf(0x28ea8), cx = rdf(0x254f0), cy = rdf(0x254f4);
    for (; ecx > 0; ecx--, edi += 0x3c) {
      if (rd32(edi) & 0x10) continue;
      const w = 1 / rdf(edi + 0x18);
      const y = (rdf(edi + 0x14) * fy) * w + cy;
      const x = (rdf(edi + 0x10) * fx) * w + cx;
      wrf(edi + 0x14, y); wrf(edi + 0x10, x); wrf(edi + 0x1c, w);
      wr32(edi, rd32(edi) & 0xf0);
      const Y = rdf(edi + 0x14), X = rdf(edi + 0x10);
      wrf(0x268f4, Y - rdf(0x254e4)); wrf(ADDR.cullTmp, rdf(0x254ec) - Y);
      let eax = ((rd32(0x268f4) >>> 0x1c) & 8) | ((rd32(ADDR.cullTmp) >>> 0x1d) & 4);
      wrf(0x268f4, X - rdf(0x254e0)); wrf(ADDR.cullTmp, rdf(0x254e8) - X);
      eax |= ((rd32(0x268f4) >>> 0x1e) & 2) | (rd32(ADDR.cullTmp) >>> 0x1f);
      wr32(edi, rd32(edi) | eax);
    }
  };

  // ------------------------------------------------------------ near-plane clipping
  // fn_255e0(ecx=v0, edi=v1): emits v0 (if in front) and the intersection to the clipped-vertex list
  HP.fn_255e0 = function (ecx, edi) {
    const ebx = (rd32(ecx) >>> 4) & 1;
    if (ebx !== 1) {
      HP.copy(rd32(ADDR.listBWrite), ecx, 0x3c);
      wr32(0x255dc, rd32(0x255dc) + 1);
      wr32(ADDR.listBWrite, rd32(ADDR.listBWrite) + 0x3c);
    }
    const eax = (rd32(edi) >>> 4) & 1;
    if (eax === ebx) return;
    if (rd32(edi + 0x18) === rd32(ecx + 0x18)) return;
    if (rd32(ecx + 0x34) === 0xffffffff) HP.fn_27ffc(ecx);
    if (rd32(edi + 0x34) === 0xffffffff) HP.fn_27ffc(edi);
    const near = rdf(0x2a240);
    const t = (near - rdf(ecx + 0x18)) / (rdf(edi + 0x18) - rdf(ecx + 0x18));
    const esi = rd32(ADDR.listBWrite);
    wr32(esi + 0x18, rd32(0x2a240)); wr32(esi + 0xc, rd32(0x2a240));
    const dx = rdf(edi + 0x10) - rdf(ecx + 0x10), dy = rdf(edi + 0x14) - rdf(ecx + 0x14);
    const y = dy * t + rdf(ecx + 0x14);
    wrf(esi + 0x14, y); wrf(esi + 8, y);
    const x = dx * t + rdf(ecx + 0x10);
    wrf(esi + 0x10, x); wrf(esi + 4, x);
    wrf(esi + 0x2c, (rdf(edi + 0x2c) - rdf(ecx + 0x2c)) * t + rdf(ecx + 0x2c));
    wrf(esi + 0x30, (rdf(edi + 0x30) - rdf(ecx + 0x30)) * t + rdf(ecx + 0x30));
    wrf(esi + 0x34, (rdf(edi + 0x34) - rdf(ecx + 0x34)) * t + rdf(ecx + 0x34));
    wr32(esi, 0);
    wr32(ADDR.listBWrite, rd32(ADDR.listBWrite) + 0x3c);
    wr32(0x255dc, rd32(0x255dc) + 1);
  };
  // fn_256c5(ebp=object): near-clip polygons -> new faces/vertices into the temp object lists
  HP.fn_256c5 = function (ebp) {
    let edi = rd32(ebp + 0x38), ecx = rd32(ebp + 0x30);
    for (; ecx > 0; ecx--, edi += 0x30) {
      if (!(rd32(edi + 8) & 1)) continue;
      const edx = rd32(edi + 0xc), esi = rd32(edi + 0x10), vp = rd32(edi + 0x14);
      const eax = (rd32(edx) & 0x10) + (rd32(esi) & 0x10) + (rd32(vp) & 0x10);
      if (eax === 0) continue;
      if ((eax >>> 4) !== 3) {
        const startV = rd32(ADDR.listBWrite);
        wr32(0x255dc, 0);
        wr32(0x255d0, edx); wr32(0x255d4, esi); wr32(0x255d8, vp);
        HP.fn_255e0(edx, esi);
        HP.fn_255e0(rd32(0x255d4), rd32(0x255d8));
        HP.fn_255e0(rd32(0x255d8), rd32(0x255d0));
        wr32(0x2a29c, rd32(0x2a29c) + rd32(0x255dc));
        let ebx = startV, fb = rd32(ADDR.listAWrite);
        let n = (rd32(0x255dc) - 2) | 0;
        for (; n !== 0; n--) {
          HP.copy(fb, edi, 0x30);
          wr32(fb + 8, 1);
          ebx += 0x3c;
          wr32(fb + 0xc, startV); wr32(fb + 0x10, ebx); wr32(fb + 0x14, ebx + 0x3c);
          wr32(0x2a2a0, rd32(0x2a2a0) + 1);
          fb += 0x30;
        }
        wr32(ADDR.listAWrite, fb);
      }
      wr32(edi + 8, 0);
    }
  };
  // fn_257c0(ebp=object): near-clip lines
  HP.fn_257c0 = function (ebp) {
    let edi = rd32(ebp + 0x38), ecx = rd32(ebp + 0x30);
    for (; ecx > 0; ecx--, edi += 0x10) {
      wr32(edi + 4, rd32(edi + 4) | 1);
      let edx = rd32(edi + 8), esi = rd32(edi + 0xc);
      const eax = (rd32(edx) & 0x10) + (rd32(esi) & 0x10);
      if (eax === 0) continue;
      if ((eax >>> 4) !== 2 && rd32(esi + 0x18) !== rd32(edx + 0x18)) {
        const ebx = rd32(ADDR.listBWrite);
        if (rd32(edx) & 0x10) { const t = esi; esi = edx; edx = t; }
        const t = (rdf(0x2a240) - rdf(edx + 0x18)) / (rdf(esi + 0x18) - rdf(edx + 0x18));
        wr32(ebx + 0x18, rd32(0x2a240));
        const dx = rdf(esi + 0x10) - rdf(edx + 0x10), dy = rdf(esi + 0x14) - rdf(edx + 0x14);
        wrf(ebx + 0x14, dy * t + rdf(edx + 0x14));
        wrf(ebx + 0x10, dx * t + rdf(edx + 0x10));
        wr32(ebx, 0);
        wr32(ADDR.listBWrite, rd32(ADDR.listBWrite) + 0x3c);
        wr32(0x2a29c, rd32(0x2a29c) + 1); wr32(0x2a2a0, rd32(0x2a2a0) + 1);
        const fb = rd32(ADDR.listAWrite);
        HP.copy(fb, edi, 0x10);
        wr32(fb + 4, rd32(fb + 4) | 1);
        wr32(fb + 8, edx); wr32(fb + 0xc, ebx);
        wr32(ADDR.listAWrite, fb + 0x10);
      }
      wr32(edi + 4, rd32(edi + 4) & 0x7fe);
    }
  };

  // ------------------------------------------------------------ fn_2589c(esi=camera, ebp=object): backface culling
  function transposeObjMatrix() {
    wrf(0x24d90, rdf(0x24d50)); wrf(0x24da0, rdf(0x24d54)); wrf(0x24db0, rdf(0x24d58)); wrf(0x24dc0, 0);
    wrf(0x24d94, rdf(0x24d60)); wrf(0x24da4, rdf(0x24d64)); wrf(0x24db4, rdf(0x24d68)); wrf(0x24dc4, 0);
    wrf(0x24d98, rdf(0x24d70)); wrf(0x24da8, rdf(0x24d74)); wrf(0x24db8, rdf(0x24d78)); wrf(0x24dc8, 0);
  }
  HP.fn_2589c = function (esi, ebp) {
    if (rd32(ebp + 4) & 8) {
      let edi = rd32(ebp + 0x34), ecx = rd32(ebp + 0x2c);
      for (; ecx > 0; ecx--, edi += 0x3c) wr32(edi, 0x40);
      edi = rd32(ebp + 0x38); ecx = rd32(ebp + 0x30);
      for (; ecx > 0; ecx--, edi += 0x30) wr32(edi + 8, 1);
      return;
    }
    transposeObjMatrix();
    wrf(0x28e9c, rdf(esi) - rdf(ebp + 8)); wrf(0x28ea0, rdf(esi + 4) - rdf(ebp + 0xc)); wrf(0x28ea4, rdf(esi + 8) - rdf(ebp + 0x10));
    HP.fn_24e53(0x28e9c, 0x24d90, 0x25890);
    let edi = rd32(ebp + 0x34), ecx = rd32(ebp + 0x2c);
    for (; ecx > 0; ecx--, edi += 0x3c) wr32(edi, 0);
    edi = rd32(ebp + 0x38); ecx = rd32(ebp + 0x30);
    const lx = rdf(0x25890), ly = rdf(0x25894), lz = rdf(0x25898);
    for (; ecx > 0; ecx--, edi += 0x30) {
      wrf(ADDR.cullTmp, ((lx * rdf(edi + 0x18) + ly * rdf(edi + 0x1c)) + lz * rdf(edi + 0x20)) + rdf(edi + 0x24));
      let eax = 0;
      if (!sign(ADDR.cullTmp)) {
        eax = 1;
        wr32(rd32(edi + 0xc), 0x40); wr32(rd32(edi + 0x10), 0x40); wr32(rd32(edi + 0x14), 0x40);
      }
      wr32(edi + 8, eax);
    }
  };

  // ------------------------------------------------------------ sort lists
  HP.fn_26230 = function (ebp) {
    const n = ((rd32(ebp + 0x3c) + rd32(ebp + 0x40) + rd32(ebp + 0x68)) << 1) >>> 0;
    wr32(0x251d4, n);
    const sz = (n << 3) + 0x10;
    wr32(0x25a10, (alloc(sz) | 0xf) + 1);
    wr32(0x25a14, (alloc(sz) | 0xf) + 1);
    wr32(0x25a18, (alloc(n * 0x30 + 0x10) | 0xf) + 1);
    wr32(0x25a1c, (alloc(n * 0xb4 + 0x10) | 0xf) + 1);
  };
  // fn_2629f(ebp=object): add visible faces to the sort list
  HP.fn_2629f = function (ebp) {
    wr32(0x26228, 0xffffffff);
    if (rd32(0x26224) === 0xffffffff) wr32(0x26228, 0);
    wr32(0x2622c, (rd32(ebp + 4) & 0x100) ? 0xffffffff : 0);
    let ecx = rd32(ebp + 0x2c);
    if (ecx === 0) return;
    let edi = rd32(ebp + 0x34);
    for (; ecx > 0; ecx--, edi += 0x3c) wr32(edi, rd32(edi) & 0x7f);
    edi = rd32(0x25a20);
    let esi = rd32(ebp + 0x38), n = rd32(ebp + 0x30);
    wr32(ADDR.tmpF, n);
    const zc = rdf(0x251c4), zs = rdf(0x251b4), m02 = rdf(0x24d18), m12 = rdf(0x24d28), m22 = rdf(0x24d38);
    for (; n > 0; n--, esi += 0x30) {
      wr32(ADDR.tmpF, n);
      if (!(rd32(esi + 8) & 1)) continue;
      const v0 = rd32(esi + 0xc), v1 = rd32(esi + 0x10), v2 = rd32(esi + 0x14);
      if ((rd32(v0) & rd32(v1) & rd32(v2) & 0xf) !== 0) continue;
      wr32(v0, rd32(v0) | 0x80); wr32(v1, rd32(v1) | 0x80); wr32(v2, rd32(v2) | 0x80);
      if (rd32(0x2a234) === 1) {
        let eax = rne((rdf(esi + 0x20) * m22 + rdf(esi + 0x1c) * m12) + rdf(esi + 0x18) * m02) | 0;
        wr32(0x28e4c, eax);
        if (eax <= 0) eax = 0;
        if (eax >= 0xff) eax = 0xff;
        wr32(esi + 0x28, (eax | rd32(0x2622c)) >>> 0);
      }
      const s = ((rdf(v2 + 0x18) - zc) * zs + (rdf(v1 + 0x18) - zc) * zs) + (rdf(v0 + 0x18) - zc) * zs;
      const k = rne(-s) | 0;
      wr32(0x28e44, k);
      let key = (0xffff - k) | 0;
      key = (key + rds32(0x26224)) | 0;
      key = (key & rd32(0x26228)) >>> 0;
      wr32(edi, key); wr32(edi + 4, esi); edi += 8;
      wr32(ADDR.drawItemCount, rd32(ADDR.drawItemCount) + 1);
    }
    wr32(ADDR.tmpF, 0);
    wr32(0x25a20, edi);
  };
  // fn_26408(ebp=object): add line faces to the sort list
  HP.fn_26408 = function (ebp) {
    let edi = rd32(0x25a20), esi = rd32(ebp + 0x38), n = rd32(ebp + 0x30);
    if (n <= 0) return;
    wr32(ADDR.tmpF, n);
    const zc = rdf(0x251c4), zs = rdf(0x251b4), lm = rdf(0x26400);
    for (; n > 0; n--, esi += 0x10) {
      wr32(ADDR.tmpF, n);
      if (!(rd32(esi + 4) & 1)) continue;
      const v0 = rd32(esi + 8), v1 = rd32(esi + 0xc);
      if ((rd32(v0) & rd32(v1) & 0xf) !== 0) continue;
      const s = ((rdf(v1 + 0x18) - zc) * zs + (rdf(v0 + 0x18) - zc) * zs) * lm;
      const k = rne(-s) | 0;
      wr32(0x28e44, k);
      const key = (((0xffff - k) | 0) & rd32(0x26404)) >>> 0;
      wr32(edi, key); wr32(edi + 4, esi); edi += 8;
      wr32(ADDR.drawItemCount, rd32(ADDR.drawItemCount) + 1);
    }
    wr32(ADDR.tmpF, 0);
    wr32(0x25a20, edi);
  };
  // fn_2649c: 2-pass radix sort (key bytes 0 and 1) of the [0x2a230] items in list A (via list B)
  HP.fn_2649c = function () {
    const cnt = rd32(ADDR.drawItemCount);
    const A = rd32(0x25a10), B = rd32(0x25a14);
    function pass(src, dst, shift) {
      HP.fill32(0x25e24, 0, 0x100);
      for (let i = 0, p = src; i < cnt; i++, p += 8) {
        const b = (rd32(p) >>> shift) & 0xff;
        wr32(0x25e24 + b * 4, rd32(0x25e24 + b * 4) + 1);
      }
      let acc = dst;
      for (let b = 0; b < 0x100; b++) {
        wr32(0x25a24 + b * 4, acc);
        acc = (acc + (rd32(0x25e24 + b * 4) << 3)) >>> 0;
      }
      for (let i = 0, p = src; i < cnt; i++, p += 8) {
        const key = rd32(p), ptr = rd32(p + 4);
        const b = (key >>> shift) & 0xff;
        const d = rd32(0x25a24 + b * 4);
        wr32(d, key); wr32(d + 4, ptr);
        wr32(0x25a24 + b * 4, d + 8);
      }
    }
    pass(A, B, 0);
    pass(B, A, 8);
  };

  // ------------------------------------------------------------ per-object render paths
  function copyToTemp(ebp) {
    HP.copy(0x2a270, ebp, 0x3c);
    wr32(0x2a29c, 0); wr32(0x2a2a0, 0);
    wr32(0x2a2a8, rd32(ADDR.listAWrite)); wr32(0x2a2a4, rd32(ADDR.listBWrite));
  }
  HP.fn_2a542 = function (ebp) {          // 'Line' object
    let esi = rd32(ebp + 0x34), ecx = rd32(ebp + 0x2c);
    for (; ecx > 0; ecx--, esi += 0x3c) wr32(esi, 0x40);
    HP.fn_25414(ebp);
    copyToTemp(ebp);
    HP.fn_257c0(ebp);
    HP.fn_254fc(ebp);
    HP.fn_26408(ebp);
    HP.fn_254fc(0x2a270);
    HP.fn_26408(0x2a270);
  };
  HP.fn_2a5b4 = function (ebp) {          // 'Obu!' object
    wr32(0x26224, rd32(ebp + 0x28));
    const faces = rd32(ebp + 0x38);
    wr32(0x2a234, (0x26a42 - rd32(faces + 4)) >>> 0);
    if (rd32(faces + 4) === 0x26c41) wr32(0x2a234, 1);
    HP.fn_2589c(rd32(0x2a248), ebp);
    HP.fn_25414(ebp);
    HP.fn_27d90(rd32(0x2a24c), ebp);
    copyToTemp(ebp);
    HP.fn_256c5(ebp);
    HP.fn_254fc(ebp);
    HP.fn_2629f(ebp);
    if (rd32(0x2a234) !== 1) HP.fn_28002(ebp);
    HP.fn_254fc(0x2a270);
    HP.fn_2629f(0x2a270);
    if (rd32(0x2a234) !== 1) HP.fn_28002(0x2a270);
  };
  // fn_2a672: particles -> sort list
  HP.fn_2a672 = function () {
    const scene = rd32(0x2a24c);
    let esi = rd32(scene + 0x514);
    wr32(ADDR.tmpF, 0xff);
    wrf(0x28a20, 255 / (rdf(esi + 0x20) * rdf(ADDR.const2) * rdf(0x254f8)));
    let ecx = rd32(scene + 0x68);
    if (ecx === 0) return;
    const edx = rd32(0x2a248);
    let edi = rd32(0x25a20);
    const m = (o) => rdf(edx + o);
    for (; ecx > 0; ecx--, esi += 0x2c) {
      const px = rdf(esi + 4), py = rdf(esi + 8), pz = rdf(esi + 0xc);
      const X = ((px * m(0x24) + py * m(0x34)) + pz * m(0x44)) + m(0x54);
      const Y = ((px * m(0x28) + py * m(0x38)) + pz * m(0x48)) + m(0x58);
      const Z = ((px * m(0x2c) + py * m(0x3c)) + pz * m(0x4c)) + m(0x5c);
      wrf(esi + 0x1c, Z); wrf(0x28e50, Z); wrf(ADDR.tmpF, X); wrf(0x28e44, Y);
      if (!sign(0x28e50)) continue;
      const w = 1 / rdf(0x28e50);
      wrf(esi + 0x18, (rdf(0x28e44) * rdf(0x28ea8)) * w + rdf(0x254f4));
      wrf(esi + 0x14, (rdf(ADDR.tmpF) * rdf(0x254f8)) * w + rdf(0x254f0));
      wrf(esi + 0x10, w);
      wr32(esi + 0x28, rd32(0x28a20));
      const k = rne(-(((rdf(0x28e50) - rdf(0x251c4)) * rdf(0x251b4)) * rdf(ADDR.const3))) | 0;
      wr32(0x28e44, k);
      wr32(edi, (0xffff - k) >>> 0); wr32(edi + 4, esi); edi += 8;
      wr32(ADDR.drawItemCount, rd32(ADDR.drawItemCount) + 1);
    }
    wr32(0x25a20, edi);
  };

  // ------------------------------------------------------------ lighting
  // fn_27d90(esi=scene, ebp=object): light position/direction into object space; reset vertex lights
  HP.fn_27d90 = function (esi, ebp) {
    esi += 0x6c;
    wr32(0x27d8c, rd32(esi));
    let edi = rd32(ebp + 0x34), ecx = rd32(ebp + 0x2c);
    for (; ecx > 0; ecx--, edi += 0x3c) wr32(edi + 0x34, 0xffffffff);
    transposeObjMatrix();
    wrf(0x28e9c, rdf(esi + 4) - rdf(ebp + 8)); wrf(0x28ea0, rdf(esi + 8) - rdf(ebp + 0xc)); wrf(0x28ea4, rdf(esi + 0xc) - rdf(ebp + 0x10));
    HP.fn_24e53(0x28e9c, 0x24d90, 0x27d64);
    wrf(0x28e9c, rdf(esi + 0x10) - rdf(ebp + 8)); wrf(0x28ea0, rdf(esi + 0x14) - rdf(ebp + 0xc)); wrf(0x28ea4, rdf(esi + 0x18) - rdf(ebp + 0x10));
    HP.fn_24e53(0x28e9c, 0x24d90, 0x27d70);
    wrf(0x27d7c, rdf(0x27d64) - rdf(0x27d70)); wrf(0x27d80, rdf(0x27d68) - rdf(0x27d74)); wrf(0x27d84, rdf(0x27d6c) - rdf(0x27d78));
    HP.fn_24e1e(0x27d7c);
  };
  // fn_27ee5(esi=vertex): per-vertex light -> [esi+0x34] (1..255)
  HP.fn_27ee5 = function (esi) {
    const dx = rdf(0x27d64) - rdf(esi + 4), dy = rdf(0x27d68) - rdf(esi + 8), dz = rdf(0x27d6c) - rdf(esi + 0xc);
    wrf(0x28e80, dz); wrf(0x28e7c, dy); wrf(0x28e78, dx);
    const d2 = dx * dx + rdf(0x28e7c) * rdf(0x28e7c) + rdf(0x28e80) * rdf(0x28e80);
    wrf(0x27d88, d2);
    const fx = rdf(0x28e78), fy = rdf(0x28e7c), fz = rdf(0x28e80);
    const dot = (fz * rdf(esi + 0x28) + fy * rdf(esi + 0x24)) + fx * rdf(esi + 0x20);
    let v = (dot / d2) * rdf(0x2a254) + rdf(esi + 0x18) * rdf(0x2a258);
    if (rd32(0x27d8c) & 1) {
      let c = ((fx * rdf(0x27d7c) + fy * rdf(0x27d80)) + fz * rdf(0x27d84)) / Math.sqrt(rdf(0x27d88));
      c = c * c; c = c * c; c = c * c; c = c * c;
      v = v * c;
    }
    wrf(ADDR.cullTmp, v - rdf(ADDR.const1));
    if (sign(ADDR.cullTmp)) v = 1;
    wr32(ADDR.tmpF, 0xff);
    wrf(ADDR.cullTmp, 255 - v);
    if (sign(ADDR.cullTmp)) v = 255;
    wrf(esi + 0x34, v);
  };
  HP.fn_27ffc = function (esi) { HP.fn_27ee5(esi); };
  HP.fn_28002 = function (ebp) {
    if (rd32(ebp + 0x2c) === 0) return;
    let esi = rd32(ebp + 0x34), ecx = rd32(ebp + 0x2c);
    for (; ecx > 0; ecx--, esi += 0x3c) {
      if ((rd32(esi) & 0x80) && rd32(esi + 0x34) === 0xffffffff) HP.fn_27ee5(esi);
    }
  };
})();
// hplus port — engine part 3: drawing (fn_2a7d0 sort+dispatch, item handlers, screen-space clipping,
// flat / perspective-correct textured fillers, AA additive line drawer, particle sprites).
// NOTE: the original sets the x87 rounding mode to TRUNCATE for the whole of fn_2a7d0, so every
// fist/fistp here is Math.trunc.
(function () {
  const { rd8, rd16, rd32, rds32, wr8, wr16, wr32, rdf } = HP;
  const F = Math.fround;
  const tr = HP.truncInt;                 // fistp under RC=truncate (NaN/overflow -> 0x80000000)
  // Under RC=truncate every `fstp dword` rounds toward zero too: truncating float32 store.
  const f32a = new Float32Array(1), u32a = new Uint32Array(f32a.buffer);
  const wrfT = (a, v) => {
    if (v !== v) { wr32(a, 0xffc00000); return; }
    f32a[0] = v;
    if (Math.abs(f32a[0]) > Math.abs(v)) u32a[0] -= 1;      // rounded away from zero -> step toward zero
    wr32(a, u32a[0]);
  };
  HP.wrfTrunc = wrfT;
  const wrf = wrfT;                       // all float32 stores in this file happen inside fn_2a7d0
  const sign = (a) => (rd32(a) & 0x80000000) !== 0;
  let M;                                    // HP.M (bound at call time, may be re-initialised)

  // ------------------------------------------------------------ fn_2a7d0(ebp=scene): sort & draw all items
  HP.drawHandlers = {};                      // item fn ptr -> JS handler(ecx=item, ebp=scene)
  HP.fn_2a7d0 = function (ebp) {
    M = HP.M;
    wr32(0x28eac, rd32(rd32(ebp + 0x464)));
    wr16(0x28eb0, 0x037f);            // fnstcw (saved control word; RC is set to truncate while drawing)
    if (rd32(ADDR.drawItemCount) !== 0) {
      HP.fn_2649c();
      let esi = rd32(0x25a10) + 4;
      while (rd32(ADDR.drawItemCount) !== 0) {
        const ecx = rd32(esi);
        const h = HP.drawHandlers[rd32(ecx)];
        if (!h) throw new Error('unknown draw handler 0x' + rd32(ecx).toString(16) + ' for item 0x' + ecx.toString(16));
        h(ecx, ebp);
        esi += 8;
        wr32(ADDR.drawItemCount, rd32(ADDR.drawItemCount) - 1);
      }
    }
  };
  HP.drawHandlers[0x2a92a] = function () {};          // 'skip' handler

  // ------------------------------------------------------------ fn_2a81b: line item
  HP.drawHandlers[0x2a81b] = HP.fn_2a81b = function (ecx) {
    wr32(0x2a260, rd32(0x2a260) + 1);
    wr32(0x2802c, rd32(ecx + 4) >>> 8);
    const esi = rd32(ecx + 8), edi = rd32(ecx + 0xc);
    wr32(0x28038, rd32(esi + 0x10)); wr32(0x2803c, rd32(esi + 0x14));
    wr32(0x28048, rd32(edi + 0x10)); wr32(0x2804c, rd32(edi + 0x14));
    HP.fn_28270(0x28038, 0x28048);
  };

  // ------------------------------------------------------------ fn_2a86e: particle item
  HP.drawHandlers[0x2a86e] = HP.fn_2a86e = function (ecx) {
    wr32(0x2a264, rd32(0x2a264) + 1);
    let eax = tr(rdf(ecx + 0x28) * rdf(ecx + 0x1c) * rdf(0x28a14)) | 0;
    wr32(ADDR.tmpF2, eax);
    eax = eax >>> 0x11;
    if (!(eax < 0x3f)) eax = 0x3f;
    if (rd32(0x28a10) !== 0xffffffff) eax = rd32(0x28a10);
    wr32(0x28a2c, rd32(ADDR.particleOffset + eax * 4));
    const sz = rdf(ecx + 0x28) * rdf(ecx + 0x1c) * rdf(ADDR.particleScale + eax * 4);
    wrf(0x28a48, sz);
    wr32(0x28a50, tr(sz * rdf(0x28a14)) | 0);
    wrf(0x28a24, rdf(ecx + 0x20) * rdf(0x254f8) * rdf(ecx + 0x10));
    const hs = rdf(0x28a24);
    wrf(0x28a30, rdf(ecx + 0x14) - hs); wrf(0x28a34, rdf(ecx + 0x18) - hs);
    wrf(0x28a38, rdf(ecx + 0x14) + hs); wrf(0x28a3c, rdf(ecx + 0x18) + hs);
    HP.fn_28a64();
  };

  // ------------------------------------------------------------ fn_2a92f: polygon item
  HP.drawHandlers[0x2a92f] = HP.fn_2a92f = function (ecx) {
    wr32(0x2a25c, rd32(0x2a25c) + 1);
    let esi = rd32(ecx + 0xc), edi = rd32(ecx + 0x10), ebp = rd32(ecx + 0x14);
    let eax = 0xffffffff;
    if (rd32(ecx + 0x28) !== 0xffffffff) {
      let v = tr(rds32(ecx + 0x28) + rdf(esi + 0x18) * rdf(0x2a250)) | 0;
      wr32(0x28e4c, v);
      if (v <= 0) v = 0;
      if (v >= 0xff) v = 0xff;
      eax = rd32(ADDR.shadeRamp + v * 4);
    }
    wr32(0x269fc, eax);
    const tex = rd32(ecx + 0x2c) * 0x18 + rd32(0x2a24c) + 0x454;
    wr32(0x2a268, rd32(tex)); wr32(0x2a26c, rd32(tex + 4));
    wr32(0x268ec, rd32(tex + 0xc)); wr32(0x268f0, rd32(tex + 0x10));
    let filler = rd32(ecx + 4);
    if (filler !== 0x26a41 && filler !== 0x26c41 && filler !== 0x27d4a) {
      wrf(ADDR.cullTmp, rdf(esi + 0x34) + rdf(edi + 0x34) + rdf(ebp + 0x34) - rdf(ADDR.const3));
      if (rd32(ADDR.cullTmp) === rd32(0x28e60)) { wr32(0x269fc, rd32(0x28eac)); filler = 0x26a41; }
    }
    wr32(0x268e8, filler);
    const fill = HP.fillers[filler];
    if (!fill) throw new Error('unknown filler 0x' + filler.toString(16));
    if (((rd32(esi) | rd32(edi) | rd32(ebp)) & 0xf) === 0) { fill(esi, edi, ebp); return; }
    const savedClipPtr = rd32(ADDR.listBWrite);
    wr32(0x265a0, esi); wr32(0x265a4, edi); wr32(0x265a8, ebp); wr32(0x265ac, esi);
    wr32(ADDR.clipVertCount, 0);
    let src = 0x265a0, dst = 0x265f0;
    for (let i = 0; i < 3; i++) { src = HP.fn_2669e(src, dst); dst = src.dst; src = src.src; }
    do {
      if (rd32(ADDR.clipVertCount) < 3) break;
      wr32(dst, rd32(0x265f0));
      let n = rd32(ADDR.clipVertCount); wr32(ADDR.clipVertCount, 0); src = 0x265f0; dst = 0x265a0;
      for (; n > 0; n--) { const r = HP.fn_26749(src, dst); src = r.src; dst = r.dst; }
      if (rd32(ADDR.clipVertCount) < 3) break;
      wr32(dst, rd32(0x265a0));
      n = rd32(ADDR.clipVertCount); wr32(ADDR.clipVertCount, 0); src = 0x265a0; dst = 0x265f0;
      for (; n > 0; n--) { const r = HP.fn_267f4(src, dst); src = r.src; dst = r.dst; }
      if (rd32(ADDR.clipVertCount) < 3) break;
      wr32(dst, rd32(0x265f0));
      n = rd32(ADDR.clipVertCount); wr32(ADDR.clipVertCount, 0); src = 0x265f0; dst = 0x265a0;
      for (; n > 0; n--) { const r = HP.fn_26869(src, dst); src = r.src; dst = r.dst; }
      if (rd32(ADDR.clipVertCount) < 3) break;
      wr32(ADDR.clipVertCount, rd32(ADDR.clipVertCount) - 2);
      for (let k = 0; rd32(ADDR.clipVertCount) !== 0; k += 4) {
        const f = HP.fillers[rd32(0x268e8)];
        f(rd32(0x265a0), rd32(0x265a4 + k), rd32(0x265a8 + k));
        wr32(ADDR.clipVertCount, rd32(ADDR.clipVertCount) - 1);
      }
    } while (false);
    wr32(ADDR.listBWrite, savedClipPtr);
  };

  // ------------------------------------------------------------ screen-space polygon clippers
  // fn_26644(ecx=c, edx=d, esi=new vertex, t): interpolate 1/z and u,v,l (perspective-correct)
  HP.fn_26644 = function (ecx, edx, esi, t) {
    const cw = rdf(ecx + 0x1c), dw = rdf(edx + 0x1c);
    const nw = (dw - cw) * t + cw;
    wrf(esi + 0x1c, nw);
    const iw = 1 / nw;
    for (let o = 0x2c; o <= 0x34; o += 4) {
      const a = rdf(ecx + o) * cw, b = rdf(edx + o) * dw;
      const v = (a + (b - a) * t) * iw;
      if (v !== v) {
        // x87 propagates the QNaN operand (the one with the larger significand if both are NaN);
        // the vertex light of unlit vertices is the -1 marker 0xffffffff, which survives as such.
        const ba = rd32(ecx + o), bb = rd32(edx + o);
        const na = (ba & 0x7fffffff) > 0x7f800000, nb = (bb & 0x7fffffff) > 0x7f800000;
        let bits = 0xffc00000;
        if (na && nb) bits = ((ba & 0x7fffffff) >= (bb & 0x7fffffff)) ? ba : bb;
        else if (na) bits = ba; else if (nb) bits = bb;
        wr32(esi + o, bits);
      } else wrf(esi + o, v);
    }
  };
  function newFlagsX(esi) {
    const X = rdf(esi + 0x10);
    wrf(0x268f4, X - rdf(0x254e0)); wrf(ADDR.cullTmp, rdf(0x254e8) - X);
    return ((rd32(0x268f4) >>> 0x1e) & 2) | (rd32(ADDR.cullTmp) >>> 0x1f);
  }
  function clipper(bit, edgeAddr, horizontal, flagsFn) {
    return function (src, dst) {
      const ecx = rd32(src), edx = rd32(src + 4);
      src += 4;
      const ebx = (rd32(ecx) >>> bit) & 1;
      if (ebx === 0) { wr32(dst, ecx); dst += 4; wr32(ADDR.clipVertCount, rd32(ADDR.clipVertCount) + 1); }
      const eax = (rd32(edx) >>> bit) & 1;
      if (eax === ebx) return { src, dst };
      const esi = rd32(ADDR.listBWrite);
      let t;
      if (horizontal) {          // clip to a y boundary
        t = (rdf(edgeAddr) - rdf(ecx + 0x14)) / (rdf(edx + 0x14) - rdf(ecx + 0x14));
        wr32(esi + 0x14, rd32(edgeAddr));
        wrf(esi + 0x10, (rdf(edx + 0x10) - rdf(ecx + 0x10)) * t + rdf(ecx + 0x10));
      } else {
        t = (rdf(edgeAddr) - rdf(ecx + 0x10)) / (rdf(edx + 0x10) - rdf(ecx + 0x10));
        wr32(esi + 0x10, rd32(edgeAddr));
        wrf(esi + 0x14, (rdf(edx + 0x14) - rdf(ecx + 0x14)) * t + rdf(ecx + 0x14));
      }
      HP.fn_26644(ecx, edx, esi, t);
      wr32(esi, flagsFn ? flagsFn(esi) : 0);
      wr32(dst, esi);
      wr32(ADDR.listBWrite, rd32(ADDR.listBWrite) + 0x3c);
      dst += 4;
      wr32(ADDR.clipVertCount, rd32(ADDR.clipVertCount) + 1);
      return { src, dst };
    };
  }
  HP.fn_2669e = clipper(3, 0x254e4, true, newFlagsX);    // top    (bit 3: y < y0)
  HP.fn_26749 = clipper(2, 0x254ec, true, newFlagsX);    // bottom (bit 2: y > y1)
  HP.fn_267f4 = clipper(1, 0x254e0, false, null);        // left   (bit 1: x < x0)
  HP.fn_26869 = clipper(0, 0x254e8, false, null);        // right  (bit 0: x > x1)

  // ------------------------------------------------------------ fillers
  HP.fillers = {};
  HP.fillers[0x26c41] = HP.fn_26c41 = function () {};     // invisible
  // vertex sort by screen y (unsigned compare of the float bits, as the original)
  function sortY(esi, edi, ebp) {
    if (!(rd32(edi + 0x14) < rd32(ebp + 0x14))) { const t = ebp; ebp = edi; edi = t; }
    if (!(rd32(esi + 0x14) < rd32(edi + 0x14))) {
      let t = edi; edi = esi; esi = t;
      if (!(rd32(edi + 0x14) < rd32(ebp + 0x14))) { t = ebp; ebp = edi; edi = t; }
    }
    return [esi, edi, ebp];
  }
  // fn_26a0d(eax=color, ebx=xl 16.16, edx=xr 16.16, ebp=row ptr): fill [0x26958] scanlines
  HP.fn_26a0d = function (eax, ebx, edx, ebp) {
    let esi = rd32(0x26958);
    const pitch = rds32(0x26a00), dxr = rds32(0x26960), dxl = rds32(0x2695c);
    for (; esi !== 0; esi--) {
      edx = (edx + dxr) | 0; ebx = (ebx + dxl) | 0;
      let ecx = edx >> 16; const xl = ebx >> 16;
      ecx -= xl;
      const edi = xl * 4 + ebp;
      if (ecx > 0) HP.fill32(edi, eax, ecx);
      ebp = (ebp + pitch) | 0;
    }
    return [ebx, edx];
  };
  // fn_26a41(esi, edi, ebp = vertices): flat triangle with color [0x269fc]
  HP.fillers[0x26a41] = HP.fn_26a41 = function (esi, edi, ebp) {
    wr32(0x26a00, rd32(0x28808) << 2);
    [esi, edi, ebp] = sortY(esi, edi, ebp);
    const ytop = tr(rdf(esi + 0x14)) | 0, ymid = tr(rdf(edi + 0x14)) | 0, ybot = tr(rdf(ebp + 0x14)) | 0;
    wr32(0x269d8, ytop); wr32(0x269dc, ymid); wr32(0x269e0, ybot);
    if (ybot - ytop === 0) return;
    wrf(0x268f8, (rdf(ebp + 0x10) - rdf(esi + 0x10)) / (rdf(ebp + 0x14) - rdf(esi + 0x14)));
    wr32(0x2690c, tr(((ytop - rdf(esi + 0x14)) * rdf(0x268f8) + rdf(esi + 0x10)) * rdf(ADDR.angle16Scale)) | 0);
    const color = rd32(0x269fc), buf = rd32(0x2a244);
    if (ymid - ytop !== 0) {
      wr32(0x26958, ymid - ytop);
      wrf(0x26910, (rdf(edi + 0x10) - rdf(esi + 0x10)) / (rdf(edi + 0x14) - rdf(esi + 0x14)));
      wr32(0x26924, tr(((ytop - rdf(esi + 0x14)) * rdf(0x26910) + rdf(esi + 0x10)) * rdf(ADDR.angle16Scale)) | 0);
      let ecx = 0x268f8, edx = 0x26910;
      wrf(ADDR.cullTmp, rdf(0x26910) - rdf(0x268f8));
      if (sign(ADDR.cullTmp)) { const t = ecx; ecx = edx; edx = t; }
      wr32(0x2695c, tr(rdf(ecx) * rdf(ADDR.angle16Scale)) | 0);
      wr32(0x26960, tr(rdf(edx) * rdf(ADDR.angle16Scale)) | 0);
      const row = (ytop * rds32(0x26a00) + buf) | 0;
      const r = HP.fn_26a0d(color, rds32(ecx + 0x14), rds32(edx + 0x14), row);
      wr32(ecx + 0x14, r[0]); wr32(edx + 0x14, r[1]);
    }
    if (ybot - ymid !== 0) {
      wr32(0x26958, ybot - ymid);
      wrf(0x26910, (rdf(ebp + 0x10) - rdf(edi + 0x10)) / (rdf(ebp + 0x14) - rdf(edi + 0x14)));
      wr32(0x26924, tr(((ymid - rdf(edi + 0x14)) * rdf(0x26910) + rdf(edi + 0x10)) * rdf(ADDR.angle16Scale)) | 0);
      let ecx = 0x268f8, edx = 0x26910;
      wrf(ADDR.cullTmp, rdf(0x26910) - rdf(0x268f8));
      if (!sign(ADDR.cullTmp)) { const t = ecx; ecx = edx; edx = t; }
      wr32(0x2695c, tr(rdf(ecx) * rdf(ADDR.angle16Scale)) | 0);
      wr32(0x26960, tr(rdf(edx) * rdf(ADDR.angle16Scale)) | 0);
      const row = (ymid * rds32(0x26a00) + buf) | 0;
      HP.fn_26a0d(color, rds32(ecx + 0x14), rds32(edx + 0x14), row);
    }
  };

  // ---- perspective-correct textured triangle (fn_271d2 with inner span loop fn_26c5c, or additive fn_277da)
  // pixel loop. regs: ecx = v_frac<<16 | light(8.8), edx = u_frac<<16 | v_int(8), bl = u_int(8), bh = v_int
  function pixelLoop(n, edi, st, additive) {
    const A = st.A, B = st.B, C = st.C, texHi = st.texHi, shade = st.shade;
    let ecx = st.ecx, edx = st.edx, bl = st.bl;
    const m = HP.M;
    for (; n > 0; n--) {
      const bh = edx & 0xff;
      const ah = (ecx >>> 8) & 0xff;
      edi += 4;
      let s = ecx + A; const c1 = s > 0xffffffff ? 1 : 0; ecx = s >>> 0;
      const texel = m[(texHi | (bh << 8) | bl) >>> 0];
      s = edx + B + c1; const c2 = s > 0xffffffff ? 1 : 0; edx = s >>> 0;
      if (additive) {
        bl = (bl + C + c2) & 0xff;
        let al = texel + m[edi];
        if (al > 0xff) al = 0xff;
        m[edi] = al;
      } else {
        const color = rd32(shade + (((ah << 8) | texel) << 2));
        bl = (bl + C + c2) & 0xff;
        wr32(edi, color);
      }
    }
    st.ecx = ecx; st.edx = edx; st.bl = bl;
    return edi;
  }
  // end-of-span values from attributes (lw,vw,uw,w): u,v,l in 16.16 (trunc)
  function endVals(a) {
    const z = 1 / a.w;
    const l = a.lw * z, v = a.vw * z, u = a.uw * z;
    return { u: tr(u * 65536) | 0, v: tr(v * 65536) | 0, l: tr(l * 65536) | 0 };
  }
  // fn_26c5c / fn_277da: span loop over [0x26958] lines. ecx/edx = left/right edge gradient blocks,
  // ebp = row pointer, xr/xl = running edge x. returns {xl, xr} (left on the x87 stack by the original).
  function spanLoop(ecx, edx, ebp, xr, xl, additive) {
    ebp -= 4;
    let lines = rd32(0x26958);
    const texHi = (rd32(0x268ec) & 0xffff0000) >>> 0, shade = rd32(0x268f0);
    const st = { A: 0, B: 0, C: 0, ecx: 0, edx: 0, bl: 0, texHi, shade };
    const dwdx = rdf(0x26928), duwdx = rdf(0x2692c), dvwdx = rdf(0x26930), dlwdx = rdf(0x26934);
    const dw16 = rdf(0x26938), duw16 = rdf(0x2693c), dvw16 = rdf(0x26940), dlw16 = rdf(0x26944);
    do {
      xr = xr + rdf(0x26960); xl = xl + rdf(0x2695c);
      const xri = tr(xr) | 0, xli = tr(xl) | 0;
      wr32(0x26968, xri); wrf(0x26c54, xr); wr32(0x26964, xli); wrf(0x26c50, xl);
      const pre = (xli - rdf(0x26c50)) + rdf(ADDR.const1);
      wrf(0x26c58, pre);
      const n = rdf(0x2696c), pref = rdf(0x26c58);
      const w0 = (rdf(ecx + 4) * n + rdf(0x26948)) + dwdx * pref;
      const uw0 = (rdf(ecx + 8) * n + rdf(0x2694c)) + duwdx * pref;
      const vw0 = (rdf(ecx + 0xc) * n + rdf(0x26950)) + dvwdx * pref;
      const lw0 = (rdf(ecx + 0x10) * n + rdf(0x26954)) + dlwdx * pref;
      wrf(0x2696c, n + rdf(ADDR.const1));
      let edi = xli;
      let cnt = xri - edi;
      if (cnt > 0) {
        edi <<= 2;
        let a = { lw: lw0, vw: vw0, uw: uw0, w: w0 };
        let cur = endVals(a);
        wr32(0x26978, cur.l); wr32(0x26974, cur.v); wr32(0x26970, cur.u);
        edi += ebp;
        let full = cnt >> 4; const rem = cnt & 0xf;
        wr32(0x268f4, full);
        if (rem !== 0) {
          wrf(ADDR.cullTmp, rem);
          const r = rdf(ADDR.cullTmp);
          a = { lw: dlwdx * r + a.lw, vw: dvwdx * r + a.vw, uw: duwdx * r + a.uw, w: dwdx * r + a.w };
          let e = endVals(a);
          wr32(0x26984, e.l); wr32(0x26980, e.v); wr32(0x2697c, e.u);
          wr32(ADDR.cullTmp, rem);
          const inv = rdf(0x26990 + rem * 4);
          const du = tr((e.u - cur.u) * inv) | 0, dv = tr((e.v - cur.v) * inv) | 0, dl = tr((e.l - cur.l) * inv) | 0;
          wr32(0x2698c, dv); wr32(0x26990, dl); wr32(0x26988, du);
          if (full !== 0) a = { lw: a.lw + dlw16, vw: a.vw + dvw16, uw: a.uw + duw16, w: a.w + dw16 };
          st.A = (((dv << 16) | ((dl >>> 8) & 0xffff)) >>> 0);
          st.B = (((du << 16) | ((dv >>> 16) & 0xff)) >>> 0);
          st.C = (du >>> 16) & 0xff;
          wr32(0x26a04, st.A); wr32(0x26a08, st.B); wr8(0x26a0c, st.C);
          st.ecx = (((cur.v << 16) | ((cur.l >>> 8) & 0xffff)) >>> 0);
          st.edx = (((cur.u << 16) | ((cur.v >>> 16) & 0xff)) >>> 0);
          st.bl = (cur.u >>> 16) & 0xff;
          wr32(0x26970, e.u); wr32(0x26974, e.v); wr32(0x26978, e.l);
          cur = e;
          wr32(ADDR.cullTmp, rem);
          edi = pixelLoop(rem, edi, st, additive);
          if (full !== 0) {
            e = endVals(a);
            wr32(0x26984, e.l); wr32(0x26980, e.v); wr32(0x2697c, e.u);
          }
        } else {
          a = { lw: a.lw + dlw16, vw: a.vw + dvw16, uw: a.uw + duw16, w: a.w + dw16 };
          const e = endVals(a);
          wr32(0x26984, e.l); wr32(0x26980, e.v); wr32(0x2697c, e.u);
        }
        if (full !== 0) {
          // register setup from the current start values [0x26970..]
          const u0 = rds32(0x26970), v0 = rds32(0x26974), l0 = rds32(0x26978);
          st.ecx = (((v0 << 16) | ((l0 >>> 8) & 0xffff)) >>> 0);
          st.edx = (((u0 << 16) | ((v0 >>> 16) & 0xff)) >>> 0);
          st.bl = (u0 >>> 16) & 0xff;
          a = { lw: a.lw + dlw16, vw: a.vw + dvw16, uw: a.uw + duw16, w: a.w + dw16 };
          for (;;) {
            const z = 1 / a.w;
            const su = rds32(0x26970), sv = rds32(0x26974), sl = rds32(0x26978);
            let eu = rds32(0x2697c), ev = rds32(0x26980), el = rds32(0x26984);
            const du = (eu - su) >> 4, dv = (ev - sv) >> 4; let dl = (el - sl) >> 4;
            wr32(0x26988, du); wr32(0x2698c, dv);
            dl = dl >>> 8;
            st.A = (((dv << 16) | (dl & 0xffff)) >>> 0);
            st.B = (((du << 16) | ((dv >>> 16) & 0xff)) >>> 0);
            st.C = (du >>> 16) & 0xff;
            wr32(0x26a04, st.A); wr32(0x26a08, st.B); wr8(0x26a0c, st.C);
            wr32(0x26970, eu); wr32(0x26974, ev); wr32(0x26978, el);
            edi = pixelLoop(16, edi, st, additive);
            const l2 = a.lw * z, v2 = a.vw * z, u2 = a.uw * z;
            wr32(0x26984, tr(l2 * 65536) | 0); wr32(0x26980, tr(v2 * 65536) | 0); wr32(0x2697c, tr(u2 * 65536) | 0);
            a = { lw: a.lw + dlw16, vw: a.vw + dvw16, uw: a.uw + duw16, w: a.w + dw16 };
            full--; wr32(0x268f4, full);
            if (full === 0) break;
          }
        }
      }
      ebp += 0x500;
      xl = rdf(0x26c50); xr = rdf(0x26c54);
    } while (--lines !== 0);
    return { xl, xr };
  }
  // fn_271d2(esi, edi, ebp = vertices): textured triangle; additive variant = fn_27d4a
  function texTri(esi, edi, ebp, additive) {
    [esi, edi, ebp] = sortY(esi, edi, ebp);
    const ytop = tr(rdf(esi + 0x14)) | 0, ymid = tr(rdf(edi + 0x14)) | 0, ybot = tr(rdf(ebp + 0x14)) | 0;
    wr32(0x269dc, ymid); wr32(0x269e0, ybot); wr32(0x269d8, ytop);
    if (ybot - ytop === 0) return;
    const tu = rdf(0x2a268), tv = rdf(0x2a26c);
    wrf(0x269e4, rdf(esi + 0x2c) * tu); wrf(0x269e8, rdf(esi + 0x30) * tv);
    wrf(0x269ec, rdf(edi + 0x2c) * tu); wrf(0x269f0, rdf(edi + 0x30) * tv);
    wrf(0x269f4, rdf(ebp + 0x2c) * tu); wrf(0x269f8, rdf(ebp + 0x30) * tv);
    const S = (v) => rdf(v + 0x10), Y = (v) => rdf(v + 0x14), W = (v) => rdf(v + 0x1c), L = (v) => rdf(v + 0x34);
    {
      const ih = 1 / (Y(ebp) - Y(esi));
      wrf(0x268f8, (S(ebp) - S(esi)) * ih);
      wrf(0x268fc, (W(ebp) - W(esi)) * ih);
      wrf(0x26900, (rdf(0x269f4) * W(ebp) - rdf(0x269e4) * W(esi)) * ih);
      wrf(0x26904, (rdf(0x269f8) * W(ebp) - rdf(0x269e8) * W(esi)) * ih);
      wrf(0x26908, (L(ebp) * W(ebp) - L(esi) * W(esi)) * ih);
    }
    const buf = rd32(0x2a244);
    function perXGradients(ecx, edx) {
      const idx = 1 / (rdf(edx) - rdf(ecx));
      let g = (rdf(edx + 4) - rdf(ecx + 4)) * idx; wrf(0x26928, g); wrf(0x26938, g * rdf(ADDR.const16));
      g = (rdf(edx + 8) - rdf(ecx + 8)) * idx; wrf(0x2692c, g); wrf(0x2693c, g * rdf(ADDR.const16));
      g = (rdf(edx + 0xc) - rdf(ecx + 0xc)) * idx; wrf(0x26930, g); wrf(0x26940, g * rdf(ADDR.const16));
      g = (rdf(edx + 0x10) - rdf(ecx + 0x10)) * idx; wrf(0x26934, g); wrf(0x26944, g * rdf(ADDR.const16));
    }
    function edgeStart(v, yi, ecx, uvU, uvV) {   // attribute starts along edge ecx from vertex v at integer y yi
      const p = yi - Y(v);
      wrf(0x26948, p * rdf(ecx + 4) + W(v));
      wrf(0x2694c, p * rdf(ecx + 8) + rdf(uvU) * W(v));
      wrf(0x26950, p * rdf(ecx + 0xc) + rdf(uvV) * W(v));
      wrf(0x26954, p * rdf(ecx + 0x10) + L(v) * W(v));
    }
    let xl, xr;
    if (ymid - ytop !== 0) {
      wr32(0x26958, ymid - ytop);
      const ih2 = 1 / (Y(edi) - Y(esi));
      wrf(0x26910, (S(edi) - S(esi)) * ih2);
      wrf(0x26914, (W(edi) - W(esi)) * ih2);
      wrf(0x26918, (rdf(0x269ec) * W(edi) - rdf(0x269e4) * W(esi)) * ih2);
      wrf(0x2691c, (rdf(0x269f0) * W(edi) - rdf(0x269e8) * W(esi)) * ih2);
      wrf(0x26920, (L(edi) * W(edi) - L(esi) * W(esi)) * ih2);
      let ecx = 0x268f8, edx = 0x26910;
      wrf(ADDR.cullTmp, rdf(0x26910) - rdf(0x268f8));
      if (sign(ADDR.cullTmp)) { const t = ecx; ecx = edx; edx = t; }
      wr32(0x2695c, rd32(ecx)); wr32(0x26960, rd32(edx));
      perXGradients(ecx, edx);
      edgeStart(esi, ytop, ecx, 0x269e4, 0x269e8);
      const p = ytop - Y(esi);
      xl = p * rdf(ecx) + S(esi); xr = p * rdf(edx) + S(esi);
      wrf(0x2696c, 1);
      const row = (ytop * 1280 + buf) | 0;
      const r = spanLoop(ecx, edx, row, xr, xl, additive);
      xl = r.xl; xr = r.xr;
      if (ybot - ymid === 0) return;
      wr32(0x26958, ybot - ymid);
      const ih3 = 1 / (Y(ebp) - Y(edi));
      wrf(0x26910, (S(ebp) - S(edi)) * ih3);
      wrf(0x26914, (W(ebp) - W(edi)) * ih3);
      wrf(0x26918, (rdf(0x269f4) * W(ebp) - rdf(0x269ec) * W(edi)) * ih3);
      wrf(0x2691c, (rdf(0x269f8) * W(ebp) - rdf(0x269f0) * W(edi)) * ih3);
      wrf(0x26920, (L(ebp) * W(ebp) - L(edi) * W(edi)) * ih3);
      ecx = 0x268f8; edx = 0x26910;
      wrf(ADDR.cullTmp, rdf(0x26910) - rdf(0x268f8));
      if (!sign(ADDR.cullTmp)) {
        const t = ecx; ecx = edx; edx = t;           // short edge is the left edge
        wrf(0x2696c, 1);
        edgeStart(edi, ymid, ecx, 0x269ec, 0x269f0);
        // stack: [xr_old, xl_old] -> fxch; fstp -> keep xr_old; new xl from edi
        xl = (ymid - Y(edi)) * rdf(ecx) + S(edi);
      } else {
        xr = (ymid - Y(edi)) * rdf(edx) + S(edi);    // keep xl_old (long edge continues)
      }
      wr32(0x2695c, rd32(ecx)); wr32(0x26960, rd32(edx));
      const row2 = (ymid * 1280 + buf) | 0;
      spanLoop(ecx, edx, row2, xr, xl, additive);
      return;
    }
    // lower half only (ymid == ytop)
    if (ybot - ymid === 0) return;
    wr32(0x26958, ybot - ymid);
    const ih3 = 1 / (Y(ebp) - Y(edi));
    wrf(0x26910, (S(ebp) - S(edi)) * ih3);
    wrf(0x26914, (W(ebp) - W(edi)) * ih3);
    wrf(0x26918, (rdf(0x269f4) * W(ebp) - rdf(0x269ec) * W(edi)) * ih3);
    wrf(0x2691c, (rdf(0x269f8) * W(ebp) - rdf(0x269f0) * W(edi)) * ih3);
    wrf(0x26920, (L(ebp) * W(ebp) - L(edi) * W(edi)) * ih3);
    let ecx = 0x268f8, edx = 0x26910;
    wrf(ADDR.cullTmp, rdf(0x26910) - rdf(0x268f8));
    if (!sign(ADDR.cullTmp)) {
      let t = ecx; ecx = edx; edx = t;
      t = edi; edi = esi; esi = t;
      const a = rd32(0x269e4), b = rd32(0x269e8);
      wr32(0x269e4, rd32(0x269ec)); wr32(0x269e8, rd32(0x269f0));
      wr32(0x269ec, a); wr32(0x269f0, b);
    }
    xl = (ytop - Y(esi)) * rdf(ecx) + S(esi);
    xr = (ymid - Y(edi)) * rdf(edx) + S(edi);
    edgeStart(esi, ytop, ecx, 0x269e4, 0x269e8);
    perXGradients(ecx, edx);
    wrf(0x2696c, 1);
    wr32(0x2695c, rd32(ecx)); wr32(0x26960, rd32(edx));
    const row = (ymid * 1280 + buf) | 0;
    spanLoop(ecx, edx, row, xr, xl, additive);
  }
  HP.fillers[0x271d2] = HP.fn_271d2 = function (esi, edi, ebp) { texTri(esi, edi, ebp, false); };
  HP.fillers[0x27d4a] = HP.fn_27d4a = function (esi, edi, ebp) {
    wr32(0x271ce, 0x277da); texTri(esi, edi, ebp, true); wr32(0x271ce, 0x26c5c);
  };

  // ------------------------------------------------------------ fn_28270(esi, edi = endpoint blocks {x,y,xi,yi}): AA line
  HP.fn_28270 = function (esi, edi) {
    const pitch = rd32(0x28808) << 2;
    wr32(0x28028, pitch); wr32(0x28631, pitch); wr32(0x28642, pitch); wr32(0x286a2, pitch); wr32(0x286ac, pitch + 1);
    wr32(0x286c1, pitch); wr32(0x286c8, pitch + 1); wr32(0x286cf, pitch + 2); wr32(0x286de, pitch + 2);
    const half = rdf(ADDR.constHalf);
    wrf(esi, rdf(esi) - half); wrf(edi, rdf(edi) - half);
    wrf(esi + 4, rdf(esi + 4) - half); wrf(edi + 4, rdf(edi + 4) - half);
    for (let ecx = 2; ecx > 0; ecx--) {
      wrf(ADDR.cullTmp, rdf(esi) - rdf(0x254e0));
      if (sign(ADDR.cullTmp)) {
        const prod = (rdf(edi + 4) - rdf(esi + 4)) * (rdf(0x254e0) - rdf(esi));
        const dx = rdf(edi) - rdf(esi);
        wr32(ADDR.cullTmp, tr(dx) | 0);
        if (rd32(ADDR.cullTmp) === 0) return;
        wrf(esi + 4, prod / dx + rdf(esi + 4));
        wrf(esi, rdf(0x254e0));
      }
      wrf(ADDR.cullTmp, rdf(esi + 4) - rdf(0x254e4));
      if (sign(ADDR.cullTmp)) {
        const prod = (rdf(edi) - rdf(esi)) * (rdf(0x254e4) - rdf(esi + 4));
        const dy = rdf(edi + 4) - rdf(esi + 4);
        wr32(ADDR.cullTmp, tr(dy) | 0);
        if (rd32(ADDR.cullTmp) === 0) return;
        wrf(esi, prod / dy + rdf(esi));
        wrf(esi + 4, rdf(0x254e4));
      }
      wrf(ADDR.cullTmp, rdf(0x28030) - rdf(esi));
      if (sign(ADDR.cullTmp)) {
        const prod = (rdf(edi + 4) - rdf(esi + 4)) * (rdf(0x28030) - rdf(esi));
        const dx = rdf(edi) - rdf(esi);
        wr32(ADDR.cullTmp, tr(dx) | 0);
        if (rd32(ADDR.cullTmp) === 0) return;
        wrf(esi + 4, prod / dx + rdf(esi + 4));
        wrf(esi, rdf(0x28030));
      }
      wrf(ADDR.cullTmp, rdf(0x28034) - rdf(esi + 4));
      if (sign(ADDR.cullTmp)) {
        const prod = (rdf(edi) - rdf(esi)) * (rdf(0x28034) - rdf(esi + 4));
        const dy = rdf(edi + 4) - rdf(esi + 4);
        wr32(ADDR.cullTmp, tr(dy) | 0);
        if (rd32(ADDR.cullTmp) === 0) return;
        wrf(esi, prod / dy + rdf(esi));
        wrf(esi + 4, rdf(0x28034));
      }
      const t = esi; esi = edi; edi = t;
    }
    wr32(esi + 0xc, tr(rdf(esi + 4)) | 0); wr32(edi + 0xc, tr(rdf(edi + 4)) | 0);
    wr32(esi + 8, tr(rdf(esi)) | 0); wr32(edi + 8, tr(rdf(edi)) | 0);
    const ady = Math.abs(rds32(edi + 0xc) - rds32(esi + 0xc)), adx = Math.abs(rds32(edi + 8) - rds32(esi + 8));
    const buf = rd32(0x2a244);
    const m = HP.M;
    const T = 0x28070;
    const white = rd32(0x2802c) === 1;
    if (!(ady < adx)) {
      // y-major
      if (!(rds32(esi + 0xc) < rds32(edi + 0xc))) { const t = esi; esi = edi; edi = t; }
      const dx = rdf(edi) - rdf(esi), dy = rdf(edi + 4) - rdf(esi + 4);
      wr32(ADDR.cullTmp, tr(dy) | 0);
      if (rd32(ADDR.cullTmp) === 0) return;
      const slope = dx / dy;
      const x0 = (rds32(esi + 0xc) - rdf(esi + 4)) * slope + rdf(esi);
      wr32(0x28058, tr(x0 * rdf(ADDR.fixed16Scale)) | 0);
      wr32(0x2805c, tr(slope * rdf(ADDR.fixed16Scale)) | 0);
      let ebp = rds32(edi + 0xc) - rds32(esi + 0xc);
      if (ebp === 0) return;
      let p = (rds32(esi + 0xc) * pitch + buf) | 0;
      let x = rds32(0x28058);
      const step = rds32(0x2805c);
      if (!white) {
        for (; ebp > 0; ebp--) {
          x = (x + step) | 0; p += pitch;
          const xi = x >>> 16, fr = (x >>> 8) & 0xff;
          const a = p + xi * 4;
          let dh = (0xff - fr) + m[a]; if (dh > 0xff) dh = 0xff;
          let ah = fr + m[a + 4]; if (ah > 0xff) ah = 0xff;
          m[a] = dh; m[a + 4] = ah;
        }
      } else {
        for (; ebp > 0; ebp--) {
          x = (x + step) | 0; p += pitch;
          const xi = x >>> 16;
          let e = ((0x10000 - x) >>> 10) & 0x3f;
          const a = p + xi * 4;
          m[a] = m[T + e + m[a]]; m[a + 1] = m[T + e + m[a + 1]]; m[a + 2] = m[T + e + m[a + 2]];
          e = 0x40 - e;
          m[a + 4] = m[T + e + m[a + 4]]; m[a + 5] = m[T + e + m[a + 5]]; m[a + 6] = m[T + e + m[a + 6]];
        }
      }
    } else {
      // x-major
      if (!(rds32(esi + 8) < rds32(edi + 8))) { const t = esi; esi = edi; edi = t; }
      const dy = rdf(edi + 4) - rdf(esi + 4), dx = rdf(edi) - rdf(esi);
      wr32(ADDR.cullTmp, tr(dx) | 0);
      if (rd32(ADDR.cullTmp) === 0) return;
      const slope = dy / dx;
      const y0 = (rds32(esi + 8) - rdf(esi)) * slope + rdf(esi + 4);
      wr32(0x28058, tr(y0 * rdf(ADDR.fixed16Scale)) | 0);
      wr32(0x2805c, tr(slope * rdf(ADDR.fixed16Scale)) | 0);
      let ebp = rds32(edi + 8) - rds32(esi + 8);
      if (ebp === 0) return;
      let p = (rds32(esi + 8) * 4 + buf) | 0;
      let y = rds32(0x28058);
      const step = rds32(0x2805c);
      if (!white) {
        for (; ebp > 0; ebp--) {
          y = (y + step) | 0; p += 4;
          const yi = y >>> 16, fr = (y >>> 8) & 0xff;
          const a = p + Math.imul(yi, pitch);
          let dh = (0xff - fr) + m[a]; if (dh > 0xff) dh = 0xff;
          let ah = fr + m[a + pitch]; if (ah > 0xff) ah = 0xff;
          m[a] = dh; m[a + pitch] = ah;
        }
      } else {
        for (; ebp > 0; ebp--) {
          y = (y + step) | 0; p += 4;
          const yi = y >>> 16;
          let e = ((0x10000 - y) >>> 10) & 0x3f;
          const a = p + Math.imul(yi, pitch);
          m[a] = m[T + e + m[a]]; m[a + 1] = m[T + e + m[a + 1]]; m[a + 2] = m[T + e + m[a + 2]];
          e = 0x40 - e;
          m[a + pitch] = m[T + e + m[a + pitch]]; m[a + pitch + 1] = m[T + e + m[a + pitch + 1]]; m[a + pitch + 2] = m[T + e + m[a + pitch + 2]];
        }
      }
    }
  };

  // ------------------------------------------------------------ fn_28a64: particle sprite blit (additive on the blue byte)
  HP.fn_28a64 = function () {
    const m = HP.M;
    let x0 = tr(rdf(0x28a30)) | 0, y0 = tr(rdf(0x28a34)) | 0;
    wr32(0x28a40, x0); wr32(0x269d8, y0);
    let x1 = tr(rdf(0x28a38)) | 0, y1 = tr(rdf(0x28a3c)) | 0;
    wr32(0x28a44, x1); wr32(0x269dc, y1);
    const bot1 = rds32(0x28804), right1 = rds32(0x28800), top = rds32(0x287f4), left = rds32(0x287f0);
    if (y1 < top) return;
    if (y0 > bot1) return;
    if (x1 < left) return;
    if (x0 > right1) return;
    const sc = rdf(0x28a48), k = rdf(0x28a14);
    wr32(0x28a58, tr((x0 - rdf(0x28a30)) * sc * k) | 0);
    wr32(0x28a5c, tr((y0 - rdf(0x28a34)) * sc * k) | 0);
    const step = rds32(0x28a50);
    const right = rds32(0x287f8);
    if (!(x0 > left)) { wr32(0x28a58, (rds32(0x28a58) + Math.imul(left - x0, step)) | 0); x0 = left; wr32(0x28a40, x0); }
    if (!(x1 < right)) { x1 = right; wr32(0x28a44, x1); }
    if (!(y0 > top)) { wr32(0x28a5c, (rds32(0x28a5c) + Math.imul(top - y0, step)) | 0); y0 = top; wr32(0x269d8, y0); }
    const bottom = rds32(0x287fc);
    if (!(y1 < bottom)) { y1 = bottom; wr32(0x269dc, y1); }
    const width = x1 - x0;
    if (width === 0) return;
    wr32(ADDR.cullTmp, width);
    const rowadv = (rds32(0x28808) - width) << 2;
    wr32(0x28c4d, rowadv);
    const lvl = rd32(0x28a2c); wr32(0x28c3e, lvl);
    let edi = (((Math.imul(y0, rds32(0x28808)) + x0) << 2) + rd32(0x2a244) - 4) | 0;
    let rows = y1 - y0;
    if (rows === 0) return;
    let v = rds32(0x28a5c);
    const ustart = (rds32(0x28a58) + step) | 0;
    wr32(0x28a58, ustart);
    wr32(0x28a60, rows);
    const tex = rd32(0x28e5c);
    for (; rows > 0; rows--) {
      v = (v + step) | 0;
      let u = ustart;
      const rowbase = ((v >>> 16) << 8) + tex + lvl;
      for (let n = width; n > 0; n--) {
        let dl = m[edi + 4];
        const ui = u >>> 16;
        edi += 4; u = (u + step) | 0;
        dl += m[rowbase + ui];
        if (dl > 0xff) dl = 0xff;
        m[edi] = dl;
      }
      edi += rowadv;
      wr32(0x28a60, rows - 1);
    }
  };
})();
// hplus port — engine part 4: camera spline + walker, debug camera, present (fn_2b0a8) with FPS overlay,
// text printing, video layer (fn_2c845 mode init, fn_2c9f4 present -> HP.videoOut), DOS print, misc.
(function () {
  const { rd8, rd16, rds16, rd32, rds32, wr8, wr16, wr32, rdf, wrf, roundHalfEven } = HP;
  const F = Math.fround;
  const rne = roundHalfEven;
  const sign = (a) => (rd32(a) & 0x80000000) !== 0;

  // ------------------------------------------------------------ fn_28ca4(ebx=walker, ecx=count, edi=path base)
  // walker: +0 t (float), +8 byte offset of the current key (in "float units", multiple of 0x28), +0xc total size
  // evaluates a Catmull-Rom-ish cubic for `count` channels -> [0x28c74 + i*4]
  HP.fn_28ca4 = function (ebx, ecx, edi) {
    const t = rdf(ebx);
    const hf = rdf(0x28c60), two = rdf(ADDR.const2), three = rdf(ADDR.const3);
    if (rd32(0x28c9c) === 0) {
      let ebp = rd32(ebx + 8) + 0x28;
      for (let i = 0; i < ecx; i++, ebp += 4) {
        const cur = rdf(edi + ebp); wrf(0x28c70, cur);
        const c = (rdf(edi + ebp + 0x28) - rdf(edi + ebp - 0x28)) * hf; wrf(0x28c6c, c);
        let b = (rdf(edi + ebp + 0x28) - rdf(0x28c70)) * three;
        b = b + (-(rdf(0x28c6c) * two));
        b = b + (-((rdf(edi + ebp + 0x50) - rdf(edi + ebp)) * hf));
        wrf(0x28c68, b);
        const a = rdf(edi + ebp + 0x28) - rdf(0x28c68) - rdf(0x28c6c) - rdf(0x28c70); wrf(0x28c64, a);
        const r = rdf(0x28c64) * t * t * t + ((rdf(0x28c68) * t * t) + (rdf(0x28c6c) * t + rdf(0x28c70)));
        wrf(0x28c74 + i * 4, r);
      }
    } else {
      let ebp = (rd32(ebx + 8) + 0x28) >>> 1;
      const sc = rdf(0x28ca0);
      for (let i = 0; i < ecx; i++, ebp += 2) {
        const cur = rds16(edi + ebp); wrf(0x28c70, cur);
        const c = (rds16(edi + ebp + 0x14) - rds16(edi + ebp - 0x14)) * hf; wrf(0x28c6c, c);
        let b = (rds16(edi + ebp + 0x14) - rdf(0x28c70)) * three;
        b = b + (-(rdf(0x28c6c) * two));
        b = b + (-((rds16(edi + ebp + 0x28) - rds16(edi + ebp)) * hf));
        wrf(0x28c68, b);
        const a = rds16(edi + ebp + 0x14) - rdf(0x28c68) - rdf(0x28c6c) - rdf(0x28c70); wrf(0x28c64, a);
        const r = (rdf(0x28c64) * t * t * t + ((rdf(0x28c68) * t * t) + (rdf(0x28c6c) * t + rdf(0x28c70)))) * sc;
        wrf(0x28c74 + i * 4, r);
      }
    }
  };
  // fn_2afd3(ebx=walker, esi=camera, edi=path base, ebp=scene): camera from the spline
  HP.fn_2afd3 = function (ebx, esi, edi, ebp) {
    HP.fn_28ca4(ebx, 0xa, edi);
    wr32(esi + 0x18, rd32(0x28c74)); wr32(esi + 0x1c, rd32(0x28c78)); wr32(esi + 0x20, rd32(0x28c7c));
    wr32(esi + 0xc, rd32(0x28c80)); wr32(esi + 0x10, rd32(0x28c84)); wr32(esi + 0x14, rd32(0x28c88));
    wr32(esi, rd32(0x28c8c)); wr32(esi + 4, rd32(0x28c90)); wr32(esi + 8, rd32(0x28c94));
    wr32(ebp + 0x34, rd32(0x28c98));
  };
  // fn_2b037(ebx=walker, ecx=float bits of the speed factor): advance t, wrap keys
  HP.fn_2b037 = function (ebx, ecx) {
    wr32(ADDR.tmpF2, ecx);
    let t = rdf(ebx + 4) * rdf(ADDR.tmpF2) + rdf(ebx);
    wrf(ADDR.tmpF2, t);
    if (sign(ADDR.tmpF2)) {
      t = t + rdf(ADDR.const1);
      wr32(ebx + 8, rd32(ebx + 8) - 0x28);
      const eax = (rd32(ebx + 0xc) - 0x78) | 0;
      if (!(rds32(ebx + 8) > 0)) wr32(ebx + 8, eax);
    }
    wrf(ADDR.tmpF2, rdf(ADDR.const1) - t);
    if (sign(ADDR.tmpF2)) {
      t = t - rdf(ADDR.const1);
      wr32(ebx + 8, rd32(ebx + 8) + 0x28);
      const eax = (rd32(ebx + 0xc) - 0x78) | 0;
      if (!(rds32(ebx + 8) < eax)) wr32(ebx + 8, 0);
    }
    wrf(ebx, t);
  };
  // fn_2af3a: stir the RNG, set the particle texture level override from debug keys
  HP.fn_2af3a = function () {
    wr32(ADDR.rngS1, rd32(ADDR.rngS1) + rd32(ADDR.rngS2));
    wr32(ADDR.rngS2, (HP.rol(rd32(ADDR.rngS2), 5) + 0x12039421) >>> 0);
    wr32(0x28a10, 0xffffffff);
    if (rd8(0x9f4) === 1) wr32(0x28a10, 0);
    if (rd8(0x9f5) === 1) wr32(0x28a10, 2);
    if (rd8(0x9f6) === 1) wr32(0x28a10, 4);
    if (rd8(0x9f7) === 1) wr32(0x28a10, 8);
    if (rd8(0x9f8) === 1) wr32(0x28a10, 0x10);
    if (rd8(0x9f9) === 1) wr32(0x28a10, 0x20);
  };
  // fn_2abbc(ecx=dt, esi=camera, ebp=scene): debug free-flight camera (key flags at 0x9e5..0xa1b)
  HP.fn_2abbc = function (ecx, esi, ebp) {
    if (rd8(0xa12) === 1) wrf(ebp + 0x34, rdf(ADDR.const2) + rdf(ebp + 0x34));
    if (rd8(0xa16) === 1) wrf(ebp + 0x34, -rdf(ADDR.const2) + rdf(ebp + 0x34));
    let eax = Math.imul(ecx, 0x3e8);
    wr32(0x2ab58, 0); wr32(0x2ab5c, 0); wr32(0x2ab60, 0);
    if (rd8(0xa13) === 1) wr32(0x2ab5c, rd32(0x2ab5c) - eax);
    if (rd8(0xa15) === 1) wr32(0x2ab5c, rd32(0x2ab5c) + eax);
    if (rd8(0xa18) === 1) wr32(0x2ab58, rd32(0x2ab58) + eax);
    if (rd8(0xa10) === 1) wr32(0x2ab58, rd32(0x2ab58) - eax);
    if (rd8(0xa00) === 1) wr32(0x2ab60, rd32(0x2ab60) + eax);
    if (rd8(0x9e5) === 1) wr32(0x2ab60, rd32(0x2ab60) - eax);
    eax = ecx;
    if (rd8(0x9fe) === 1) eax = Math.imul(eax, 0xa);
    wr32(ADDR.tmpF, eax);
    const f = rds32(ADDR.tmpF);
    const move = (o, sgn) => {
      wrf(esi, sgn * (rdf(esi + o) * f) + rdf(esi));
      wrf(esi + 4, sgn * (rdf(esi + o + 0x10) * f) + rdf(esi + 4));
      wrf(esi + 8, sgn * (rdf(esi + o + 0x20) * f) + rdf(esi + 8));
    };
    if (rd8(0xa1a) === 1) move(0x24, 1);
    if (rd8(0xa1b) === 1) move(0x24, -1);
    if (rd8(0xa0f) === 1) move(0x28, 1);
    if (rd8(0xa17) === 1) move(0x28, -1);
    if (rd8(0xa11) === 1) move(0x2c, 1);
    if (rd8(0xa19) === 1) move(0x2c, -1);
    wrf(0x24fb8, rds32(0x2ab58) / rdf(ADDR.angle16Scale));
    wrf(0x24fbc, rds32(0x2ab5c) / rdf(ADDR.angle16Scale));
    wrf(0x24fc0, rds32(0x2ab60) / rdf(ADDR.angle16Scale));
    wrf(0x24fac, 0); wrf(0x24fb0, 0); wrf(0x24fb4, 0); wrf(0x24fa8, 1);
    HP.fn_24fc4(0x24d10);
    const src = [0x24, 0x28, 0x2c, 0x34, 0x38, 0x3c, 0x44, 0x48, 0x4c];
    for (let i = 0; i < 9; i++) wr32(0x2ab74 + i * 4, rd32(esi + src[i]));
    wrf(0x2aba4, -rdf(0x24d20)); wrf(0x2aba8, -rdf(0x24d24)); wrf(0x2abac, -rdf(0x24d28));
    wr32(0x2abb0, rd32(0x24d30)); wr32(0x2abb4, rd32(0x24d34)); wr32(0x2abb8, rd32(0x24d38));
    wr32(0x2ab64, esi + 0x18);
    HP.fn_24dd0(0x2ab74, 0x2aba4, rd32(0x2ab64));
    HP.fn_24dd0(0x2ab80, 0x2aba4, rd32(0x2ab64) + 4);
    HP.fn_24dd0(0x2ab8c, 0x2aba4, rd32(0x2ab64) + 8);
    HP.fn_24dd0(0x2ab74, 0x2abb0, 0x2ab68);
    HP.fn_24dd0(0x2ab80, 0x2abb0, 0x2ab6c);
    HP.fn_24dd0(0x2ab8c, 0x2abb0, 0x2ab70);
    wrf(esi + 0xc, rdf(esi) - rdf(0x2ab68));
    wrf(esi + 0x10, rdf(esi + 4) - rdf(0x2ab6c));
    wrf(esi + 0x14, rdf(esi + 8) - rdf(0x2ab70));
  };

  // ------------------------------------------------------------ text (proportional font at 0x2b484/0x2b4b8/0x2b560)
  HP.fn_2c0ac = function (ebp) {   // width of the line at ebp -> [0x2c0a8] (in bytes, *4)
    wr32(0x2c0a8, 0);
    for (;;) {
      const c = rd8(ebp);
      if (c === 0x20) { wr32(0x2c0a8, rd32(0x2c0a8) + 3); ebp++; continue; }
      if (c === 0 || c === 1) break;
      let esi = 0;
      while (rd8(0x2b484 + esi++) !== c) { /* search */ }
      wr32(0x2c0a8, rd32(0x2c0a8) + rd8(esi * 3 + 0x2b4ba) + 1);
      ebp++;
    }
    wr32(0x2c0a8, rd32(0x2c0a8) << 2);
  };
  // fn_2c100(esi=field width (0 = left aligned), edi=dest pixel ptr, ebp=string): white text with black shadow
  HP.fn_2c100 = function (esi, edi, ebp) {
    wr32(0x2c0a4, esi); wr32(0x2c0a0, edi);
    const recenter = () => {
      if (rd32(0x2c0a4) !== 0) { HP.fn_2c0ac(ebp); edi = (edi + rd32(0x2c0a4) - rd32(0x2c0a8)) | 0; }
    };
    recenter();
    for (;;) {
      const c = rd8(ebp);
      if (c === 0x20) { edi += 0xc; ebp++; continue; }
      if (c === 0) return;
      if (c === 1) { wr32(0x2c0a0, rd32(0x2c0a0) + 0x2800); edi = rd32(0x2c0a0); ebp++; recenter(); continue; }
      let idx = 0;
      while (rd8(0x2b484 + idx++) !== c) { /* search */ }
      const rows = rd8(0x2b4ba), w = rd8(idx * 3 + 0x2b4ba);
      let src = rd16(idx * 3 + 0x2b4b8);
      const edx = 0x140 - w;
      let d = edi;
      for (let r = rows; r > 0; r--) {
        for (let x = w; x > 0; x--) {
          if (rd8(src + 0x2b560) !== 0) { wr32(d, 0xffffff); wr32(d + 0x504, 0); }
          src++; d += 4;
        }
        src += edx; d += edx * 4;
      }
      edi += (w + 1) * 4;
      ebp++;
    }
  };
  // fn_2c1c7(eax=number, edi=buffer): 9 spaces then decimal digits right-aligned at edi+9 (writes backwards)
  HP.fn_2c1c7 = function (eax, edi) {
    HP.fill8(edi, 0x20, 9); edi += 9;
    eax >>>= 0;
    do { const d = eax % 10; eax = (eax / 10) >>> 0; wr8(edi, 0x30 + d); edi--; } while (eax !== 0);
  };
  HP.fn_2b461 = function (eax, esi, edi) {
    edi += esi << 2;
    HP.fn_2c1c7(eax, 0x2b44a);
    HP.fn_2c100(0x158, edi, 0x2b44a);
  };
  // fn_2b2b7(ecx=fps, edi=buffer, ebp=scene): debug statistics overlay
  HP.fn_2b2b7 = function (ecx, edi, ebp) {
    edi += 0x6410;
    HP.fn_2c100(0, edi, 0x2b147);
    const nums = [[0x60, 0x1e00], [0x64, 0x2800], [0x38, 0x3200], [0x3c, 0x3c00], [0x40, 0x4600], [0x68, 0x5000], [0x44, 0x6e00], [0x4c, 0x7800], [0x48, 0x8200], [0x50, 0x8c00], [0x54, 0x9600], [0x58, 0xa000]];
    for (const [o, y] of nums) HP.fn_2b461(rd32(ebp + o), y, edi);
    HP.fn_2c100(0x158, edi + 0x2f800, rd32(0x2c540) * 0xb + 0x2b25c);
    if (rd32(0x2c538) !== 0xffffffff) HP.fn_2c100(0, edi + 0x2e558, 0x2b2a9);
    if (rd32(0x2c548) !== 0) HP.fn_2c100(0, edi + 0x30d58, 0x2b2ae);
    HP.fn_2b461(rd32(0x2b446), 0xc800, edi);
    HP.fn_2b461(rd32(0x28e54), 0xd200, edi);
    HP.fn_2b461((rd32(0x28e54) - himemFree()) >>> 0, 0xdc00, edi);
    HP.fn_2b461(rd32(0x28e58), 0xe600, edi);
    const d = edi + 0x3c000;
    HP.fn_2c1c7(ecx, 0x2b455);
    const al = rd8(0x2b45e); wr8(0x2b45e, 0x2e); wr8(0x2b45f, al);
    HP.fn_2c100(0x158, d, 0x2b455);
  };
  // fn_2b0a8(esi=buffer, ebp=scene): present a frame
  HP.fn_2b0a8 = function (esi, ebp) {
    wr32(ADDR.tmpF, esi);
    if (rd8(ADDR.keyFps) === 1) {
      wr32(0x28e30, rd32(0x28e30) + rd32(ADDR.timerMs));
      wr32(0x28e2c, rd32(0x28e2c) + 1);
      if (rds32(0x28e2c) >= 3) {
        if (rd32(0x28e30) !== 0) {
          wr32(0x28e44, 0x7530);
          const v = rne(30000 / rds32(0x28e30)) | 0;
          wr32(0x28e44, v); wr32(0x28e34, v);
          wr32(0x28e2c, 0); wr32(0x28e30, 0);
        }
      }
      HP.fn_2b2b7(rd32(0x28e34), esi, ebp);
    }
    HP.fn_2c9f4(rd32(ADDR.tmpF));
    wr32(ADDR.frameMs, rd32(ADDR.timerMs));
    wr32(ADDR.timerMs, 0);
  };

  // ------------------------------------------------------------ video layer
  // State after the original's init on our reference machine (VESA 2.0, 320x240x32 LFB, double buffered):
  // bytes for offsets 0x2c52c..0x2c660 (ModeInfoBlock at 0x2c54c, mode vars) and the VBE info block at 0x2c300.
  const VIDEO_STATE_HEX = '000000000000000090f0fe0390f008000000000090f0fe03010000009b0007074000400000a000a00000000000054001f000081001200106000c010810080808000818000000000400000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000004001f000200100001341';
  const VBE_BLOCK_HEX = '5645534100028000273d000000000001273d4000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000756e69636f726e2076657361' + '00'.repeat(0x100 - 0x8c) + '130112011300ffff' + '00'.repeat(0x200 - 0x108);
  function writeHex(off, hex) { for (let i = 0; i < hex.length; i += 2) HP.M[off + (i >> 1)] = parseInt(hex.substr(i, 2), 16); }
  HP.LFB_OFFSET = 0x3fef090;        // LFB linear 0x04000000 minus the segment base (not inside M)
  // fn_2c2a7(edx=offset): real-mode pointer (es:di) of a segment offset into the v86 register block
  HP.fn_2c2a7 = function (edx) {
    const lin = (edx + rd32(0x18)) >>> 0;
    wr16(0xce, (lin >>> 4) & 0xffff); wr16(0xac, lin & 0xf);
  };
  HP.fn_2c500 = function () {   // VBE presence check (4F00): leaves the info block at 0x2c300
    HP.fn_2c2a7(0x2c300);
    wr16(0xc8, 0x4f00);
    writeHex(0x2c300, VBE_BLOCK_HEX);
    wr32(0xc8, 0x4f);            // returned AX
  };
  HP.fn_2c845 = function () {   // video init: select 320x240x32 LFB (mode type 0), set mode
    wr8(0x2c844, 0);
    // (command-line "-vN" parsing: the PSP is not part of M; the port has no parameter)
    writeHex(0x2c530, VIDEO_STATE_HEX);          // block captured from 0x2c530 (mode vars + ModeInfoBlock at 0x2c54c)
    wr32(0x2c538, HP.LFB_OFFSET); wr32(0x2c544, HP.LFB_OFFSET); wr32(0x2c548, 1);
    wr16(0x2c652, 0);
    // v86 registers as left by the last int 33h (4F02 set mode)
    wr16(0xc8, 0x4f02); wr16(0xbc, 0x4113); wr32(0xc8, 0x4f);
    HP.videoModeSet = true;
  };
  HP.fn_2c77e = function () {   // set the selected mode (mode 13h or VBE)
    HP.fn_2c845();
  };
  HP.videoOut = null;           // host hook: videoOut(srcOffset, page) copies 320x240 dwords from M[src] to the screen
  HP.fn_2ca61 = function (esi) {
    const type = rd32(0x2c540);
    if (type !== 0) throw new Error('video mode type ' + type + ' not supported by the port');
    if (HP.videoOut) HP.videoOut(esi, rd16(0x2c652));
  };
  HP.fn_2cd68 = function () { /* vsync wait */ };
  HP.fn_2ccf3 = function (dx) {   // VBE 4F07 set display start (y = dx)
    wr16(0xc8, 0x4f07); wr8(0xbd, 0); wr8(0xbc, 0); wr16(0xc4, 0); wr16(0xc0, dx & 0xffff);
    wr32(0xc8, 0x4f);
  };
  HP.fn_2cd1f = function (edx) {  // VBE 4F05 bank switch
    wr16(0xc8, 0x4f05); wr16(0xbc, 0);
    wr16(0xc0, (edx << rd16(0x2c550)) & 0xffff);
    wr32(0xc8, 0x4f);
  };
  HP.fn_2cd46 = function () {     // back to text mode
    wr16(0xc8, 3); wr32(0xc8, 0x4f);   // (values left by int 10h are irrelevant)
    wr16(0xc8, 0x1112); wr8(0xbc, 0);
    if (HP.videoTextMode) HP.videoTextMode();
  };
  HP.fn_2c9f4 = function (esi) {  // present buffer esi
    if (rd32(0x2c548) !== 0) {
      const dx = (rd16(0x2c560) + 1 - rd16(0x2c652)) & 0xffff;
      wr16(0x2c652, dx);
      const bytes = (rd8(0x2c565) + 1) >>> 3;
      const ecx = (Math.imul(Math.imul(rd16(0x2c55e), dx), bytes) + rd32(0x2c544)) >>> 0;
      wr32(0x2c538, ecx);
      HP.fn_2ca61(esi);
      HP.fn_2cd68();
      HP.fn_2ccf3(dx);
    } else {
      HP.fn_2cd68();
      HP.fn_2ca61(esi);
    }
  };
  // fn_2c1e6(eax=offset of a '$'-terminated string): DOS print
  HP.fn_2c1e6 = function (eax) {
    wr8(0xc9, 9);
    const lin = (eax + rd32(0x18)) >>> 0;
    wr16(0xd0, (lin >>> 4) & 0xffff); wr16(0xc0, lin & 0xf);
    let s = '';
    for (let p = eax; HP.M[p] !== 0x24 && s.length < 400; p++) s += String.fromCharCode(HP.M[p]);
    if (HP.dosPrint) HP.dosPrint(s);
  };
  HP.dosPrint = (s) => { if (typeof console !== 'undefined') console.log('[DOS] ' + JSON.stringify(s)); };
})();
