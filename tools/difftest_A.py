# capture function-level differential test pairs for part A's pure functions
import sys, os, json, zlib, struct
from emu_trace import TEmu, BASE32
from unicorn.x86_const import *
OUT = 'fxA_tests'; os.makedirs(OUT, exist_ok=True)
WANT = {0x1545e: 4, 0x15508: 4, 0x1570b: 3, 0x1574e: 2, 0x15660: 2, 0x155b3: 1, 0x15646: 1, 0x156ff: 2, 0xe1cc: 1, 0xe27a: 3}
hits = {k: 0 for k in WANT}
e = TEmu(cmdline="", instr_per_sec=30_000_000)
pending = {}
def mk(off):
    def cb(em):
        if hits[off] >= WANT[off]: return
        n = hits[off]; hits[off] += 1
        regs = em.regs(); ret = em.ret_addr()
        before = em.snapshot()
        tag = "%x_%d" % (off, n)
        open("%s/%s_before.bin.z" % (OUT, tag), 'wb').write(zlib.compress(before, 1))
        def after(em2):
            r2 = em2.regs()
            open("%s/%s_after.bin.z" % (OUT, tag), 'wb').write(zlib.compress(em2.snapshot(), 1))
            json.dump(dict(fn=off, regs_in=regs, regs_out=r2, ret=ret), open("%s/%s.json" % (OUT, tag), 'w'))
            print("captured", tag, flush=True)
        em.bp_once(ret, after)
    return cb
for off in WANT: e.bp(off, mk(off))
e.run(max_seconds=8.0, until=lambda em: all(hits[k] >= WANT[k] for k in WANT))
print(hits)
