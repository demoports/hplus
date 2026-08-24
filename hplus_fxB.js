// hplus port — effect B (0x1804a..0x185c2): textured 3D object ("K-"/"LA" chunks) with a 0xc0-record particle
// field, camera paths switched on song order, blue-channel horizontal smear, 256x256 gradient texture.
// External: fn_29a (alloc), fn_2c2c8 (rand), fn_156ff (part A helper: copy length-prefixed chunk),
// engine: fn_29060(eax, ebx, edx, esi, edi, ebp) build object from chunk data, fn_2a094(ecx, ebp) object init,
// fn_28ed8(eax, ebp), fn_2afd3(ebx, esi, edi, ebp) camera setup, fn_2af3a(), fn_2b037(ebx, ecx) rotation matrix,
// fn_2a2ac(esi, edi, ebp) render object, fn_2b0a8(esi, ebp) present. Player state via [0xe20] (+0x30 order, +0x34 row).
import { HP } from './hplus_core.js';

const { rd8, rd16, rd32, rds32, wr8, wr16, wr32, rdf, wrf, roundHalfEven } = HP;

// fn_1804a(esi, edi, ebp) -> edi: randomize 0x40 records of 0x2c bytes at edi (edi advances; callers chain it)
HP.fn_1804a = function (esi, edi, ebp) {
  for (let c = 0x40; c > 0; c--) {
    let eax = (HP.fn_2c2c8(0x320) - 0x190) | 0;
    wr32(0x178e8, eax); wrf(edi + 8, eax);
    eax = (HP.fn_2c2c8(0x28) + ebp) | 0;
    wr32(0x178e8, eax); wrf(edi + 4, eax);
    eax = (HP.fn_2c2c8(0x28) + esi) | 0;
    wr32(0x178e8, eax); wrf(edi + 0xc, eax);
    wr32(0x178e8, -0xc); wrf(edi + 0x20, -12);
    edi += 0x2c;
  }
  return edi;
};

// fn_180ec(ebp, edi): move the 0xc0 records along axis ebp: v += tbl[i&7]*0.2; if (v-300) >= 0 then v += -600
HP.fn_180ec = function (ebp, edi) {
  let ia = 0;
  for (let c = 0xc0; c > 0; c--) {
    const st = rdf(ia * 4 + 0x180bc) * rdf(0x180e0);   // x87 intermediates as doubles
    let v = rdf(edi + ebp) + st;
    const t = v - rdf(0x180e4);
    wrf(0x180dc, t);
    if (!(rd32(0x180dc) & 0x80000000)) v = v + rdf(0x180e8);
    wrf(edi + ebp, v);
    ia = (ia + 1) & 7;
    edi += 0x2c;
  }
};

// fn_18135(ecx, edx, edi): horizontal smear of the blue byte of a 320x240x32 buffer at edi:
// b' = (mt[cl*256+b] + mt[dl*256+prev]) >> 8  (prev = previous output in the row, 0 at row start)
HP.fn_18135 = function (ecx, edx, edi) {
  const M = HP.M, mt = rd32(0x1088);
  const ah = ecx & 0xff, bh = edx & 0xff;
  for (let y = 0xf0; y > 0; y--) {
    let ch = 0;
    for (let x = 0x140; x > 0; x--) {
      const al = M[edi];
      const cx = (rd16(mt + ((ah << 8) | al) * 2) + rd16(mt + ((bh << 8) | ch) * 2)) & 0xffff;
      ch = cx >>> 8;
      M[edi] = ch;
      edi += 4;
    }
  }
};

// fn_1816a: effect B precalc
HP.fn_1816a = function () {
  const M = HP.M;
  let eax = HP.fn_29a(0xb6010); eax = (eax | 0xf) + 1;
  wr32(0x178d8, eax); eax += 0x4b000; wr32(0x178dc, eax); eax += 0x4b000;
  wr32(0x23fd0, 0x64);
  HP.fn_156ff(0x161d4, rd32(0x178d8));
  HP.fn_29060(0, 1, 0, 0xffffffff, rd32(0x178e0), rd32(0x178d8), 0x178ec);     // (eax, ebx, ecx, edx, esi, edi, ebp) — engine signature
  wr32(0x23fd0, 0x9c4);
  HP.fn_156ff(0x171db, rd32(0x178d8));
  HP.fn_29060(3, 9, 0, 0xffffffff, rd32(0x178e0), rd32(0x178d8), 0x178ec);
  wr32(0x17914, 1); wr32(0x17918, 0x1a); wr32(0x17919, 0x1a); wr32(0x1791a, 0x28);   // overlapping dword stores, as in the original
  HP.fill32(rd32(0x178d8), 0, 0x25800);
  HP.fn_2a094(0xc0, 0x178ec);          // (ecx, ebp)
  HP.fn_28ed8(1, 0x178ec);             // (eax, ebp)
  let edi = rd32(0x17e00);
  edi = HP.fn_1804a(0x56, edi, 0x2b);          // (esi, edi, ebp)
  edi = HP.fn_1804a(-0x20, edi, -0x7f);
  edi = HP.fn_1804a(-0x70, edi, 0x4b);
  wr32(0x17974, rd32(0x17e78)); wr32(0x17978, rd32(0x17e7c)); wr32(0x1797c, rd32(0x17e80)); wr32(0x17910, rd32(0x17e84));
  wrf(0x17d58, 1); wr32(0x178e8, 0xff); wrf(0x17d5c, 255);
  // 256x256 gradient: row y filled with y>>2
  edi = rd32(0x17d64);
  for (let y = 0; y < 0x100; y++, edi += 0x100) M.fill(y >> 2, edi, edi + 0x100);
};

