// hplus port — effect D (0x1cbb4..0x1dcaf): ray-cast textured cylinder ("tunnel") sampled on a 41x31 grid,
// 8x8 interpolated fill through a 256x256 shade/texel colour LUT, a flat-shaded object (0x1bcdc) and a
// 2000-particle object (0x1c1f4, rendered into the 41x31 sample grid to darken the rays), zoom/cross-fade
// transitions and music-triggered fades.  Init fn_1d39f, run fn_1d566(eax) (generator).
// External functions used (HP.fn_xxxxx, args in eax,ebx,ecx,edx,esi,edi,ebp order):
//   core:   fn_29a(eax=size)->ptr, fn_2c2c8(eax=range)->rnd
//   engine: fn_2432c(edx=0x1bc80, ebp=obj)            build/load object (init)
//           fn_2a094(ecx, ebp=obj), fn_28ed8(eax=1, ebp=obj)   object setup
//           fn_2afd3(ebx=0x1c770 angles, esi=0x1c70c cam, edi=path, ebp=obj)   camera/path
//           fn_2a2ac(esi=0x1c70c cam, edi=dest buffer, ebp=obj)                 render object
//           fn_2af3a(), fn_2b037(ebx=0x1c770 angles, ecx=[0x1bcd0] matrix)
//           fn_2b0a8(esi=buffer, ebp=obj)                                      present
//   part A: fn_1574e(ebp=brightness 0..0x400, edi=buffer)      part B: fn_18135(ecx, edx, edi=buffer)
//   part F range: fn_23f8c(eax=float bits)->ecx float bits (table inverse sqrt; table [0x23f30] built by fn_23f34)
//   player state via [0xe20] (+0x30 order, +0x34 row).  Keyboard flags [0x9c9] (ESC), [0xa01] (pause).
import { HP } from './hplus_core.js';
import { ADDR } from './hplus_addr.js';

// functions this file calls from elsewhere (forwarding, so the HP entry stays late-bound
// and tools/replay.js can still swap it at runtime)
const alloc            = (...a) => HP.fn_29a(...a);     // core: fn_29a — high memory
const rand             = (...a) => HP.fn_2c2c8(...a);   // core: fn_2c2c8 — eax = range
const cameraFromSpline = (...a) => HP.fn_2afd3(...a);   // engine: fn_2afd3 — (ebx=walker, esi=camera, edi=path base, ebp=scene)
const objectInit       = (...a) => HP.fn_2a094(...a);   // engine: fn_2a094
const present          = (...a) => HP.fn_2b0a8(...a);   // engine: fn_2b0a8
const renderObject     = (...a) => HP.fn_2a2ac(...a);   // engine: fn_2a2ac — (esi=camera, ebp=object, edi=dest buffer)
const splineAdvance    = (...a) => HP.fn_2b037(...a);   // engine: fn_2b037 — (ebx=walker, ecx=speed factor bits): advance t, wrap keys
const stirRng          = (...a) => HP.fn_2af3a(...a);   // engine: fn_2af3a — stir the RNG + particle texture level override
const blueSmear        = (...a) => HP.fn_18135(...a);   // fxB: fn_18135 — horizontal smear of the blue byte of a 320x240x32 buffer

// this part's own globals (0x1bc90..0x1cb40)
const PART = Object.freeze({
  fade     : 0x1bc90,       // global fade
  zoomFlag : 0x1bc9c,
  zoom     : 0x1bca0,
  crossFade: 0x1bca4,       // swaps frameBuf <-> frameBuf2
  frameBuf : 0x1bcbc,       // the sphere mesh is rendered here
  frameBuf2: 0x1bcc8,
  texDirty : 0x1bccc,       // texture-dirty flag
  tmpI     : 0x1bcd8,       // int spill slot: the original stored here; the port keeps the store so memory snapshots match
});

