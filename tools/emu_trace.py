# Tracing/snapshot extension of emu.Emu for differential testing of the JS port.
#
#   from emu_trace import TEmu
#   e = TEmu(cmdline="")                 # same args as Emu
#   e.bp(0x2a2ac, lambda em: ...)       # breakpoint at 32-bit offset (callback gets the TEmu)
#   e.snapshot() -> bytes                # program memory: offsets [0, HEAP_END) of the 32-bit segment
#   e.run(max_seconds=..)
#
# Per-frame metadata: pass frame_log='file.jsonl' to the constructor; each VBE display-start
# (present) appends {frame, t, dt(=[0x28e28]), ms(=[0x2ee54]), order,row,tick, rng:[s1,s2], lo,hi}.
#
# CLI:  ./venv/bin/python -u emu_trace.py OUTDIR SECONDS [SNAP_EVERY_N_FRAMES] [cmdline]
#   writes OUTDIR/frames.jsonl, OUTDIR/fNNNNN.png (every frame), OUTDIR/snapNNNNN.bin.z (zlib'd
#   snapshot taken right at present time, every N frames), OUTDIR/audio.wav, OUTDIR/coverage.txt
import struct, sys, os, json, zlib, time
from unicorn import *
from unicorn.x86_const import *
from emu import Emu, BASE32, LFB_PHYS, write_png

HEAP_END_DEFAULT = 0x1100000 - BASE32   # end of emulated RAM in 32-bit-segment offsets

class TEmu(Emu):
    def __init__(self, *a, frame_log=None, **kw):
        super().__init__(*a, **kw)
        self._bps = {}
        self.frame_log = open(frame_log, 'w') if frame_log else None
        self.nframe = 0
        self.frame_cb = None      # called as frame_cb(self, meta) at each present, after logging
        self._ret_bps = []
        super_flip = None
        self.on_vbe_flip = self._on_flip

    # ---- breakpoints at 32-bit code offsets
    def bp(self, off, cb):
        lin = BASE32 + off
        def h(uc, addr, size, user):
            cb(self)
        self._bps[off] = self.mu.hook_add(UC_HOOK_CODE, h, None, lin, lin)
    def unbp(self, off):
        h = self._bps.pop(off, None)
        if h is not None: self.mu.hook_del(h)
    def bp_once(self, off, cb):
        def once(em):
            self.unbp(off); cb(em)
        self.bp(off, once)
    def ret_addr(self):
        esp = self.r(UC_X86_REG_ESP)
        return struct.unpack('<I', self.mu.mem_read(BASE32 + esp, 4))[0]
    def regs(self):
        R = UC_X86_REG_EAX, UC_X86_REG_EBX, UC_X86_REG_ECX, UC_X86_REG_EDX, UC_X86_REG_ESI, UC_X86_REG_EDI, UC_X86_REG_EBP, UC_X86_REG_ESP, UC_X86_REG_EFLAGS
        v = [self.r(x) for x in R]
        return dict(zip(['eax','ebx','ecx','edx','esi','edi','ebp','esp','eflags'], v))
    def fpu(self):
        # x87 stack as python floats (ST0..ST7), from the 80-bit registers
        out = []
        for i in range(8):
            raw = self.r(UC_X86_REG_ST0 + i)
            out.append(raw)
        return out

    # ---- memory
    def heap_end(self):
        return self.rd32(8)            # current himem alloc pointer (offset)
    def snapshot(self, end=None):
        end = end or min(self.heap_end(), HEAP_END_DEFAULT)
        return bytes(self.mu.mem_read(BASE32, end))
    def player_pos(self):
        p = self.rd32(0xe20)
        if p == 0: return (0, 0, 0)
        return (self.rd32(p + 0x30), self.rd32(p + 0x34), self.rd32(p + 0x23))

    # ---- per-frame
    def frame_meta(self):
        o, r, t = self.player_pos()
        return dict(frame=self.nframe, t=round(self.ticks / self.instr_per_sec, 4), dt=self.rd32(0x28e28), ms=self.rd32(0x2ee54),
                    order=o, row=r, tick=t, rng=[self.rd32(0x28e38), self.rd32(0x28e3c)], lo=self.rd32(0), hi=self.rd32(8),
                    disp=list(self.display_start) if isinstance(self.display_start, tuple) else [0, 0])
    def _on_flip(self, em, x, y):
        self.nframe += 1
        meta = self.frame_meta()
        if self.frame_log:
            self.frame_log.write(json.dumps(meta) + '\n'); self.frame_log.flush()
        if self.frame_cb: self.frame_cb(self, meta)

if __name__ == '__main__':
    outdir = sys.argv[1]; secs = float(sys.argv[2])
    snap_every = int(sys.argv[3]) if len(sys.argv) > 3 else 0
    cmdline = sys.argv[4] if len(sys.argv) > 4 else ""
    os.makedirs(outdir, exist_ok=True)
    e = TEmu(cmdline=cmdline, instr_per_sec=30_000_000, frame_log=os.path.join(outdir, 'frames.jsonl'))
    e.coverage = set()
    def cb(em, meta):
        fr = em.grab_frame()
        if fr: write_png("%s/f%05d.png" % (outdir, meta['frame']), *fr)
        if snap_every and meta['frame'] % snap_every == 0:
            open("%s/snap%05d.bin.z" % (outdir, meta['frame']), 'wb').write(zlib.compress(em.snapshot(), 3))
    e.frame_cb = cb
    e.run(max_seconds=secs)
    e.save_wav(os.path.join(outdir, 'audio.wav'))
    open(os.path.join(outdir, 'coverage.txt'), 'w').write('\n'.join('%x' % a for a in sorted(e.coverage)))
    print("frames:", e.nframe, "heap end: %x" % e.heap_end(), "lomem: %x" % e.rd32(0))
