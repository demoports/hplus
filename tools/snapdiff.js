// node snapdiff.js N [REFDIR]: attribute differing bytes between mysnapN.bin and REFDIR/snapN.bin.z to allocations
'use strict';
const fs = require('fs'), zlib = require('zlib');
const n = +process.argv[2], refdir = process.argv[3] || 'fullT';
const mine = fs.readFileSync('mysnap' + String(n).padStart(5, '0') + '.bin');
const ref = zlib.inflateSync(fs.readFileSync(refdir + '/snap' + String(n).padStart(5, '0') + '.bin.z'));
const allocs = JSON.parse(fs.readFileSync('allocs.json'));
const VOL = [[0, 0x100], [0x31c, 0x330], [0x658, 0x670], [0x9c8, 0xb00], [0xba06, 0xc190], [0x2ee3d, 0x2ee64], [0x2f076, 0x2f300], [0x32800, 0x32c20], [0x3f090, 0x5f090], [0x1283b0, 0x1336f0]];
const vol = (a) => { for (const r of VOL) if (a >= r[0] && a < r[1]) return true; return false; };
const end = Math.min(mine.length, ref.length);
const owner = new Map(); let total = 0; const image = { n: 0, first: [] };
let ai = 0; allocs.sort((a, b) => a[0] - b[0]);
for (let i = 0; i < end; i++) {
  if (mine[i] === ref[i] || vol(i)) continue;
  total++;
  if (i < 0x32c20) { image.n++; if (image.first.length < 30) image.first.push(i.toString(16)); continue; }
  let k = null; for (const a of allocs) if (i >= a[0] && i < a[0] + a[1]) { k = a; break; }
  const key = k ? (k[0].toString(16) + '+' + k[1].toString(16) + ' ' + k[2]) : 'unowned';
  const e = owner.get(key) || { n: 0, first: i, last: i }; e.n++; e.last = i; owner.set(key, e);
}
console.log('total differing (non-volatile):', total, '; in image/BSS:', image.n, image.first.join(' '));
for (const [k, e] of [...owner.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 25)) console.log(String(e.n).padStart(8), k, 'first ' + e.first.toString(16) + ' last ' + e.last.toString(16));