const { rd8, rd16, rd32, rds32, wr8, wr16, wr32, rdf, wrf, roundHalfEven } = HP;
// fistp dword: round half to even, x87 indefinite (0x80000000) when out of range / NaN
const fistp = v => (v !== v || v >= 2147483648 || v < -2147483648) ? -2147483648 : (roundHalfEven(v) | 0);
const signbit = a => (rd32(a) & 0x80000000) !== 0;   // test dword [a], 0x80000000 on a stored float32

// fn_23f8c(eax=float bits) -> ecx: 1/sqrt(x) via the 0x2000-entry table at [0x23f30] (fn_23f34 builds it).
// (Lives in part F's range; defined here only if nobody else did.)
if (!HP.fn_23f8c) HP.fn_23f8c = function (eax) {
  let ecx = (0x5f000000 - ((eax >>> 1) & 0x3fc00000)) >>> 0;
  const idx = (eax >>> 9) & 0x7ffc;
  ecx = (ecx & 0xff800000) >>> 0;
  return (ecx | rd32(idx + rd32(0x23f30))) >>> 0;
};

// fn_1cbb4(esi=0): ray/cylinder intersection for the ray (dir = [0x1cac4..0x1cacc], origin [0x1cadc..0x1cae4]).
// Out: [0x1cb08],[0x1cb0c] (texture u,v 16.16), [0x1cb10] (distance 16.16; 0x1000000 on miss).
HP.fn_1cbb4 = function (esi) {
  wrf(0x1cab0, rdf(0x1cad0) + rdf(0x1cad4));
  wrf(0x1cab4, ((rdf(0x1cadc) - rdf(esi + 0x1cb88)) * rdf(0x1cac4) + (rdf(0x1cae0) - rdf(esi + 0x1cb8c)) * rdf(0x1cac8)) * rdf(0x1cb24));
  {
    const s1 = rdf(esi + 0x1cb94) + rdf(esi + 0x1cb98) + rdf(0x1cae8) + rdf(0x1caec);
    const p = (rdf(0x1cadc) * rdf(esi + 0x1cb88) + rdf(0x1cae0) * rdf(esi + 0x1cb8c)) * rdf(0x1cb28);
    wrf(0x1cab8, (s1 + p) - rdf(esi + 0x1cba0));
  }
  {
    const B = rdf(0x1cab4);
    wrf(0x1cabc, B * B - rdf(0x1cab0) * rdf(0x1cab8) * rdf(0x1cb2c));
  }
  if (signbit(0x1cabc)) { wr32(0x1cb10, 0x1000000); return; }
  wr32(0x1cabc, HP.fn_23f8c(rd32(0x1cabc)));
  const isq = rdf(0x1cabc);
  const num = -(isq * rdf(0x1cab4)) + rdf(esi + 0x1cba4);
  const den = isq * rdf(0x1cab0) * rdf(0x1cb24);
  const t = num / den;                       // extended-precision t ...
  wrf(0x1cac0, t);                           // ... stored as float32 (fst)
  wr32(0x1cb10, fistp(t * rdf(esi + 0x1cbb0) * rdf(0x1cb3c)));
  const tf = rdf(0x1cac0);
  wr32(0x1cb08, fistp((rdf(0x1cac4) * tf + rdf(0x1cadc)) * rdf(esi + 0x1cbac) * rdf(0x1cb3c)));
  wr32(0x1cb0c, fistp((rdf(0x1cacc) * tf + rdf(0x1cae4)) * rdf(esi + 0x1cbac) * rdf(0x1cb3c)));
};

// fn_1d039(esi=camera block, ebx=dest): rotate the vector ([0x1cac4],[0x1cac8],[0x1cacc]) by the 3x3 matrix at esi+0x24
HP.fn_1d039 = function (esi, ebx) {
  const a = rdf(0x1cac4), b = rdf(0x1cac8), c = rdf(0x1cacc);
  wrf(ebx, a * rdf(esi + 0x24) + (b * rdf(esi + 0x28) + c * rdf(esi + 0x2c)));
  wrf(ebx + 4, a * rdf(esi + 0x34) + (b * rdf(esi + 0x38) + c * rdf(esi + 0x3c)));
  wrf(ebx + 8, a * rdf(esi + 0x44) + (b * rdf(esi + 0x48) + c * rdf(esi + 0x4c)));
};

