# Reference run WITH the int-trap logging (self-consistent timing): PNGs, frames.jsonl, snapshots every 100 frames,
# readlog.bin (site, frame, order, row, tick at every effect-side [0xe20] read), audio.wav -> fullR/
import struct, json, os, zlib, sys
from emu_trace import TEmu, BASE32
from emu import write_png
from unicorn.x86_const import *
OUT = sys.argv[1] if len(sys.argv) > 1 else 'fullR'
os.makedirs(OUT, exist_ok=True)
sites = [int(x, 16) for x in open('sync_sites.txt').read().split()]
class RL(TEmu):
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.patched = False; self.out = open(OUT + '/readlog.bin', 'wb'); self.nreads = 0
    def patch(self):
        for s in sites:
            assert bytes(self.mu.mem_read(BASE32 + s, 6)) == bytes.fromhex('8b35200e0000'), hex(s)
            self.mu.mem_write(BASE32 + s, bytes.fromhex('cdf090909090'))
        # noise routine entry 0x1579c: 'mov dword [0x143e5],1' (10 bytes) -> int 0F2h + 8 nops; log RNG/glitch state there
        assert bytes(self.mu.mem_read(BASE32 + 0x1579c, 10)) == bytes.fromhex('c705e543010001000000')
        self.mu.mem_write(BASE32 + 0x1579c, bytes.fromhex('cdf2') + b'\x90' * 8)
        self.glog = open(OUT + '/glitchlog.bin', 'wb')
        self.patched = True
    def hook_intr(self, uc, intno, user):
        cs = self.r(UC_X86_REG_CS)
        if cs == 8 and not self.patched: self.patch()
        if cs == 8 and intno == 0xf2:
            self.wr32(0x143e5, 1)
            self.glog.write(struct.pack('<IIIII', self.nframe, self.rd32(0x28e38), self.rd32(0x28e3c), self.rd32(0x2ee60), self.rd32(0x144fc)))
            return
        if cs == 8 and intno == 0xf0:
            p = self.rd32(0xe20); self.w(UC_X86_REG_ESI, p)
            eip = self.r(UC_X86_REG_EIP) - 2
            self.out.write(struct.pack('<IIIII', eip, self.nframe, self.rd32(p + 0x30), self.rd32(p + 0x34), self.rd32(p + 0x23)))
            self.nreads += 1
            return
        return super().hook_intr(uc, intno, user)
e = RL(cmdline="", instr_per_sec=30_000_000, frame_log=OUT + '/frames.jsonl')
e.coverage = set()
def cb(em, meta):
    fr = em.grab_frame()
    if fr: write_png("%s/f%05d.png" % (OUT, meta['frame']), *fr)
    if meta['frame'] % 100 == 0: open("%s/snap%05d.bin.z" % (OUT, meta['frame']), 'wb').write(zlib.compress(em.snapshot(), 3))
e.frame_cb = cb
e.run(max_seconds=260.0)
e.out.close()
if hasattr(e, 'glog'): e.glog.close()
e.save_wav(OUT + '/audio.wav')
print("reads", e.nreads, "frames", e.nframe)
