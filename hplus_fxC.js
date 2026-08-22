// hplus port — part C (0x1b4a6..0x1bc72): textured object + 255 particles riding three splines built
// from the object's vertices; sine-driven horizontal blue smear, half-brightness flicker after order 16 row 58.
//
// External functions (register-order args):
//   core:   HP.fn_29a(eax=size)->ptr, HP.fn_2c2c8(eax=range)->rand
//   part A: HP.fn_156ff(esi=chunk, edi=dst)->edi        (copy length-prefixed chunk + 0 terminator)
//   part B: HP.fn_18135(ecx, edx, edi=buffer)            (horizontal IIR smear of the blue channel: b = (ecx*b + edx*prev)>>8)
//   engine: HP.fn_29060(eax, ebx, ecx, edx, esi, edi, ebp) (build object from chunk data; ecx/edx unused)
//           HP.fn_2a094(ecx, ebp)                         (object init)
//           HP.fn_28ed8(eax, ebp)
//           HP.fn_28ca4(ebx=particle rec, ecx=3, edi=path+0x18) -> writes [0x28c74],[0x28c78],[0x28c7c]
//           HP.fn_2afd3(ebx=angles, esi=camera, edi=path, ebp=object)
//           HP.fn_2a2ac(esi=camera, ebp=object, edi=buffer)   (engine's arg order)
//           HP.fn_2b0a8(esi=buffer, ebp=object)          (present)
//           HP.fn_2af3a(), HP.fn_2b037(ebx=angles/rec, ecx=scale bits)
// Player state via [0xe20] (+0x30 order, +0x34 row).
(function (root) {
  'use strict';
  const HP = root.HP;
  const { rd8, rd16, rd32, rds32, wr8, wr16, wr32, rdf, wrf, roundHalfEven } = HP;

  // fn_1b4a6(esi=vertex array (0x3c-byte vertices, 12 per 0x2d0 group), edi=path block) -> edi (advanced by 0x2d0)
  // Writes 18 records of 0x28 bytes: [0]=start (extrapolated), [1..16]=centre of 4 vertices of each of 16 groups, [17]=end.
  HP.fn_1b4a6 = function (esi, edi) {
    const k = rdf(0x1b250);
    for (let ebp = 0; ebp < 12; ebp += 4) {
      const A = (rdf(esi + ebp + 4) + rdf(esi + ebp + 0x40) + rdf(esi + ebp + 0x7c) + rdf(esi + ebp + 0xb8)) * k + rdf(ebp + 0x1af3c);
      const B = (rdf(esi + ebp + 0x2d4) + rdf(esi + ebp + 0x310) + rdf(esi + ebp + 0x34c) + rdf(esi + ebp + 0x388)) * k + rdf(ebp + 0x1af3c);
      wrf(edi + ebp + 0x18, A - Math.abs(A - B));
    }
    edi += 0x28;
    for (let c = 0x10; c > 0; c--) {
      wrf(edi + 0x18, (rdf(esi + 4) + rdf(esi + 0x40) + rdf(esi + 0x7c) + rdf(esi + 0xb8)) * k + rdf(0x1af3c));
      wrf(edi + 0x1c, (rdf(esi + 8) + rdf(esi + 0x44) + rdf(esi + 0x80) + rdf(esi + 0xbc)) * k + rdf(0x1af40));
      wrf(edi + 0x20, (rdf(esi + 0xc) + rdf(esi + 0x48) + rdf(esi + 0x84) + rdf(esi + 0xc0)) * k + rdf(0x1af44));
      esi += 0x2d0; edi += 0x28;
    }
    for (let ebp = 0; ebp < 12; ebp += 4) {
      const A = (rdf(esi + ebp - 0x2cc) + rdf(esi + ebp - 0x290) + rdf(esi + ebp - 0x254) + rdf(esi + ebp - 0x218)) * k + rdf(ebp + 0x1af3c);
      const B = (rdf(esi + ebp - 0x59c) + rdf(esi + ebp - 0x560) + rdf(esi + ebp - 0x524) + rdf(esi + ebp - 0x4e8)) * k + rdf(ebp + 0x1af3c);
      wrf(edi + ebp + 0x18, A + Math.abs(A - B));
    }
    edi += 0x28;
    return edi;
  };

  // fn_1b5eb: part C precalc
  HP.fn_1b5eb = function () {
    const M = HP.M;
    let eax = HP.fn_29a(0xb6010); eax = (eax | 0xf) + 1;
    wr32(0x1ac34, eax); eax += 0x4b000; wr32(0x1ac38, eax); eax += 0x4b000;
    wr32(0x23fd0, 0);
    HP.fn_156ff(0x185d4, rd32(0x1ac34));
    HP.fn_29060(0, 1, 0, 0xffffffff, rd32(0x1ac3c), rd32(0x1ac34), 0x1ac48);   // (eax, ebx, ecx(=0, unused), edx, esi, edi, ebp)
    HP.fn_156ff(0x19be4, rd32(0x1ac34));
    HP.fn_29060(3, 9, 0, 0xffffffff, rd32(0x1ac3c), rd32(0x1ac34), 0x1ac48);
    {
      const keep = rd32(0x1b0a8);
      HP.copy(0x1b09c, 0x1b0b4, 6 * 4);
      wr32(0x1b0a8, keep);
    }
    wr32(0x1ac44, 0x40); wrf(0x1b09c, 64); wrf(0x1b0a0, 64);
    // texture 1 <- texture 0 darkened by 11 with a per-row sine bias; texture 0 darkened in place
    let esi = rd32(0x1b0c0), edi = rd32(0x1b0a8);
    for (let edx = 0x100; edx > 0; edx--) {
      wr32(0x1ac44, 0x100);
      let v = Math.PI / 0x100;
      wr32(0x1ac44, edx); v = v * edx;
      wr32(0x1ac44, 6); v = v * 6;
      v = Math.sin(v);
      wr32(0x1ac44, 0xa); v = v * 10;
      const r = roundHalfEven(v) | 0; wr32(0x1ac44, r);
      const ebx = r + 0xa;
      for (let c = 0x100; c > 0; c--) {
        let a = M[esi] - 0xb; if (a <= 0) a = 0;
        M[esi] = a & 0xff;
        a += ebx;
        if (a >= 0x3f) a = 0x3f;
        if (a <= 0) a = 0;
        M[edi] = a & 0xff;
        esi++; edi++;
      }
    }
    edi = rd32(0x1b0d8);
    for (let c = 0x10000; c > 0; c--, edi++) { let a = M[edi] - 0x28; if (a <= 0) a = 0; M[edi] = a; }
    wr32(0x1ac70, 1); wr32(0x1ac74, 0x1a); wr32(0x1ac75, 0x1a); wr32(0x1ac76, 0x28);
    HP.fill32(rd32(0x1ac34), 0, 0x25800);
    HP.fn_2a094(0xff, 0x1ac48);                                                  // (ecx, ebp)
    eax = HP.fn_29a(0xff * 0x10 + 0x10); eax = (eax | 0xf) + 1; wr32(0x1b238, eax);
    edi = eax;
    for (let c = 0xff; c > 0; c--) {
      let r = HP.fn_2c2c8(0x64); wr32(0x1ac44, r);
      wr32(0x1ac44, 0x64); wrf(edi, r / 0x64);
      r = HP.fn_2c2c8(0xf); wr32(edi + 8, Math.imul(r, 0x28)); wr32(edi + 0xc, 0x2d0);
      r = HP.fn_2c2c8(0x2bc) + 0x2bc; wr32(0x1ac44, r);
      wr32(0x1ac44, 0x186a0); wrf(edi + 4, r / 0x186a0);
      edi += 0x10;
    }
    HP.fn_28ed8(1, 0x1ac48);                                                     // (eax, ebp)
    wr32(0x1acd0, rd32(0x1b23c)); wr32(0x1acd4, rd32(0x1b240)); wr32(0x1acd8, rd32(0x1b244)); wr32(0x1ac6c, rd32(0x1b248));
    eax = HP.fn_29a(0x2e0); eax = (eax | 0xf) + 1; wr32(0x1b4a2, eax);
    // NB: the original allocates 0x2e0 bytes but writes 3 x 0x2d0 (edi is carried across the calls) — kept as is.
    edi = eax;
    edi = HP.fn_1b4a6(rd32(0x1af68), edi);
    edi = HP.fn_1b4a6(rd32(0x1af68) + 0xf0, edi);
    edi = HP.fn_1b4a6(rd32(0x1af68) + 0x1e0, edi);
  };

  // fn_1bb90: one update step (14 ms)
  HP.fn_1bb90 = function () {
    if (rd8(0xa01) === 1) return;
    HP.fn_2af3a();
    HP.fn_2b037(0x1b228, rd32(0x1ac3c));                                         // (ebx=angles, ecx)
    let ebx = rd32(0x1b238);
    for (let edi = 0xff; edi > 0; edi--, ebx += 0x10) HP.fn_2b037(ebx, rd32(0x1ac3c));
    const esi = rd32(0xe20);
    const eax = rd32(esi + 0x30);
    if (eax !== rd32(0x1b288)) {
      wr32(0x1b288, eax);
      wr32(0x1b284, rd32(0x1b284) + 1);
      const b = rd32(0x1b284) & 3;
      if (rd32(b * 4 + 0x1b2ac) !== rd32(b * 4 + 0x1b2a8)) {
        wr32(0x1b22c, rd32(b * 4 + 0x1b29c)); wr32(0x1b234, rd32(b * 4 + 0x1b28c));
        wr32(0x1b230, 0); wrf(0x1b228, 0);
      }
    }
    wrf(0x1b264, rdf(0x1b264) + rdf(0x1b270));
    wrf(0x1b268, rdf(0x1b268) + rdf(0x1b274));
    wrf(0x1b26c, rdf(0x1b26c) + rdf(0x1b278));
  };

  // fn_1b8c0(eax, ebx): run part C until song position (start order + eax, row >= ebx). Generator, yields after present.
  HP.fn_1b8c0 = function* (eax, ebx) {
    wr32(0x1ac24, eax); wr32(0x1ac28, ebx);
    let esi = rd32(0xe20);
    const so = rd32(esi + 0x30);
    wr32(0x1b288, so); wr32(0x1ac2c, so);
    wr32(0x1b284, 0);
    {
      const s = rd32(0x1b284);
      wr32(0x1b22c, rd32(s * 4 + 0x1b29c)); wr32(0x1b234, rd32(s * 4 + 0x1b28c));
      wr32(0x1b230, 0); wrf(0x1b228, 0);
    }
    wr32(0x2ee54, 0);
    HP.fill32(rd32(0x1ac34), rd32(rd32(0x1b0ac)), 0x12c00);
    for (;;) {
      // 0x1b938: particles along the 3 paths
      const keep7c = rd32(0x1ac7c);
      {
        let path = rd32(0x1b4a2), rec = rd32(0x1b238), edi = rd32(0x1ac48 + 0x514);
        for (let p = 3; p > 0; p--, path += 0x2d0) {
          for (let c = 0x55; c > 0; c--, rec += 0x10, edi += 0x2c) {
            wr32(0x28c9c, 0);
            HP.fn_28ca4(rec, 3, path + 0x18);                                    // (ebx, ecx, edi)
            wr32(edi + 4, rd32(0x28c74)); wr32(edi + 8, rd32(0x28c78)); wr32(edi + 0xc, rd32(0x28c7c));
            wr32(0x1ac44, -0xa); wrf(edi + 0x20, -10);
          }
        }
      }
      wr32(0x1ac7c, keep7c);
      {
        const edi = rd32((rd32(0x1b284) & 3) * 4 + 0x1b2ac);
        wr32(0x28c9c, 1);
        HP.fn_2afd3(0x1b228, 0x1b160, edi, 0x1ac48);                             // (ebx, esi, edi, ebp)
      }
      wr32(0x1acb8, rd32(0x1b160)); wr32(0x1acbc, rd32(0x1b164)); wr32(0x1acc0, rd32(0x1b168));
      wr32(0x1acc4, rd32(0x1b16c)); wr32(0x1acc8, rd32(0x1b170)); wr32(0x1accc, rd32(0x1b174));
      HP.fn_2a2ac(0x1b160, 0x1ac48, rd32(0x1ac34));                              // (esi=camera, ebp=object, edi=buffer) — engine's signature order
      wr16(0xbc, rd16(0x1b4a0));
      {
        let v = Math.sin(rdf(0x1b264) * rdf(0x1b27c));
        v = v * Math.sin(rdf(0x1b26c) * rdf(0x1b27c));
        v = v * rdf(0x1b25c) + rdf(0x1b260);
        const r = roundHalfEven(v) | 0;
        wr32(0x1b254, r);
        const old = rds32(0x1b254); wr32(0x1b254, 0xff - old); wr32(0x1b258, old);
        HP.fn_18135(rd32(0x1b258), rd32(0x1b254), rd32(0x1ac34));               // (ecx, edx, edi)
      }
      esi = rd32(0xe20);
      if (rds32(esi + 0x30) >= 0x10 && rds32(esi + 0x34) >= 0x3a) {
        wr32(0x1b280, (rd32(0x1b280) + 1) & 1);
        if (rd32(0x1b280) !== 0) {
          const M32 = HP.M32; let p = rd32(0x1ac34) >> 2;
          for (let c = 0x12c00; c > 0; c--, p++) M32[p] = (M32[p] >>> 1) & 0x7f7f7f;
        }
      }
      HP.fn_2b0a8(rd32(0x1ac34), 0x1ac48);                                       // present (esi=buffer, ebp=object)
      yield;
      wr32(0x1ac30, 1);
      let n = Math.trunc((rds32(0x28e28) + 1) / 0xe);
      for (; n > 0; n--) HP.fn_1bb90();
      HP.fill32(rd32(0x1ac34), rd32(rd32(0x1b0ac)), 0x12c00);
      if (rd8(0x9c9) === 1) { wr32(0x1084, 1); return; }
      esi = rd32(0xe20);
      if (rds32(esi + 0x30) < rds32(0x1ac2c) + rds32(0x1ac24)) continue;
      if (rds32(esi + 0x34) < rds32(0x1ac28)) continue;
      return;
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