// fn_1cd19(esi=camera block 0x1c70c, ebp=object 0x1bcdc): cast the ray grid, fill [0x1ca6c] with (u,v,z) per sample
HP.fn_1cd19 = function (esi, ebp) {
  let edi = rd32(0x1ca6c);
  const k = rdf(0x1cb20);
  wr32(0x1cb00, fistp(rdf(ebp + 0x18) * k));
  wr32(0x1cafc, fistp(rdf(ebp + 0x10) * k));
  {
    const x = (rdf(ebp + 0x1c) - rdf(ebp + 0x18)) * k + rdf(0x1bcd0);
    wr32(0x1cb00, fistp(x)); wrf(0x1caf8, 1 / x);
    const y = (rdf(ebp + 0x14) - rdf(ebp + 0x10)) * k + rdf(0x1bcd0);
    wr32(0x1cafc, fistp(y)); wrf(0x1caf4, 1 / y);
  }
  wr32(0x1cb04, Math.imul(0x29 - rds32(0x1cafc), 0xc));
  {
    const x = rdf(esi), y = rdf(esi + 4), z = rdf(esi + 8);
    wrf(0x1cadc, x); wrf(0x1cae0, y); wrf(0x1cae4, z);
    wrf(0x1caec, y * y); wrf(0x1caf0, z * z); wrf(0x1cae8, x * x);
  }
  wrf(0x1cb30, (rdf(ebp + 0x14) - rdf(ebp + 0x10)) / rdf(0x1cb24) / rdf(ebp + 0x34) * rdf(0x1cb38));
  wrf(0x1cb34, (rdf(ebp + 0x1c) - rdf(ebp + 0x18)) / rdf(0x1cb24) / rdf(ebp + 0xc) / rdf(ebp + 0x34) * rdf(0x1cb38));
  wr32(0x1cacc, rd32(0x1cb38));
  wrf(0x1cac4, 0 - rdf(0x1cb30)); wrf(0x1cac8, 0 - rdf(0x1cb34)); HP.fn_1d039(esi, 0x1ca70);
  wrf(0x1cac4, 0 + rdf(0x1cb30)); wrf(0x1cac8, 0 - rdf(0x1cb34)); HP.fn_1d039(esi, 0x1ca7c);
  wrf(0x1cac4, 0 - rdf(0x1cb30)); wrf(0x1cac8, 0 + rdf(0x1cb34)); HP.fn_1d039(esi, 0x1ca88);
  wrf(0x1cac4, 0 + rdf(0x1cb30)); wrf(0x1cac8, 0 + rdf(0x1cb34)); HP.fn_1d039(esi, 0x1ca94);
  wrf(0x1caa0, (rdf(0x1ca7c) - rdf(0x1ca70)) * rdf(0x1caf4));
  wrf(0x1caa4, (rdf(0x1ca80) - rdf(0x1ca74)) * rdf(0x1caf4));
  wrf(0x1caa8, (rdf(0x1ca84) - rdf(0x1ca78)) * rdf(0x1caf4));
  wrf(0x1caac, 0);
  let edx = rds32(0x1cb00);
  do {
    const fr = rdf(0x1caac);
    wrf(0x1cac4, (rdf(0x1ca88) - rdf(0x1ca70)) * fr + rdf(0x1ca70));
    wrf(0x1cac8, (rdf(0x1ca8c) - rdf(0x1ca74)) * fr + rdf(0x1ca74));
    wrf(0x1cacc, (rdf(0x1ca90) - rdf(0x1ca78)) * fr + rdf(0x1ca78));
    let cnt = rds32(0x1cafc);
    do {
      const a = rdf(0x1cac4), b = rdf(0x1cac8), c = rdf(0x1cacc);
      wrf(0x1cad4, b * b); wrf(0x1cad8, c * c); wrf(0x1cad0, a * a);
      HP.fn_1cbb4(0);
      let ecx = rds32(0x1cb10);
      if (ecx <= 0x20000) ecx = 0x20000;
      if (ecx >= 0xfe0000) ecx = 0xfe0000;
      ecx = (0xff0000 - ecx) | 0;
      wr32(edi, rd32(0x1cb08)); wr32(edi + 4, rd32(0x1cb0c)); wr32(edi + 8, ecx);
      edi += 0xc;
      wrf(0x1cac8, b + rdf(0x1caa4)); wrf(0x1cacc, c + rdf(0x1caa8)); wrf(0x1cac4, a + rdf(0x1caa0));
    } while (--cnt !== 0);
    wrf(0x1caac, rdf(0x1caac) + rdf(0x1caf8));
    edi += rds32(0x1cb04);
  } while (--edx !== 0);
};

