import sys, glob, os, shutil
from PIL import Image
SRC = '/tmp/ohol-design-work/out'
DST = sys.argv[1]
os.makedirs(f'{DST}/people', exist_ok=True)
os.makedirs(f'{DST}/world', exist_ok=True)
for f in glob.glob(f'{SRC}/p_*.png'):
    n = os.path.basename(f)[2:-4].replace('_', '-')
    im = Image.open(f)
    im.save(f'{DST}/people/{n}-body.png')
    # head crop: square from top of figure; babies' head sits lower
    side = 92
    cx = im.width // 2
    top = 0
    box = (cx - side // 2, top, cx + side // 2, top + side)
    head = Image.new('RGBA', (side, side), (0, 0, 0, 0))
    head.alpha_composite(im.crop(box))
    head.resize((side * 2, side * 2), Image.LANCZOS).save(f'{DST}/people/{n}-head.png')
for n in ['scene-follow', 'scene-strip', 'map-thumb', 'ground-tile', 'bush', 'maple', 'pine', 'juniper', 'sharp', 'fire', 'milkweed']:
    shutil.copy(f'{SRC}/{n}.png', f'{DST}/world/{n}.png')
