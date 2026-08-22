// minimal PNG encode/decode for node (8-bit RGB / RGBA, non-interlaced), used by the validation scripts
'use strict';
const zlib = require('zlib');
const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}
// rgb: Uint8Array w*h*3
function encodeRGB(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; Buffer.from(rgb.buffer, rgb.byteOffset + y * w * 3, w * 3).copy(raw, y * (w * 3 + 1) + 1); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}
// returns {w, h, rgb: Uint8Array(w*h*3)}
function decode(buf) {
  let p = 8, w = 0, h = 0, bpp = 0, ct = 0; const idat = [];
  while (p < buf.length) {
    const len = buf.readUInt32BE(p); const type = buf.toString('ascii', p + 4, p + 8); const data = buf.subarray(p + 8, p + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); const bd = data[8]; ct = data[9]; if (bd !== 8 || data[12] !== 0) throw new Error('unsupported png'); bpp = ct === 2 ? 3 : ct === 6 ? 4 : ct === 0 ? 1 : 0; if (!bpp) throw new Error('unsupported color type ' + ct); }
    else if (type === 'IDAT') idat.push(data);
    p += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp, out = new Uint8Array(w * h * 3);
  let prev = new Uint8Array(stride), cur = new Uint8Array(stride);
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]; const row = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0; let v = row[i];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1; else if (f === 4) { const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c); v += (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c); }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < w; x++) { out[(y * w + x) * 3] = cur[x * bpp]; out[(y * w + x) * 3 + 1] = cur[x * bpp + (bpp > 1 ? 1 : 0)]; out[(y * w + x) * 3 + 2] = cur[x * bpp + (bpp > 1 ? 2 : 0)]; }
    const t = prev; prev = cur; cur = t;
  }
  return { w, h, rgb: out };
}
// BGRX dword buffer (as in the intro's back buffers / LFB) -> rgb
function bgrxToRGB(bytes, w, h) { const out = new Uint8Array(w * h * 3); for (let i = 0, j = 0; i < w * h * 4; i += 4, j += 3) { out[j] = bytes[i + 2]; out[j + 1] = bytes[i + 1]; out[j + 2] = bytes[i]; } return out; }
module.exports = { encodeRGB, decode, bgrxToRGB, crc32 };
