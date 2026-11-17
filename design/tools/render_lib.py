# usage: render.py DATA OUT.png age objId[:hairHex] ...
import sys,os,math
from PIL import Image, ImageChops
data='/tmp/ohol-art/repo'
BGC=[(235,225,200,255)]
def sprmeta(i):
    t=open(f'{data}/sprites/{i}.txt').read().split()
    return t[0],t[1]=='1',int(t[2]),int(t[3])
def parse(oid):
    L=open(f'{data}/objects/{oid}.txt').read().splitlines(); spr=[];cur=None;meta={}
    for l in L:
        if l.startswith('spriteID='): cur={'id':int(l[9:])}; spr.append(cur); continue
        if l.startswith(('headIndex','bodyIndex','backFootIndex','frontFootIndex')):
            k,v=l.split('=');meta[k]=[int(x) for x in v.split(',')]; continue
        if cur is None: continue
        if l.startswith('pos='): cur['pos']=tuple(map(float,l[4:].split(',')))
        elif l.startswith('rot='): cur['rot']=float(l[4:])
        elif l.startswith('hFlip='): cur['hf']=l[6:]=='1'
        elif l.startswith('color='): cur['col']=tuple(map(float,l[6:].split(',')))
        elif l.startswith('ageRange='): cur['age']=tuple(map(float,l[9:].split(',')))
        elif l.startswith('parent='): cur['par']=int(l[7:])
    return meta,spr
def vis(s,a): 
    st,en=s['age']; return (st==-1 and en==-1) or (st<=a<en)
def top(meta,spr,key,a):
    c=[i for i in meta.get(key,[]) if vis(spr[i],a)]; return max(c) if c else 0
def anc(spr,i,t):
    p=spr[i]['par']
    while p!=-1:
        if p==t: return True
        p=spr[p]['par']
    return False
def isface(i,kind):
    n=sprmeta(i)[0]
    return ('Hair' in n or 'Beard' in n or 'hair' in n) if kind=='hair' else ('Eyes' in n or 'Mouth' in n)
def graft(meta,spr,donor,kind):
    dm,ds=parse(donor)
    hi=meta['headIndex'][0]; dh=dm['headIndex'][0]
    dx=spr[hi]['pos'][0]-ds[dh]['pos'][0]; dy=spr[hi]['pos'][1]-ds[dh]['pos'][1]
    keep=[s for s in spr if not isface(s['id'],kind)]
    # remap: removed sprites may be parents; just attach grafts to head
    idmap={id(s):k for k,s in enumerate(keep)}
    old=spr
    for s in keep:
        if s['par']!=-1: s['par']=idmap.get(id(old[s['par']]), keep.index(old[hi]) if True else -1)
    nh=keep.index(old[hi])
    add=[dict(s,pos=(s['pos'][0]+dx,s['pos'][1]+dy),par=nh) for s in ds if isface(s['id'],kind)]
    new=keep[:nh+1]+add+keep[nh+1:]
    for s in new:
        pass
    # recompute meta indices
    m={}
    for k in ('headIndex','bodyIndex','backFootIndex','frontFootIndex'):
        m[k]=[new.index(old[i]) if old[i] in keep else 0 for i in meta[k]]
    # parents of kept sprites shift by len(add) if they point after head
    for s in keep:
        if s['par']>nh: s['par']+=len(add)
    return m,new
def render(oid,a,hair=None,W=200,H=260):
    parts=oid.split('/')
    meta,spr=parse(parts[0])
    if len(parts)>1 and parts[1]: meta,spr=graft(meta,spr,parts[1],'hair')
    if len(parts)>2 and parts[2]: meta,spr=graft(meta,spr,parts[2],'face')
    if len(parts)>3 and parts[3]:
        col=[s['col'] for s in parse(parts[3])[1] if sprmeta(s['id'])[0]=='HeadWhite'][0]
        for s in spr:
            if sprmeta(s['id'])[0] in ('HeadWhite','BodyWhite','BreastsFill','Penis1Fill','Penis2Fill'): s['col']=col
    hi=top(meta,spr,'headIndex',a); bi=top(meta,spr,'bodyIndex',a); ff=top(meta,spr,'frontFootIndex',a)
    hp,bp,fp=spr[hi]['pos'],spr[bi]['pos'],spr[ff]['pos']
    def headoff():
        if a<20: return (0,round(-((20-a)/20)*0.6*(hp[1]-bp[1])))
        if a>=40:
            aa=min(a,60); return (round((aa-40)/20*2*(fp[0]-hp[0])), round(-(aa-40)/20*0.35*(hp[1]-bp[1])))
        return (0,0)
    def bodyoff(): return (0,round(-((20-a)/20)*0.75*bp[1])) if a<20 else (0,0)
    canvas=Image.new('RGBA',(W,H),BGC[0])
    ox,oy=W/2,H-20
    for i,s in enumerate(spr):
        if not vis(s,a): continue
        x,y=s['pos']
        if i==hi or anc(spr,i,hi): d=headoff(); x+=d[0]; y+=d[1]
        if i==hi or anc(spr,i,bi): d=bodyoff(); x+=d[0]; y+=d[1]
        name,mult,ax,ay=sprmeta(s['id'])
        im=Image.open(f"{data}/sprites/{s['id']}.tga" if os.path.exists(f"{data}/sprites/{s['id']}.tga") else f"/tmp/ohol-design-work/sprites/{s['id']}.tga").convert('RGBA')
        col=s['col']
        if hair and ('Hair' in name or 'Beard' in name):
            col=hair[1]
            if hair[0]:
                r,g,b,al=im.split(); l=Image.merge('RGB',(r,g,b)).convert('L').point(lambda v:min(255,int(v*1.8)))
                im=Image.merge('RGBA',(l,l,l,al))
        if col!=(1,1,1):
            r,g,b,al=im.split()
            r=r.point(lambda v:int(v*col[0])); g=g.point(lambda v:int(v*col[1])); b=b.point(lambda v:int(v*col[2]))
            im=Image.merge('RGBA',(r,g,b,al))
        if s['hf']: im=im.transpose(Image.FLIP_LEFT_RIGHT); ax=-ax
        # image centre in world (y-up) = anchor - (ax, -ay); rotate about anchor
        w,h=im.size
        pad=Image.new('RGBA',(w+2*abs(ax)*2+4,h+2*abs(ay)*2+4),(0,0,0,0))
        pw,ph=pad.size
        # place image so that its anchor point (image centre + (ax,ay) in image coords) sits at pad centre
        pad.paste(im,(int(pw/2-w/2-ax),int(ph/2-h/2-ay)))
        if s['rot']: pad=pad.rotate(-360*s['rot'],resample=Image.BICUBIC)  # positive rot = clockwise
        px,py=ox+x-pw/2, oy-y-ph/2
        if mult:
            layer=Image.new('RGBA',canvas.size,(255,255,255,0)); layer.paste(pad,(int(px),int(py)),pad)
            white=Image.new('RGBA',canvas.size,(255,255,255,255)); white.alpha_composite(layer)
            canvas=ImageChops.multiply(canvas,white)
        else:
            layer=Image.new('RGBA',canvas.size,(0,0,0,0)); layer.paste(pad,(int(px),int(py)))
            canvas.alpha_composite(layer)
    return canvas
