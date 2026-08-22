// WWPACK (the variant used by HPLUS.EXE) decompressor, ported from the 16-bit stub.
// unpackWWP(exeBytes) -> Uint8Array of the unpacked program image as it would sit in memory at the load
// segment (offset 0 = first byte after the MZ header, i.e. what PMODE's 16-bit stub sees at 1010:0000).
(function (root) {
  'use strict';
  function unpackWWP(exe) {
    const u8 = exe instanceof Uint8Array ? exe : new Uint8Array(exe);
    const hdrParas = u8[8] | (u8[9] << 8);
    const hdr = hdrParas * 16;
    if (!(u8[0] === 0x4d && u8[1] === 0x5a) || String.fromCharCode(u8[hdr - 4], u8[hdr - 3], u8[hdr - 2]) !== 'WWP') throw new Error('not a WWPACK exe');
    // the first stub (at image offset 0) copies the packed stream + decompressor away; the stream starts at image
    // offset 0x3b + 5 = 0x40 (file hdr+0x40). Output grows from image offset 0.
    const IN0 = hdr + 0x40;
    const out = new Uint8Array(0x40000);      // plenty (196326 bytes for hplus)
    let si = IN0, di = 0;
    let bp = 0, bh = 0;                         // 16-bit bit buffer (MSB first) and count of valid bits
    const mtf = new Uint8Array(256); let gen = 0xff;   // "recent distinct byte" table + generation counter (cx)
    let cf = 0;
    const lodsw = () => { const v = u8[si] | (u8[si + 1] << 8); si += 2; return v; };
    function getbits(n) {                      // 0x82
      let ax = (bp >>> (16 - n)) & 0xffff;
      let rem = bh - n;
      if (rem > 0) { bp = (bp << n) & 0xffff; bh = rem; return ax; }
      if (rem === 0) { bp = lodsw(); bh = 16; return ax; }
      const s = -rem;                            // shortage
      const w = lodsw();
      bp = (w << s) & 0xffff;
      ax = (ax + (w >>> (16 - s))) & 0xffff;
      bh = 16 - s;
      return ax;
    }
    function getbit() {                        // 0xb5: returns the bit (CF)
      const b = (bp >>> 15) & 1; bp = (bp << 1) & 0xffff; bh--;
      if (bh === 0) { bp = lodsw(); bh = 16; }
      return b;
    }
    // entry 0xbc
    bp = lodsw(); bh = 16; cf = 0;
    for (;;) {
      if (!cf) {
        // literal run
        for (;;) {
          out[di++] = u8[si++];
          cf = (bp >>> 15) & 1; bp = (bp << 1) & 0xffff; bh--;
          if (!cf && bh !== 0) continue;
          if (bh === 0) { bp = lodsw(); bh = 16; }
          if (!cf) continue;   // refilled, bit was 0 -> literal again
          break;
        }
      }
      // match / special (0xcc)
      const code = getbits(2);
      if (code === 2) {                          // MTF literal (0xd7)
        let ax = getbits(4);
        gen = (gen + 1) & 0xff;                  // inc cl (cx low byte; cx high byte is 0 here)
        if (gen === 0) { mtf.fill(0); gen = 1; }
        let p = di, b = 0;
        for (;;) {
          p--; b = p >= 0 ? out[p] : 0;
          if (mtf[b] === gen) continue;
          mtf[b] = gen;
          if (--ax < 0) break;
        }
        out[di++] = b;
        cf = (bp >>> 15) & 1; bp = (bp << 1) & 0xffff; bh--;            // 0xc4
        if (bh === 0) { bp = lodsw(); bh = 16; }
        continue;
      }
      let len, dist;
      if (code === 3) {                          // length-2 match (0x114)
        let al = getbits(2);
        let cl, dx;
        if (al === 0) { cl = 5; dx = (1 << 5) - 0x1f; }
        else if (al === 1) { cl = 6; dx = (1 << 6) - 0x1f; }
        else { cl = al + 6; dx = ((1 << cl) - 0x9f) & 0xffff; }
        let ax = getbits(cl);
        if (ax === 0x1ff) {                      // end marker / segment adjust (0x1ef)
          if (getbit() === 0) break;             // end of stream
          // segment normalization: no-op in flat memory
          cf = (bp >>> 15) & 1; bp = (bp << 1) & 0xffff; bh--;       // jmp 0x1ec -> 0xc4
          if (bh === 0) { bp = lodsw(); bh = 16; }
          continue;
        }
        dist = (ax + dx) & 0xffff; len = 2;
      } else {                                   // code 0 or 1 (0x146)
        const zf = (code === 0);
        let al = getbits(3), cl, ax;
        let special = false;
        if (al < 3) cl = al + 5;
        else if (al === 3) cl = 8 + getbit();
        else if (al === 4) cl = 10 + getbit();
        else { cl = al + 7; if (cl === 14) { ax = (getbits(15) + 0x3fe1) & 0xffff; special = true; } }
        if (!special) { const dx = ((1 << cl) - 0x1f) & 0xffff; ax = (getbits(cl) + dx) & 0xffff; }
        dist = ax;
        if (!zf) len = 3;
        else {
          if (getbit() === 0) len = 4 + getbit();
          else {
            let v = getbits(3);
            if (v !== 0) len = v + 5;
            else {
              v = getbits(4);
              if (v !== 0) len = v + 12;
              else {
                let c = 4, dx = 0xc;
                for (;;) {
                  if (c === 7) { len = getbits(14); break; }
                  dx = (dx + 2) * 2;
                  const b = getbit(); c++;
                  if (b) { len = (getbits(c) + (dx & 0xff)) & 0xff; break; }   // add al,dl
                }
              }
            }
          }
        }
      }
      // copy (0x1e0)
      let src = di - dist;
      for (let k = 0; k < len; k++) out[di++] = out[src++];
      cf = (bp >>> 15) & 1; bp = (bp << 1) & 0xffff; bh--;                // 0xc4
      if (bh === 0) { bp = lodsw(); bh = 16; }
    }
    return out.subarray(0, di);
  }
  (root.HP || (root.HP = {})).unpackWWP = unpackWWP;
  if (typeof module !== 'undefined') module.exports = { unpackWWP };
})(typeof globalThis !== 'undefined' ? globalThis : this);