// fn_184f0: one update step (14 ms)
HP.fn_184f0 = function () {
  if (rd8(0xa01) === 1) return;
  HP.fn_2af3a();
  HP.fn_2b037(0x17e68, rd32(0x178e0));        // (ebx=angles, ecx)
  HP.fn_180ec(8, rd32(0x17e00));              // (ebp, edi)
  const esi = rd32(0xe20);
  const eax = rd32(esi + 0x30);
  if (eax !== rd32(0x17ebc)) {
    wr32(0x17ebc, eax);
    wr32(0x17eb8, rd32(0x17eb8) + 1);
    const ebx = rd32(0x17eb8) & 3;
    if (rd32(ebx * 4 + 0x17ee0) !== rd32(ebx * 4 + 0x17edc)) {
      const s = rd32(0x17eb8) & 3;
      wr32(0x17e6c, rd32(s * 4 + 0x17ed0)); wr32(0x17e74, rd32(s * 4 + 0x17ec0));
      wr32(0x17e70, 0); wrf(0x17e68, 0);
    }
  }
  wrf(0x17e9c, rdf(0x17e9c) + rdf(0x17ea8));
  wrf(0x17ea0, rdf(0x17ea0) + rdf(0x17eac));
  wrf(0x17ea4, rdf(0x17ea4) + rdf(0x17eb0));
};

// fn_182fc(eax, ebx): run effect B until song position (start order + eax, row ebx). Generator: yields after each present.
// 0x182fc..0x18372: run-loop initialisation
HP.fn_182fc_init = function (eax, ebx) {
  wr32(0x178c8, eax); wr32(0x178cc, ebx);
  const esi = rd32(0xe20);
  const startOrder = rd32(esi + 0x30);
  wr32(0x17ebc, startOrder); wr32(0x178d0, startOrder);
  wr32(0x17eb8, 0);
  const s = rd32(0x17eb8);
  wr32(0x17e6c, rd32(s * 4 + 0x17ed0)); wr32(0x17e74, rd32(s * 4 + 0x17ec0));
  wr32(0x17e70, 0); wrf(0x17e68, 0);
  wr32(0x2ee54, 0);
  HP.fill32(rd32(0x178d8), rd32(rd32(0x17d50)), 0x12c00);
};
// 0x18374..0x18458: render part of one frame (camera, object, blend weights, blue smear) — up to the present call
HP.fn_182fc_render = function () {
  const path = rd32((rd32(0x17eb8) & 3) * 4 + 0x17ee0);
  wr32(0x28c9c, 1);
  HP.fn_2afd3(0x17e68, 0x17e04, path, 0x178ec);     // (ebx=0x17e68, esi=0x17e04, edi=path, ebp=0x178ec)
  wr32(0x1795c, rd32(0x17e04)); wr32(0x17960, rd32(0x17e08)); wr32(0x17964, rd32(0x17e0c));
  wr32(0x17968, rd32(0x17e10)); wr32(0x1796c, rd32(0x17e14)); wr32(0x17970, rd32(0x17e18));
  HP.fn_2a2ac(0x17e04, 0x178ec, rd32(0x178d8));     // (esi=camera, ebp=object, edi=buffer) — engine signature order
  HP.fn_182fc_blend();
  HP.fn_18135(rds32(0x17e8c), rds32(0x17e90), rd32(0x178d8));   // (ecx, edx, edi)
};
// 0x183fb..0x1843c: blend weights from the angles: r = fistp(sin(a*0.412)*sin(c*0.412)*128+128); [0x17e8c]=255-r, [0x17e90]=r
HP.fn_182fc_blend = function () {
  let v = Math.sin(rdf(0x17e9c) * rdf(0x17eb4)) * Math.sin(rdf(0x17ea4) * rdf(0x17eb4));
  v = v * rdf(0x17e94) + rdf(0x17e98);
  const r = roundHalfEven(v) | 0;
  wr32(0x17e8c, (0xff - r) | 0); wr32(0x17e90, r);
};
HP.fn_182fc = function* (eax, ebx) {
  HP.fn_182fc_init(eax, ebx);
  let esi;
  for (;;) {
    HP.fn_182fc_render();
    HP.fn_2b0a8(rd32(0x178d8), 0x178ec);              // present (esi=buffer, ebp=object)
    yield;
    wr32(0x178d4, 2);
    let n = Math.trunc((rds32(0x28e28) + 1) / 0xe);
    for (; n > 0; n--) HP.fn_184f0();
    HP.fill32(rd32(0x178d8), rd32(rd32(0x17d50)), 0x12c00);
    if (rd8(0x9c9) === 1) { wr32(0x1084, 1); return; }
    esi = rd32(0xe20);
    if (rds32(esi + 0x30) < (rds32(0x178d0) + rds32(0x178c8) | 0)) continue;
    if (rds32(esi + 0x34) < rds32(0x178cc)) continue;
    return;
  }
};
