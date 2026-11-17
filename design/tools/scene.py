import sys, random, math, os
from PIL import Image, ImageDraw, ImageFilter, ImageChops
SRC = '/tmp/ohol-design-work/out'
OUT = sys.argv[1]
random.seed(7)

def ground(W, H, base=(141, 152, 92), seed=3):
    rnd = random.Random(seed)
    im = Image.new('RGB', (W, H), base)
    # large soft colour blotches
    blot = Image.new('L', (W // 8, H // 8))
    bp = blot.load()
    for y in range(blot.height):
        for x in range(blot.width):
            bp[x, y] = rnd.randint(0, 255)
    blot = blot.resize((W, H), Image.BICUBIC).filter(ImageFilter.GaussianBlur(18))
    light = Image.new('RGB', (W, H), (162, 168, 104))
    im = Image.composite(light, im, blot)
    d = ImageDraw.Draw(im, 'RGBA')
    # scratchy hatch strokes, like the OHOL grassland ground
    for _ in range(W * H // 900):
        x, y = rnd.uniform(0, W), rnd.uniform(0, H)
        L = rnd.uniform(5, 14)
        a = rnd.uniform(-1.9, -1.2)
        col = rnd.choice([(70, 84, 40, 120), (92, 104, 52, 140), (60, 70, 34, 90), (180, 182, 120, 90)])
        pts = []
        for k in range(4):
            t = k / 3
            pts.append((x + math.cos(a) * L * t + rnd.uniform(-1, 1), y + math.sin(a) * L * t))
        d.line(pts, fill=col, width=1)
    # grass tufts
    for _ in range(W * H // 9000):
        x, y = rnd.uniform(0, W), rnd.uniform(0, H)
        for k in range(rnd.randint(3, 6)):
            a = -math.pi / 2 + rnd.uniform(-0.7, 0.7)
            L = rnd.uniform(6, 13)
            d.line([(x + k * 2, y), (x + k * 2 + math.cos(a) * L, y + math.sin(a) * L)], fill=(38, 44, 22, 200), width=1)
    # dry dirt patches
    for _ in range(W * H // 60000):
        x, y = rnd.uniform(0, W), rnd.uniform(0, H)
        r = rnd.uniform(25, 60)
        d.ellipse([x - r, y - r * 0.5, x + r, y + r * 0.5], fill=(150, 140, 96, 70))
    return im

def tile(W=512, H=512):
    # seamless-ish: render 3x and crop centre, then blend edges
    g = ground(W * 2, H * 2, seed=11)
    return g.crop((W // 2, H // 2, W // 2 + W, H // 2 + H))

def get(n):
    return Image.open(f'{SRC}/{n}.png')

def scene(W, H, items, seed=3):
    bg = ground(W, H, seed=seed).convert('RGBA')
    items = sorted(items, key=lambda it: it[2])
    for name, x, y, s in items:
        im = get(name)
        if s != 1:
            im = im.resize((int(im.width * s), int(im.height * s)), Image.LANCZOS)
        bg.alpha_composite(im, (int(x - im.width / 2), int(y - im.height)))
    return bg

if __name__ == '__main__':
    os.makedirs(OUT, exist_ok=True)
    tile().save(f'{OUT}/ground-tile.png')
    # main follow-cam scene, focus JOY HOPE in centre
    W, H = 1320, 780
    items = [
        ('maple', 150, 330, 1), ('pine', 1210, 360, 1), ('juniper', 980, 250, 0.9),
        ('bush', 380, 520, 1.35), ('bush', 455, 548, 1.35), ('bush', 330, 590, 1.35),
        ('bush', 1100, 640, 1.35),
        ('rock', 820, 700, 1), ('sharp', 700, 600, 1.6), ('stone', 740, 618, 1.6),
        ('milkweed', 210, 690, 1.1), ('milkweed', 1180, 720, 1.1), ('reeds', 60, 760, 1),
        ('fire', 900, 470, 1),
        ('p_joy_hope', 640, 560, 1), ('p_faith_hope', 720, 572, 1),
        ('p_tomas_hope', 1000, 500, 1), ('p_eve_hope', 520, 430, 1),
    ]
    scene(W, H, items).convert('RGB').save(f'{OUT}/scene-follow.png')
    # map thumbnail-ish wide scene for the site header strip
    items2 = [('maple', 120, 300, 0.8), ('pine', 1500, 300, 0.75), ('juniper', 900, 290, 0.7),
              ('bush', 420, 300, 1), ('bush', 470, 310, 1), ('p_eve_ashgrove', 620, 300, 0.85),
              ('p_wren_ashgrove', 680, 305, 0.85), ('p_joy_hope', 1080, 300, 0.85), ('p_faith_hope', 1140, 305, 0.85),
              ('p_eve_moss', 1300, 300, 0.85), ('milkweed', 300, 310, 0.9), ('rock', 800, 310, 0.9)]
    scene(1600, 320, items2, seed=5).convert('RGB').save(f'{OUT}/scene-strip.png')
    # map thumbnail: top-down-ish biome blobs
    M = 360
    mp = Image.new('RGB', (M, M), (141, 152, 92))
    d = ImageDraw.Draw(mp, 'RGBA')
    rnd = random.Random(4)
    for col, n in [((84, 110, 66), 14), ((196, 178, 120), 8), ((226, 226, 220), 4), ((110, 140, 150), 3)]:
        for _ in range(n):
            x, y, r = rnd.uniform(0, M), rnd.uniform(0, M), rnd.uniform(20, 60)
            d.ellipse([x - r, y - r, x + r, y + r], fill=col + (200,))
    mp = mp.filter(ImageFilter.GaussianBlur(6))
    g = ground(M, M, seed=9)
    mp = Image.blend(mp, g, 0.25)
    mp.save(f'{OUT}/map-thumb.png')
