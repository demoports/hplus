// wraps the part run functions to log the frame number at which each starts/ends (replay.js with PARTLOG=1)
const HP = globalThis.HP;
for (const n of ['fn_15c18', 'fn_182fc', 'fn_1b8c0', 'fn_1d566', 'fn_1ffe5', 'fn_236ef']) {
  const f = HP[n];
  HP[n] = function* (...a) { console.log('PART ' + n + ' starts at frame ' + ((globalThis.__nframe || 0) + 1) + ' args ' + a.join(',')); yield* f.apply(this, a); console.log('PART ' + n + ' ends after frame ' + (globalThis.__nframe || 0)); };
}