// fn_1d09f(eax=colour LUT (256x256 dwords [shade][texel]), ebp=texture (256x256 bytes), esi=ray buffer, edi=frame buffer):
// 8x8 bilinear fill of the 40x30 cells (u,v,z in 16.16, z>>16 = shade)
HP.fn_1d09f = function (eax, ebp, esi, edi) {
  const M = HP.M;
  wr32(0x1cb1c, eax); wr32(0x1cb18, ebp);
  const texBase = ebp, lutBase = eax;            // self-modifying code: patches [0x1d1fa], [0x1d209]
  edi -= 4;
  wr32(0x1cb44, 0x1e);
  do {
    wr32(0x1cb40, 0x28);
    do {
      if (((rd32(esi + 8) + rd32(esi + 0x14) + rd32(esi + 0x1f4) + rd32(esi + 0x200)) | 0) !== 0) {
        let l0 = rds32(esi), l1 = rds32(esi + 4), l2 = rds32(esi + 8);
        const dl0 = (rds32(esi + 0x1ec) - l0) >> 3, dl1 = (rds32(esi + 0x1f0) - l1) >> 3, dl2 = (rds32(esi + 0x1f4) - l2) >> 3;
        let r0 = rds32(esi + 0xc), r1 = rds32(esi + 0x10), r2 = rds32(esi + 0x14);
        const dr0 = (rds32(esi + 0x1f8) - r0) >> 3, dr1 = (rds32(esi + 0x1fc) - r1) >> 3, dr2 = (rds32(esi + 0x200) - r2) >> 3;
        wr32(0x1cb48, l0); wr32(0x1cb4c, l1); wr32(0x1cb50, l2); wr32(0x1cb64, dl0); wr32(0x1cb68, dl1); wr32(0x1cb6c, dl2);
        wr32(0x1cb54, r0); wr32(0x1cb58, r1); wr32(0x1cb5c, r2); wr32(0x1cb70, dr0); wr32(0x1cb74, dr1); wr32(0x1cb78, dr2);
        wr32(0x1cb60, 8);
        for (let row = 8; row > 0; row--) {
          const s0 = (r0 - l0) >> 11, s1 = (r1 - l1) >> 11, s2 = (r2 - l2) >> 11;
          wr32(0x1cb7c, s0); wr32(0x1cb80, s1); wr32(0x1cb84, s2);
          let ecx = l0 >> 8, si = l1 >> 8, edx = l2 >> 8;
          for (let n = 8; n > 0; n--) {
            let ax = ((si & 0xff00) | ((ecx >>> 8) & 0xff)) & 0xffff;
            edi += 4;
            ecx = (ecx + s0) | 0; si = (si + s1) | 0;
            ax = (ax & 0xff00) | M[(texBase + ax) >>> 0];
            ax = ((edx >>> 8) & 0xff) << 8 | (ax & 0xff);
            edx = (edx + s2) | 0;
            const px = rd32(lutBase + ax * 4);
            wr32(edi, px);
          }
          l0 = (l0 + dl0) | 0; l1 = (l1 + dl1) | 0; l2 = (l2 + dl2) | 0;
          r0 = (r0 + dr0) | 0; r1 = (r1 + dr1) | 0; r2 = (r2 + dr2) | 0;
          wr32(0x1cb48, l0); wr32(0x1cb4c, l1); wr32(0x1cb50, l2); wr32(0x1cb54, r0); wr32(0x1cb58, r1); wr32(0x1cb5c, r2);
          edi += 0x4e0;
          wr32(0x1cb60, row - 1);
        }
        edi -= 0x2800;
      }
      edi += 0x20; esi += 0xc;
      wr32(0x1cb40, rds32(0x1cb40) - 1);
    } while (rds32(0x1cb40) !== 0);
    edi += 0x2300; esi += 0xc;
    wr32(0x1cb44, rds32(0x1cb44) - 1);
  } while (rds32(0x1cb44) !== 0);
};

