# Mockup asset pipeline (not production). Renders OHOL people/objects with
# transparent backgrounds by rendering on white and black and solving for alpha.
# render_lib.py is /tmp/ohol-scripts/render.py with a configurable background and
# a fallback sprite dir (fetch.sh pulls missing object sprites from OneLifeData7).
# Usage: python3 -I build_assets.py OUTDIR jobs.txt; python3 -I scene.py OUTDIR;
#        python3 -I portraits.py ../assets ; bash shots.sh
import sys,os,random
sys.path.insert(0,'/tmp/ohol-design-work')
import render_lib as R
from PIL import Image, ImageChops, ImageDraw, ImageFilter
OUT=sys.argv[1]; os.makedirs(OUT,exist_ok=True)
def matte(oid,age,hair=None,W=200,H=260):
    R.BGC[0]=(255,255,255,255); w=R.render(oid,age,hair,W,H)
    R.BGC[0]=(0,0,0,255); b=R.render(oid,age,hair,W,H)
    w=w.convert('RGB'); b=b.convert('RGB')
    out=Image.new('RGBA',w.size)
    wp=w.load(); bp=b.load(); op=out.load()
    for y in range(H):
        for x in range(W):
            wr,wg,wb=wp[x,y]; br,bg,bb=bp[x,y]
            a=255-((wr-br)+(wg-bg)+(wb-bb))//3
            a=max(0,min(255,a))
            if a==0: op[x,y]=(0,0,0,0); continue
            op[x,y]=(min(255,br*255//a),min(255,bg*255//a),min(255,bb*255//a),a)
    bb=out.getbbox()
    return out.crop(bb) if bb else out
def hx(h):
    g=h.startswith('g'); h=h.lstrip('g')
    return (g,tuple(int(h[i:i+2],16)/255 for i in (0,2,4)))
jobs=[l.split() for l in open(sys.argv[2]).read().splitlines() if l.strip() and not l.startswith('#')]
for name,oid,age,hair,W,H in jobs:
    im=matte(oid,float(age),None if hair=='-' else hx(hair),int(W),int(H))
    im.save(f'{OUT}/{name}.png'); print(name,im.size)
