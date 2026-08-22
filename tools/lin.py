import sys
from capstone import *
img=open(sys.argv[1] if len(sys.argv)>3 else 'image32.bin','rb').read()
a=int(sys.argv[-2],16); e=int(sys.argv[-1],16)
md=Cs(CS_ARCH_X86, CS_MODE_32); md.skipdata=True
for i in md.disasm(img[a:e], a):
    print("%06x: %-20s %s %s" % (i.address, i.bytes.hex(), i.mnemonic, i.op_str))