// fn_1d2bd(ebp, esi, edi) -> edi: randomize 0x55 particle records (0x2c bytes) at edi
HP.fn_1d2bd = function (ebp, esi, edi) {
  for (let c = 0x55; c > 0; c--) {
    let eax = (rand(0x190) - 0x1770) | 0; wr32(PART.tmpI, eax); wrf(edi + 0xc, eax);
    eax = (rand(0x28) + ebp) | 0; wr32(PART.tmpI, eax); wrf(edi + 4, eax);
    eax = (rand(0x28) + esi) | 0; wr32(PART.tmpI, eax); wrf(edi + 8, eax);
    wr32(PART.tmpI, -0x1e); wrf(edi + 0x20, -30);
    edi += 0x2c;
  }
  return edi;
};
// fn_1d35c(ebp=0xc, edi=records): move 0xff records along axis ebp (table 0x1d330[8]); wrap when past [0x1d354]
HP.fn_1d35c = function (ebp, edi) {
  let ia = 0;
  for (let c = 0xff; c > 0; c--) {
    const st = rdf(ia * 4 + 0x1d330);
    let v = rdf(edi + ebp) + st;
    wrf(0x1d350, v - rdf(0x1d354));
    if (!signbit(0x1d350)) v = v + rdf(0x1d358);
    wrf(edi + ebp, v);
    ia = (ia + 1) & 7;
    edi += 0x2c;
  }
};

// fn_1d39f: part D precalc
HP.fn_1d39f = function () {
  let eax = alloc(0xb73dc); eax = ((eax | 0xffff) + 1) >>> 0;
  wr32(PART.frameBuf, eax); eax += 0x4b000; wr32(PART.frameBuf2, eax); eax += 0x4b000; wr32(0x1bcc0, eax);
  eax += 0x13dc; wr32(0x1bcc4, eax); eax += 0x10000;
  HP.fill32(rd32(PART.frameBuf), 0, 0x96000);        // (overruns the allocation, as the original does)
  wr32(0x1bd04, 1); wr32(0x1bd08, 0x18); wr32(0x1bd09, 0x18); wr32(0x1bd0a, 0x25);
  HP.fn_2432c(0x1bc80, 0x1bcdc);                // (edx, ebp)
  objectInit(0xff, 0x1bcdc);                   // (ecx, ebp)
  objectInit(0x7d0, 0x1c1f4);
  let ebp = rd32(0x1c708);
  for (let edx = 0x7d0; edx > 0; edx--) {
    eax = (rand(0x320) - 0x190) | 0; wr32(0x1cb40, eax); wrf(ebp + 4, eax);
    eax = (rand(0x320) - 0x190) | 0; wr32(0x1cb40, eax); wrf(ebp + 8, eax);
    eax = (rand(0x1770) - 0xbb8) | 0; wr32(0x1cb40, eax); wrf(ebp + 0xc, eax);
    wr32(0x1cb40, -0x3c); wrf(ebp + 0x20, -60);
    ebp += 0x2c;
  }
  HP.fn_28ed8(1, 0x1bcdc); HP.fn_28ed8(1, 0x1c1f4);   // (eax, ebp)
  wr32(PART.tmpI, 0x29); wrf(0x1c1f8, 41); wrf(0x1c208, 41);
  wr32(PART.tmpI, 0x1f); wrf(0x1c1fc, 31); wrf(0x1c210, 31);
  eax = alloc(0x3ba4); eax = (eax | 0xf) + 1; wr32(0x1ca6c, eax);
  let edi = rd32(0x1c1f0);
  edi = HP.fn_1d2bd(0x2b, 0x56, edi);
  edi = HP.fn_1d2bd(-0x7f, -0x20, edi);
  edi = HP.fn_1d2bd(0x4b, -0x70, edi);
  HP.copy(rd32(0x1bcc4), rd32(0x1c13c), 0x4000 * 4);
};

