#!/usr/bin/env python3
"""Generate simple extension icons using PIL"""
import os

try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print("Installing Pillow...")
    os.system("pip install Pillow -q")
    from PIL import Image, ImageDraw, ImageFont

def create_icon(size):
    img = Image.new('RGBA', (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # Background gradient simulation
    for y in range(size):
        r = int(102 + (118 - 102) * y / size)
        g = int(126 + (75 - 126) * y / size)
        b = int(234 + (162 - 234) * y / size)
        draw.line([(0, y), (size, y)], fill=(r, g, b, 255))

    # Draw "CC" or subtitle symbol
    margin = size // 6
    box_w = size - margin * 2
    box_h = size // 2
    box_y = (size - box_h) // 2

    # Rounded rectangle background
    draw.rounded_rectangle(
        [margin, box_y, size - margin, box_y + box_h],
        radius=size // 10,
        fill=(255, 255, 255, 220)
    )

    # Text
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", size=size//3)
    except:
        font = ImageFont.load_default()

    text = "译"
    bbox = draw.textbbox((0, 0), text, font=font)
    text_w = bbox[2] - bbox[0]
    text_h = bbox[3] - bbox[1]
    text_x = (size - text_w) // 2
    text_y = box_y + (box_h - text_h) // 2 - bbox[1]

    draw.text((text_x, text_y), text, fill=(30, 30, 60, 255), font=font)

    return img

if __name__ == '__main__':
    for s in [16, 48, 128]:
        icon = create_icon(s)
        icon.save(f'icon{s}.png')
        print(f"Created icon{s}.png")
