import sys
from capstone import *
img=open('image16.bin','rb').read()
a=int(sys.argv[1],16); e=int(sys.argv[2],16)
md=Cs(CS_ARCH_X86, CS_MODE_16); md.skipdata=True
for i in md.disasm(img[a:e], a):
    print("%04x: %-20s %s %s" % (i.address, i.bytes.hex(), i.mnemonic, i.op_str))
