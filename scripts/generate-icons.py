from pathlib import Path
from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1] / 'public'
for size in (192, 512):
    image = Image.new('RGB', (size, size), '#7760d5')
    draw = ImageDraw.Draw(image)
    s = size / 512
    points = [(148, 357), (148, 155), (191, 155), (321, 302), (321, 155), (364, 155), (364, 357), (321, 357), (191, 210), (191, 357)]
    draw.polygon([(round(x*s), round(y*s)) for x,y in points], fill='white')
    draw.ellipse(tuple(round(v*s) for v in (347,115,383,151)), fill='#d6c8ff')
    image.save(root / f'icon-{size}.png')