// zoom helper used twice: rows [0x1bcd8]=0xf0; per row esi = src + (edx>>16)*0x500, then 320 px from esi[(ecx>>16)]
function zoomCopy(dst, src, step, blend) {
  const M = HP.M;
  let edi = dst - 4, edx = rds32(0x1bcac);
  wr32(PART.tmpI, 0xf0);
  do {
    let esi = ((((edx >>> 16) * 5) << 8) + src) | 0;
    edx = (edx + step) | 0;
    let ecx = rds32(0x1bca8);
    for (let n = 0x140; n > 0; n--) {
      edi += 4;
      let eax = rd32(esi + (ecx >>> 16) * 4);
      ecx = (ecx + step) | 0;
      if (blend) {
        const ebx = rd32(edi) & 0xfefefe;
        eax = (((eax & 0xfefefe) + ebx) >>> 1);
      }
      wr32(edi, eax);
    }
    wr32(PART.tmpI, rds32(PART.tmpI) - 1);
  } while (rds32(PART.tmpI) !== 0);
}

// fn_1dab0: one update step (called 3x per frame)
HP.fn_1dab0 = function () {
  if (rd8(ADDR.keyPause) === 1) return;
  stirRng();
  let esi = rd32(ADDR.playerState);
  if (rds32(esi + 0x30) === 0x14 && rds32(esi + 0x34) === 0xe) {
    let v = rdf(0x1c770) - rdf(0x1c7f4);
    wrf(PART.tmpI, v);
    if (signbit(0x1bcd8)) {
      v = v + 1;
      wr32(0x1c778, rds32(0x1c778) - 0x28);
      if (rds32(0x1c778) <= 0) wr32(0x1c778, 0);
    }
    wrf(0x1c770, v);
  } else wr32(0x1c7f8, 0);
  splineAdvance(0x1c770, rd32(0x1bcd0));          // (ebx=angles, ecx=matrix)
  HP.fn_1d35c(0xc, rd32(0x1c1f0));
  esi = rd32(ADDR.playerState);
  const eax = rd32(esi + 0x30);
  if (eax !== rd32(0x1c7bc)) {
    wr32(0x1c7bc, eax);
    wr32(0x1c7b8, rd32(0x1c7b8) + 1);
    const ebx = rd32(0x1c7b8) & 3;
    if (rd32(ebx * 4 + 0x1c7e0) !== rd32(ebx * 4 + 0x1c7dc)) {
      const s = rd32(0x1c7b8) & 3;
      wr32(0x1c774, rd32(s * 4 + 0x1c7d0)); wr32(0x1c77c, rd32(s * 4 + 0x1c7c0));
      wr32(0x1c778, 0); wrf(0x1c770, 0);
      if (rds32(0x1c7b8) === 3) wr32(0x1c778, 0x50);
    }
  }
  esi = rd32(ADDR.playerState);
  if (rds32(esi + 0x30) === 0x14 && rds32(esi + 0x34) === 0x3a) {
    if (rds32(0x1bc94) !== 1) {
      wr32(0x1bc94, 1);
      wr32(PART.fade, rds32(PART.fade) - 0x40);
      if (rds32(PART.fade) <= 0) wr32(PART.fade, 0);
      wr32(PART.crossFade, rds32(PART.crossFade) - 0x2ee0);
      if (rds32(PART.crossFade) <= 0x64) wr32(PART.crossFade, 0x64);
    }
  } else wr32(0x1bc94, 0);
  if (rds32(PART.zoomFlag) === 1) {
    wr32(PART.zoom, rds32(PART.zoom) - 0x3e8);
    if (rds32(PART.zoom) <= 0x3e8) wr32(PART.zoom, 0x3e8);
  }
  if (rds32(PART.zoomFlag) === 2) {
    wr32(PART.zoom, rds32(PART.zoom) + 0x3e8);
    if (rds32(PART.zoom) >= 0x10000) wr32(PART.zoom, 0x10000);
  }
  wrf(0x1c79c, rdf(0x1c79c) + rdf(0x1c7a8));
  wrf(0x1c7a0, rdf(0x1c7a0) + rdf(0x1c7ac));
  wrf(0x1c7a4, rdf(0x1c7a4) + rdf(0x1c7b0));
};

