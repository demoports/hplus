// node difftest_A.js [DIR]  — run captured (before, regs) -> (after) pairs through the JS port of part A's functions
'use strict';
const fs = require('fs'), zlib = require('zlib'), path = require('path');
require('./hplus_core.js'); require('./hplus_main.js'); require('./hplus_fxA.js');
const HP = globalThis.HP;
const DIR = process.argv[2] || 'fxA_tests';
const image = HP.loadImageNode('image32.bin');
const CALL = {
  0x1545e: r => HP.fn_1545e(r.edx, r.ebp, r.esi, r.edi),
  0x15508: r => HP.fn_15508(r.edx, r.ebp, r.edi),
  0x1570b: r => HP.fn_1570b(r.esi, r.ebp),
  0x1574e: r => HP.fn_1574e(r.ebp, r.edi),
  0x15660: r => ({ edi: HP.fn_15660(r.eax, r.ebx, r.edi) }),
  0x155b3: r => ({ edi: HP.fn_155b3(r.edi) }),
  0x15646: r => ({ edi: HP.fn_15646(r.edi) }),
  0x156ff: r => ({ edi: HP.fn_156ff(r.esi, r.edi) }),
  0xe1cc: r => HP.fn_e1cc(),
  0xe27a: r => HP.fn_e27a(r.ebx, r.ecx, r.edx),
};
let pass = 0, fail = 0;
for (const f of fs.readdirSync(DIR).filter(x => x.endsWith('.json')).sort()) {
  const t = JSON.parse(fs.readFileSync(path.join(DIR, f)));
  const before = zlib.inflateSync(fs.readFileSync(path.join(DIR, f.replace('.json', '_before.bin.z'))));
  const after = zlib.inflateSync(fs.readFileSync(path.join(DIR, f.replace('.json', '_after.bin.z'))));
  HP.init(image); HP.M.set(before, 0);
  const ret = CALL[t.fn](t.regs_in) || {};
  const M = HP.M; const n = Math.min(after.length, M.length);
  const volatile = (a) => (a >= 0x32800 && a < 0x32c20) || (a >= 0x2ee50 && a < 0x2ee64) || (a >= 0x2ee3d && a < 0x2ee4d) || (a >= 0x3f090 && a < 0x5f090) || (a >= 0x1283b0 && a < 0x1336f0) || (a >= 0x1336f0 - 0x3c00 && a < 0x1336f0);
  let ranges = [], start = -1, count = 0;
  for (let i = 0; i < n; i++) {
    const d = M[i] !== after[i] && !volatile(i);
    if (d && start < 0) start = i;
    if (!d && start >= 0) { ranges.push([start, i]); start = -1; }
    if (d) count++;
  }
  if (start >= 0) ranges.push([start, n]);
  let regok = true;
  for (const k of Object.keys(ret)) if ((ret[k] >>> 0) !== (t.regs_out[k] >>> 0)) regok = false;
  const ok = count === 0 && regok;
  if (ok) pass++; else fail++;
  console.log(`${f}: ${ok ? 'OK' : 'FAIL'} (${count} bytes differ${ranges.length ? ': ' + ranges.slice(0, 8).map(r => r[0].toString(16) + '-' + r[1].toString(16)).join(' ') : ''}${regok ? '' : '; return regs differ ' + JSON.stringify(ret) + ' vs ' + JSON.stringify(t.regs_out)})`);
}
console.log(`pass ${pass} fail ${fail}`);
