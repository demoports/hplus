// hplus port — effect A (0x1545e..0x161c3): wireframe grid floor + flat-shaded cube structures.
// External: fn_29a (alloc), fn_2c2c8 (rand), engine: fn_29060 (build object from chunk data),
// fn_2a094 (object init), fn_28ed8, fn_2afd3, fn_2af3a, fn_2b037, fn_2a2ac (render object),
// fn_2b0a8 (present). Player state via [0xe20] (+0x30 order, +0x34 row).
(function (root) {
  'use strict';
  const HP = root.HP;
  const { rd8, rd16, rd32, rds32, wr8, wr16, wr32, rdf, wrf, fround, roundHalfEven } = HP;
  const f = fround;

  // fn_1545e(edx, ebp, esi, edi): randomize 0x40 records of 0x2c bytes at edi
  HP.fn_1545e = function (edx, ebp, esi, edi) {
    for (let c = 0x40; c > 0; c--) {
      let eax = HP.fn_2c2c8(0x1770) + 0xe6;
      if (edx === 1) eax = -eax;
      wr32(0x14530, eax); wrf(edi + ebp, eax);
      eax = HP.fn_2c2c8(0x14) - 10; wr32(0x14530, eax); wrf(edi + esi, eax);
      eax = HP.fn_2c2c8(0x14) - 10; wr32(0x14530, eax); wrf(edi + 0xc, eax);
      wr32(0x14530, -0x1e); wrf(edi + 0x20, -30);
      edi += 0x2c;
    }
    return edi;
  };

  // fn_15508(edx, ebp, edi): move the 0x40 records along axis ebp, wrapping at +-0x1770 (with +-0xe6 offset)
  HP.fn_15508 = function (edx, ebp, edi) {
    let eax = 0xe6, ebx = 0x1770;
    if (edx === 1) { eax = -eax; ebx = -ebx; }
    wr32(0x14530, eax); wrf(0x15500, eax);
    wr32(0x14530, ebx); wrf(0x15504, ebx);
    let ia = 0;
    for (let c = 0x40; c > 0; c--) {
      let st = rdf(ia * 4 + 0x154d8) * rdf(0x154f8);   // x87 intermediates kept as doubles, rounded at fstp
      if (edx !== 1) st = -st;
      let v = rdf(edi + ebp) + st;                 // fld [edi+ebp]; fadd st(1)
      let t = v - rdf(0x15500);                    // fsub [0x15500]
      if (edx !== 1) t = -t;                       // fchs (when edx != 1)
      wrf(0x154fc, t);
      if (!(rd32(0x154fc) & 0x80000000)) v = v + rdf(0x15504);
      wrf(edi + ebp, v);
      ia = (ia + 1) & 7;
      edi += 0x2c;
    }
    return edi;
  };

  // fn_15595(edi) -> edi: store [0x14538..0x14540] as 3 floats at edi, edi += 12
  HP.fn_15595 = function (edi) {
    wrf(edi, rds32(0x14538)); wrf(edi + 4, rds32(0x1453c)); wrf(edi + 8, rds32(0x14540));
    return edi + 0xc;
  };
  // fn_155b3(edi) -> edi: 8 vertices of a box
  HP.fn_155b3 = function (edi) {
    wr32(0x14538, -0x19640); wr32(0x1453c, -0x19640); wr32(0x14540, -0x5dc);
    edi = HP.fn_15595(edi); wr32(0x14538, -rds32(0x14538));
    edi = HP.fn_15595(edi); wr32(0x1453c, -rds32(0x1453c));
    edi = HP.fn_15595(edi); wr32(0x14538, -rds32(0x14538));
    edi = HP.fn_15595(edi); wr32(0x1453c, -rds32(0x1453c));
    wr32(0x14540, 0x19640);
    edi = HP.fn_15595(edi); wr32(0x14538, -rds32(0x14538));
    edi = HP.fn_15595(edi); wr32(0x1453c, -rds32(0x1453c));
    edi = HP.fn_15595(edi); wr32(0x14538, -rds32(0x14538));
    edi = HP.fn_15595(edi);
    return edi;
  };
  // fn_15646(edi) -> edi: 0x18 word indices from the table at 0x1562e
  HP.fn_15646 = function (edi) {
    for (let eax = 0; eax < 0x18; eax++) { wr16(edi, rd8(eax + 0x1562e)); edi += 2; }
    return edi;
  };
  // fn_15660(eax, ebx, edi) -> edi: 100 line segments of the grid (eax/ebx = 0/4 axis offsets)
  HP.fn_15660 = function (eax, ebx, edi) {
    wr32(0x14538, 0x28); wr32(0x1453c, -0x19640); wr32(0x14540, -0x3e8);
    let edx = rds32(0x14538);
    for (let c = 0x64; c > 0; c--) {
      const a = rds32(0x14538), b = rds32(0x1453c), cc = rds32(0x14540);
      wrf(edi + eax, a); wrf(edi + eax + 0xc, a);
      wrf(edi + ebx, b); wrf(edi + ebx + 0xc, -b);
      wrf(edi + 8, cc); wrf(edi + 0x14, cc);
      edi += 0x18;
      wrf(edi + eax, -a); wrf(edi + eax + 0xc, -a);
      wrf(edi + ebx, b); wrf(edi + ebx + 0xc, -b);
      wrf(edi + 8, cc); wrf(edi + 0x14, cc);
      edi += 0x18;
      edx += 0x14;
      wr32(0x14538, rds32(0x14538) + edx);
    }
    return edi;
  };
  // fn_156ff(esi, edi) -> edi: copy a length-prefixed chunk ([esi-4] bytes) and terminate with 0
  HP.fn_156ff = function (esi, edi) {
    const n = rd32(esi - 4);
    HP.copy(edi, esi, n); edi += n;
    wr32(edi, 0);
    return edi;
  };
  // fn_1570b(esi, ebp): ebp[0..2] += (ebp[3..5]-ebp[0..2])*[esi]; ebp[3..5] += same  (camera smoothing)
  HP.fn_1570b = function (esi, ebp) {
    const k = rdf(esi);
    for (let i = 0; i < 3; i++) {
      const d = (rdf(ebp + 0xc + i * 4) - rdf(ebp + i * 4)) * k;
      wrf(ebp + 0xc + i * 4, d + rdf(ebp + 0xc + i * 4));
      wrf(ebp + i * 4, d + rdf(ebp + i * 4));
    }
  };
  // fn_1574e(ebp, edi): brightness LUT (x*ebp>>10) applied to a 320x240x32 buffer at edi
  HP.fn_1574e = function (ebp, edi) {
    for (let b = 0; b < 0x100; b++) wr8(b + 0x143fc, (Math.imul(b, ebp) >>> 10) & 0xff);
    const M = HP.M;
    for (let n = 0x12c00; n > 0; n--) {
      M[edi] = M[M[edi] + 0x143fc]; M[edi + 1] = M[M[edi + 1] + 0x143fc]; M[edi + 2] = M[M[edi + 2] + 0x143fc];
      edi += 4;
    }
  };
  // fn_1579c: the "glitch" frame: noise over the screen through mask [0x143f0], then bottom logo blend
  HP.fn_1579c = function () {
    const M = HP.M;
    wr32(0x143e5, 1);
    let cl = (HP.fn_2c2c8(3) + 5) & 0xff;
    if (HP.fn_2c2c8(0x28) === 6) cl = 2;
    let esi = rd32(0x143f0), edi = rd32(0x143f8);
    let ebp = HP.fn_2c2c8(0xffffffff), ebx = HP.fn_2c2c8(0xffffffff);
    for (let n = 0x12c00; n > 0; n--) {
      if (M[esi] !== 1) {
        const al = ((ebx & 0xff) >>> (cl & 31)) & 0xff;
        M[edi] = al; M[edi + 1] = al; M[edi + 2] = al;
      }
      ebx = HP.rol(ebx, cl & 31); ebx = (ebx + ebp) >>> 0;
      esi++; edi += 4;
    }
    // logo brightness from camera angles
    let s = Math.sin(rdf(0x1500c) * rdf(0x15024));
    let cc = Math.cos((rdf(0x15010) + rdf(0x15014)) * rdf(0x15024));
    let v = s * cc;
    v = v * Math.sin(rdf(0x15014) * rdf(0x15024));
    v = v * rdf(0x15004) + rdf(0x15008);
    let r = roundHalfEven(v) | 0;
    wr32(0x14ffc, r);
    let eax = 0xff - r; const old = rds32(0x14ffc); wr32(0x14ffc, eax); wr32(0x15000, old);
    const ah = rd8(0x15000), bh = rd8(0x14ffc);
    esi = rd32(0x143ec); edi = rd32(0x143f8) + 0x23500;
    const mt = rd32(0x1088);   // word multiplication table
    wr32(0x14530, 0x12);
    do {
      // first pass: line of 320 bytes: tmp[esi+0x167f] = (mt[ah*256+src] + mt[bh*256+prev]) >> 8
      let ch = 0;
      for (let n = 0x140; n > 0; n--) {
        const al = M[esi];
        const cx = (rd16(mt + ((ah << 8) | al) * 2) + rd16(mt + ((bh << 8) | ch) * 2)) & 0xffff;
        ch = cx >>> 8;
        esi++;
        M[esi + 0x167f] = ch;
      }
      edi += 0x500;
      // second pass (backwards): add ch to each byte with saturation
      ch = 0;
      for (let n = 0x140; n > 0; n--) {
        const al = M[esi + 0x1680];
        esi--;
        const cx = (rd16(mt + ((ah << 8) | al) * 2) + rd16(mt + ((bh << 8) | ch) * 2)) & 0xffff;
        ch = cx >>> 8;
        edi -= 4;
        for (let k = 0; k < 3; k++) {
          let v2 = M[edi + k] + ch;
          M[edi + k] = v2 > 255 ? 255 : v2;
        }
      }
      edi += 0x500; esi += 0x140;
      wr32(0x14530, rds32(0x14530) - 1);
    } while (rds32(0x14530) !== 0);
  };

  // fn_15922: effect A precalc (objects, buffers, tables)
  HP.fn_15922 = function () {
    let eax = HP.fn_29a(0x96010); eax = (eax | 0xf) + 1;
    wr32(0x1451c, eax); eax += 0x4b000; wr32(0x14520, eax); eax += 0x4b000;
    let edi = HP.fn_156ff(0xe474, rd32(0x1451c));
    HP.fn_29060(1, 1, 0, 0xffffffff, rd32(0x14528), rd32(0x1451c), 0x14544);   // (eax, ebx, ecx, edx, esi, edi, ebp) — engine signature
    edi = HP.fn_156ff(0xea3c, rd32(0x1451c));
    HP.fn_29060(1, 1, 0, 0xffffffff, rd32(0x14528), rd32(0x1451c), 0x14544);
    edi = rd32(0x1451c);
    wr32(edi, 0x656e694c); edi += 4;          // 'Line'
    wr16(edi, 0x320); edi += 2;
    edi = HP.fn_15660(0, 4, edi);
    edi = HP.fn_15660(4, 0, edi);
    wr16(edi, 0x190); edi += 2;
    for (let i = 0, ax = 0; i < 0x190; i++) { wr16(edi, ax); ax++; wr16(edi + 2, ax); ax++; edi += 4; }
    wr32(edi, 0);
    HP.fn_29060(1, 0x101, 0, 0xffffffff, rd32(0x14528), rd32(0x1451c), 0x14a5c);
    edi = rd32(0x1451c);
    wr32(edi, 0x2175624f); edi += 4;          // 'Obu!'
    wr16(edi, 8); edi += 2;
    edi = HP.fn_155b3(edi);
    wr16(edi, 8); edi += 2;
    edi = HP.fn_15646(edi);
    wr32(edi, 0);
    HP.fn_29060(1, 0x101, 0, 0xffffffff, rd32(0x14ff8), rd32(0x1451c), 0x14a5c);
    wr32(0x1456c, 0); wr32(0x14570, 0x1a); wr32(0x14571, 0x1a); wr32(0x14572, 0x28);
    wr32(0x14638, rd32(0x14ff8));
    wr32(0x26404, 0);
    wrf(0x145e0, 0); wrf(0x145e4, 0); wrf(0x145e8, 0); wrf(0x1461c, 0); wrf(0x14620, 0); wrf(0x14624, 0);
    HP.fill32(rd32(0x1451c), 0, 0x25800);
    HP.fn_2a094(0x100, 0x14544);
    HP.fn_2a094(0, 0x14a5c);
    HP.fn_28ed8(1, 0x14544);
    HP.fn_28ed8(1, 0x14a5c);
    let o = rd32(0x14a58);            // edi is carried across the four calls (consecutive blocks)
    o = HP.fn_1545e(1, 4, 8, o); o = HP.fn_1545e(0, 4, 8, o); o = HP.fn_1545e(1, 8, 4, o); o = HP.fn_1545e(0, 8, 4, o);
    wr32(0x145cc, rd32(0x14fe8)); wr32(0x145d0, rd32(0x14fec)); wr32(0x145d4, rd32(0x14ff0)); wr32(0x14568, rd32(0x14ff4));
    eax = HP.fn_29a(0x12c10); eax = (eax | 0xf) + 1; wr32(0x143f0, eax);
    HP.fill32(eax, 0, 0x4b00);
    HP.copy(rd32(0x143f0) + 0x76c0, 0x10564, 0xfa0 * 4);
    eax = HP.fn_29a(0x2d10); eax = (eax | 0xf) + 1; wr32(0x143ec, eax);
    for (let i = 0; i < 0x1680; i++) HP.M[eax + i] = (HP.M[0xeee4 + i] << 4) & 0xff;
  };

  // fn_15fb0: one update step (14 ms)
  HP.fn_15fb0 = function () {
    if (rd8(0xa01) !== 1) {
      HP.fn_2af3a();
      HP.fn_2b037(0x14fd8, rd32(0x14528));          // (ebx=angles, ecx=matrix)
      let o = rd32(0x14a58);          // edi carried across the four calls
      o = HP.fn_15508(1, 4, o); o = HP.fn_15508(0, 4, o); o = HP.fn_15508(1, 8, o); o = HP.fn_15508(0, 8, o);
      if (rds32(0x15308) !== 3 && rds32(0x15028) !== 1) {
        const esi = rd32(0xe20);
        const eax = ((rds32(esi + 0x30) - 1) >>> 1);
        if (eax !== rd32(0x1530c)) {
          wr32(0x1530c, eax);
          wr32(0x15308, rd32(0x15308) + 1);
          const ebx = rd32(0x15308) & 3;
          if (rd32(ebx * 4 + 0x15330) !== rd32(ebx * 4 + 0x1532c)) {
            const s = rd32(0x15308) & 3;
            wr32(0x14fdc, rd32(s * 4 + 0x15320)); wr32(0x14fe4, rd32(s * 4 + 0x15310));
            wr32(0x14fe0, 0); wrf(0x14fd8, 0);
          }
        }
      }
      wrf(0x1500c, rdf(0x1500c) + rdf(0x15018));
      wrf(0x15010, rdf(0x15010) + rdf(0x1501c));
      wrf(0x15014, rdf(0x15014) + rdf(0x15020));
      const esi = rd32(0xe20);
      if (rds32(esi + 0x30) >= rds32(0x14510)) {
        wrf(0x14504, rdf(0x14504) + rdf(0x14508));
        wrf(0x14500, rdf(0x14500) + rdf(0x14504));
        wr32(0x144fc, rds32(0x144fc) - 8);
        if (rds32(0x144fc) <= 0) wr32(0x144fc, 0);
      }
      if (rds32(0x15028) === 1) {
        wr32(0x143f4, rds32(0x143f4) + 5);
        if (rds32(0x143f4) >= 0xff) wr32(0x143f4, 0xff);
      }
    }
    if (rd32(0x2ee58) === 0) {
      if (rds32(0x14fe0) >= 0xf0) wr32(0x2ee58, 1);
    }
    if (rd32(0x2ee58) !== 0) {
      wr32(0x2ee58, rd32(0x2ee58) + 1);
      wr32(0x144fc, rd32(0x2ee60));
    }
    if (rds32(0x1502c) === 1) {
      wr32(0x144fc, rds32(0x144fc) + 2);
      if (rds32(0x144fc) >= 0x400) { wr32(0x144fc, 0x400); wr32(0x1502c, 2); }
    }
    if (rd8(0x9ec) === 1) { wr32(0x2ee58, 0x44c); wr32(0x144fc, 0); }
  };

  // fn_15c18(eax, ebx): run effect A until song position (start order + eax, row ebx). Generator: yields after each present.
  HP.fn_15c18 = function* (eax, ebx) {
    const M = HP.M;
    wr32(0x143f4, 0xff); wr32(0x15028, 0); wr32(0x1502c, 1);
    if (eax === -1 || eax === 0xffffffff) {
      wr32(0x1502c, 0); wr32(0x143f4, 0); wr32(0x15028, 1);
      eax = 0x3e8;
      HP.copy(0x15178, 0x15178 - 0xa0, 0x28 * 4);
      HP.copy(0x15178 + 0xa0, 0x15178 - 0xa0, 0x28 * 4);   // second rep movsd continues from the advanced edi
      HP.copy(0x15178 + 0x140, 0x15178 - 0x50, 0x14 * 4);
    }
    wr32(0x26404, 0);
    wr32(0x14510, eax); wr32(0x1450c, ebx);
    let esi = rd32(0xe20);
    const startOrder = rd32(esi + 0x30);
    wr32(0x1530c, startOrder); wr32(0x14514, startOrder);
    wr32(0x15308, 0);
    {
      const s = rd32(0x15308);
      let a = rd32(s * 4 + 0x15320), b = rd32(s * 4 + 0x15310);
      if (rds32(0x15028) === 1) { a = rd32(0x15034); b = rd32(0x15030); }
      wr32(0x14fdc, a); wr32(0x14fe4, b); wr32(0x14fe0, 0); wrf(0x14fd8, 0);
    }
    wr32(0x2ee54, 0);
    HP.fill32(rd32(0x1451c), 0, 0x12c00);
    wrf(0x14500, 0);
    wr32(0x144fc, 0x400);
    if (rds32(0x1502c) === 1) wr32(0x144fc, 0);
    for (;;) {
      if (rds32(0x143e5) !== 1) {
        const r = HP.fn_2c2c8(8);
        wr32(0x14618, rd32(0x14618) | 1);
        if (r === 3) wr32(0x14618, rd32(0x14618) & 0x3ffe);
        let edi = rd32((rd32(0x15308) & 3) * 4 + 0x15330);
        wr32(0x28c9c, 1);
        if (rds32(0x15028) === 1) { edi = 0x15038; wr32(0x28c9c, 0); }
        HP.fn_2afd3(0x14fd8, 0x14f74, edi, 0x14544);    // (ebx=0x14fd8, esi=0x14f74, edi=path, ebp=0x14544)
        wr32(0x14a90, rd32(0x14578));
        HP.fn_1570b(0x14500, 0x14f74);
        const sa = rd32(0x145ac), sb = rd32(0x145a4);
        wr32(0x145ac, 0); wr32(0x145a4, 0);
        HP.fn_2a2ac(0x14f74, 0x14544, rd32(0x1451c));    // (esi=camera, ebp=object, edi=buffer) — engine signature order
        wr32(0x145a4, sb); wr32(0x145ac, sa);
        HP.fn_2a2ac(0x14f74, 0x14a5c, rd32(0x1451c));
        HP.fn_2a2ac(0x14f74, 0x14544, rd32(0x1451c));
        wr16(0xbc, rd16(0x1545c));
        if (rds32(0x144fc) !== 0x400) HP.fn_1574e(rds32(0x144fc), rd32(0x1451c));
        wr32(0x143f8, rd32(0x21da8));
        if (rds32(0x143f4) !== 0) {
          wr32(0x143f8, rd32(0x1451c));
          if (rds32(0x143f4) !== 0xff) {
            wr32(0x15000, 0xff - rds32(0x143f4));
            const ah = rd8(0x143f4), bh = rd8(0x15000);
            const mt = rd32(0x1088);
            let d = rd32(0x1451c), s2 = rd32(0x21da8);
            for (let n = 0x4b000; n > 0; n--) {
              const cx = (rd16(mt + ((ah << 8) | M[d]) * 2) + rd16(mt + ((bh << 8) | M[s2]) * 2)) & 0xffff;
              M[d] = cx >>> 8; d++; s2++;
            }
          }
        }
      }
      if (rds32(0x2ee58) >= 0x44c) HP.fn_1579c();
      else {
        const b = rd32(0x143f8);
        HP.fill32(b, 0, 0x140);
        for (let y = 0, p = b; y < 0xf0; y++, p += 0x500) wr32(p, 0);
      }
      HP.fn_2b0a8(rd32(0x143f8), 0x14544);          // present (esi=buffer, ebp=object)
      yield;
      wr32(0x14518, 1);
      let n = Math.trunc((rds32(0x28e28) + 1) / 0xe);
      for (; n > 0; n--) HP.fn_15fb0();
      HP.fill32(rd32(0x1451c), 0, 0x12c00);
      if (rds32(0x2ee58) > 0x7d0) return;
      if (rd8(0x9c9) === 1) { wr32(0x1084, 1); return; }
      esi = rd32(0xe20);
      if (rds32(esi + 0x30) < rds32(0x14514) + rds32(0x14510)) continue;
      if (rds32(esi + 0x34) < rds32(0x1450c)) continue;
      return;
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