// ---- fn_1d566(eax): run part D until song order reaches (start order + eax) or ESC.
// Split into init / render (loop top .. present) / post (after present .. loop end) for testability.
HP.fxD_init = function (eax) {
  wr32(0x1bcb0, eax);
  wr32(0x1cba8, 0x1cbb4);
  const esi = rd32(ADDR.playerState);
  const startOrder = rd32(esi + 0x30);
  wr32(0x1c7bc, startOrder); wr32(0x1bcb4, startOrder);
  wr32(0x1c7b8, 0);
  wr32(0x1c774, rd32(0x1c7d0)); wr32(0x1c77c, rd32(0x1c7c0)); wr32(0x1c778, 0); wrf(0x1c770, 0);
  wr32(ADDR.timerMs, 0);
  wr32(PART.zoomFlag, 0); wr32(PART.zoom, 0x10000);
  HP.fill32(rd32(PART.frameBuf), rd32(rd32(0x1c140)), 0x12c00);
};
HP.fxD_render = function () {
  const M = HP.M;
  const path = rd32((rd32(0x1c7b8) & 3) * 4 + 0x1c7e0);
  wr32(0x28c9c, 1);
  cameraFromSpline(0x1c770, 0x1c70c, path, 0x1bcdc);     // (ebx, esi, edi, ebp)
  const s44 = rd32(0x1bd44), s3c = rd32(0x1bd3c);
  wr32(0x1bd44, 0); wr32(0x1bd3c, 0);
  renderObject(0x1c70c, 0x1bcdc, rd32(PART.frameBuf));      // (esi, ebp, edi) — engine signature order
  wr32(0x1bd3c, s3c); wr32(0x1bd44, s44);
  HP.fn_1cd19(0x1c70c, 0x1bcdc);
  wr32(PART.tmpI, 8); wrf(0x1c228, rdf(0x1bd10) / 8);
  HP.fill32(rd32(0x1bcc0), 0, 0x4f7);
  renderObject(0x1c70c, 0x1c1f4, rd32(0x1bcc0));
  {
    let src = rd32(0x1bcc0), edi = rd32(0x1ca6c);
    for (let n = 0x4f7; n > 0; n--) {
      let v = (rds32(edi + 8) - (M[src] << 15)) | 0;
      if (v <= 0x20000) v = 0x20000;
      wr32(edi + 8, v);
      edi += 0xc; src += 4;
    }
  }
  HP.fn_1d09f(rd32(0x1c140), rd32(0x1c13c), rd32(0x1ca6c), rd32(PART.frameBuf));   // (eax, ebp, esi, edi)
  renderObject(0x1c70c, 0x1bcdc, rd32(PART.frameBuf));
  wr16(0xbc, rd16(0x1ca68));
  let esi = rd32(ADDR.playerState);
  if (rds32(esi + 0x30) === 0x13 && rds32(esi + 0x34) >= 0x24) {
    wr32(PART.zoomFlag, 1);
    if (rds32(esi + 0x34) >= 0x28) wr32(PART.zoomFlag, 2);
    if (rds32(PART.zoom) !== 0x10000) {
      const e = (0x10000 - rds32(PART.zoom)) | 0;
      wr32(0x1bcac, Math.imul(e, 0x78)); wr32(0x1bca8, Math.imul(e, 0xa0));
      zoomCopy(rd32(PART.frameBuf), rd32(PART.frameBuf2), rds32(PART.zoom), true);
    }
  }
  esi = rd32(ADDR.playerState);
  if (rds32(esi + 0x30) === 0x14 && rds32(esi + 0x34) >= 0x34 && rds32(esi + 0x34) <= 0x38) {
    let v = Math.sin(rdf(0x1c79c) * rdf(0x1c7b4)) * Math.sin(rdf(0x1c7a4) * rdf(0x1c7b4));
    v = v * rdf(0x1c794) + rdf(0x1c798);
    wr32(0x1c78c, fistp(v));
    if (rds32(0x1c78c) >= 0xff) wr32(0x1c78c, 0xff);
    if (rds32(0x1c78c) <= 0) wr32(0x1c78c, 0);
    const old = rds32(0x1c78c);
    wr32(0x1c78c, 0xff - old); wr32(0x1c790, old);
    blueSmear(rd32(0x1c790), rd32(0x1c78c), rd32(PART.frameBuf));   // (ecx, edx, edi)
  }
  if (rds32(PART.crossFade) !== 0x10000) {
    const e = (0x10000 - rds32(PART.crossFade)) | 0;
    wr32(0x1bcac, Math.imul(e, 0x78)); wr32(0x1bca8, Math.imul(e, 0xa0));
    zoomCopy(rd32(PART.frameBuf2), rd32(PART.frameBuf), rds32(PART.crossFade), false);
    const t = rd32(PART.frameBuf); wr32(PART.frameBuf, rd32(PART.frameBuf2)); wr32(PART.frameBuf2, t);
  }
  if (rds32(PART.fade) !== 0x400) HP.fn_1574e(rds32(PART.fade), rd32(PART.frameBuf));
  esi = rd32(ADDR.playerState);
  if (rds32(0x1bc98) !== 1 && rds32(esi + 0x30) === 0x14 && rds32(esi + 0x34) === 0x1c) { wr32(PART.fade, 0x200); wr32(0x1bc98, 1); }
  else { wr32(PART.fade, 0x400); wr32(0x1bc98, 0); }
};
// returns true when the part is over
HP.fxD_post = function () {
  const M = HP.M;
  wr32(0x1bcb8, 2);
  HP.fn_1dab0(); HP.fn_1dab0(); HP.fn_1dab0();
  if (rds32(PART.crossFade) === 0x10000) { const t = rd32(PART.frameBuf); wr32(PART.frameBuf, rd32(PART.frameBuf2)); wr32(PART.frameBuf2, t); }
  HP.fill32(rd32(PART.frameBuf), rd32(rd32(0x1c140)), 0x12c00);
  if (rand(5) === 3) {
    wr32(PART.texDirty, 1);
    let ebp = rand(0xffffffff);
    rand(0xffffffff);                      // result discarded by the original (clobbered)
    let eax = rand(7);
    eax = ((eax & 0xffffff00) | ((eax + 1) & 0xff)) >>> 0;
    const cl = eax & 0xff;
    let src = rd32(0x1bcc4), edi = rd32(0x1c13c);
    for (let n = 0x10000; n > 0; n--) {
      eax = (eax + ebp) >>> 0;
      let bl = eax & 0xff;
      ebp = HP.rol(ebp, 3);
      bl = (bl >>> (cl & 31)) & 0xff;
      bl += M[src++];
      M[edi++] = bl > 255 ? 255 : bl;
    }
  } else if (rds32(PART.texDirty) === 1) {
    HP.copy(rd32(0x1c13c), rd32(0x1bcc4), 0x4000 * 4);
  }
  if (rd8(ADDR.keyEsc) === 1) { wr32(ADDR.partExit, 1); return true; }
  const esi = rd32(ADDR.playerState);
  if (rds32(esi + 0x30) < ((rds32(0x1bcb4) + rds32(0x1bcb0)) | 0)) return false;
  return true;
};
HP.fn_1d566 = function* (eax) {
  HP.fxD_init(eax);
  for (;;) {
    HP.fxD_render();
    present(rd32(PART.frameBuf), 0x1bcdc);               // present (esi=buffer, ebp=obj)
    yield;
    if (HP.fxD_post()) return;
  }
};
