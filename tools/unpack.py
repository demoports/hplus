# Emulate the WWPACK real-mode stub of HPLUS.EXE in Unicorn and dump the unpacked image.
import struct, sys
from unicorn import *
from unicorn.x86_const import *
from capstone import *

data = open('HPLUS.EXE','rb').read()
(magic, cblp, cp, crlc, cparhdr, minalloc, maxalloc, e_ss, e_sp, csum, e_ip, e_cs, lfarlc, ovno) = struct.unpack('<14H', data[:28])
hdr = cparhdr*16
size = (cp-1)*512 + cblp if cblp else cp*512
img = data[hdr:size]
print("hdr=%x size=%x img=%x cs:ip=%04x:%04x ss:sp=%04x:%04x minalloc=%x maxalloc=%x" % (hdr, size, len(img), e_cs, e_ip, e_ss, e_sp, minalloc, maxalloc))

PSP = 0x1000
LOAD = PSP + 0x10
mu = Uc(UC_ARCH_X86, UC_MODE_16)
mu.mem_map(0, 0x110000)
# PSP
psp = bytearray(256)
psp[0:2] = b'\xcd\x20'
psp[2:4] = struct.pack('<H', 0x9FFF)   # top of memory
psp[0x80] = 0
psp[0x81] = 13
mu.mem_write(PSP*16, bytes(psp))
mu.mem_write(LOAD*16, img)
# BIOS data / ivt: leave zero. Put iret at a known address for interrupts we return from.
IRET_ADDR = 0xF0000
mu.mem_write(IRET_ADDR, b'\xcf')
for i in range(256):
    mu.mem_write(i*4, struct.pack('<HH', 0, 0xF000))

mu.reg_write(UC_X86_REG_CS, LOAD + e_cs)
mu.reg_write(UC_X86_REG_IP, e_ip)
mu.reg_write(UC_X86_REG_SS, LOAD + e_ss)
mu.reg_write(UC_X86_REG_SP, e_sp)
mu.reg_write(UC_X86_REG_DS, PSP)
mu.reg_write(UC_X86_REG_ES, PSP)
mu.reg_write(UC_X86_REG_AX, 0)

md = Cs(CS_ARCH_X86, CS_MODE_16)
state = {'lastcs': None, 'n': 0, 'ints': []}
def hook_intr(uc, intno, user):
    cs = uc.reg_read(UC_X86_REG_CS); ip = uc.reg_read(UC_X86_REG_IP)
    ax = uc.reg_read(UC_X86_REG_AX)
    print("INT %02x at %04x:%04x ax=%04x" % (intno, cs, ip, ax))
    state['ints'].append((intno, cs, ip, ax))
    if intno == 0x21 and (ax>>8) == 0x30:   # DOS version
        uc.reg_write(UC_X86_REG_AX, 0x0005)
        return
    if intno == 0x15 and (ax>>8)==0x88: uc.reg_write(UC_X86_REG_AX, 16384); return
    if len(state["ints"]) > 5: uc.emu_stop()
mu.hook_add(UC_HOOK_INTR, hook_intr)
def hook_block(uc, addr, sz, user):
    cs = uc.reg_read(UC_X86_REG_CS)
    if cs != state['lastcs']:
        ip = uc.reg_read(UC_X86_REG_IP)
        print("block seg change -> %04x:%04x (lin %05x)" % (cs, addr - cs*16, addr))
        state['lastcs'] = cs
mu.hook_add(UC_HOOK_BLOCK, hook_block)
def hook_code(uc, addr, sz, user):
    state['n'] += 1
mu.hook_add(UC_HOOK_CODE, hook_code)
try:
    mu.emu_start((LOAD+e_cs)*16 + e_ip, -1, timeout=20*1000000, count=0)
except UcError as e:
    print("UcError", e)
cs = mu.reg_read(UC_X86_REG_CS); ip = mu.reg_read(UC_X86_REG_IP)
print("stopped at %04x:%04x after %d instrs" % (cs, ip, state['n']))
for r,n in [(UC_X86_REG_AX,'ax'),(UC_X86_REG_BX,'bx'),(UC_X86_REG_CX,'cx'),(UC_X86_REG_DX,'dx'),(UC_X86_REG_SI,'si'),(UC_X86_REG_DI,'di'),(UC_X86_REG_BP,'bp'),(UC_X86_REG_SP,'sp'),(UC_X86_REG_DS,'ds'),(UC_X86_REG_ES,'es'),(UC_X86_REG_SS,'ss')]:
    print(" %s=%04x" % (n, mu.reg_read(r)), end='')
print()
open('mem_dump.bin','wb').write(mu.mem_read(0, 0x110000))

gdtr = mu.reg_read(UC_X86_REG_GDTR); idtr = mu.reg_read(UC_X86_REG_IDTR)
print("GDTR", [hex(x) for x in gdtr], "IDTR", [hex(x) for x in idtr])
gb, gl = gdtr[1], gdtr[2]
g = mu.mem_read(gb, gl+1)
for i in range(0, gl+1, 8):
    e = g[i:i+8]
    lo, hi = struct.unpack('<II', bytes(e))
    base = (lo>>16) | ((hi&0xff)<<16) | (hi & 0xff000000)
    limit = (lo & 0xffff) | (hi & 0xf0000)
    if hi & 0x800000: limit = (limit<<12)|0xfff
    typ = (hi>>8)&0xff; flags = (hi>>20)&0xf
    print("  sel %04x base=%08x limit=%08x type=%02x fl=%x" % (i, base, limit, typ, flags))
print("CR0=%x" % mu.reg_read(UC_X86_REG_CR0))
for r,n in [(UC_X86_REG_ESP,'esp'),(UC_X86_REG_EIP,'eip'),(UC_X86_REG_CS,'cs'),(UC_X86_REG_DS,'ds'),(UC_X86_REG_ES,'es'),(UC_X86_REG_FS,'fs'),(UC_X86_REG_GS,'gs'),(UC_X86_REG_SS,'ss')]:
    print(" %s=%x" % (n, mu.reg_read(r)), end='')
print()
# fine-grained nonzero map
m = mu.mem_read(0, 0x110000)
prev=False
for a in range(0, 0x110000, 0x1000):
    nz = any(m[a:a+0x1000])
    if nz != prev:
        print(("start" if nz else "end  ") + " %06x" % a)
        prev = nz
