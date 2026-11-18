"""Compose the README figures from the raw CDP captures.

Captures were taken at deviceScaleFactor 2, so everything is emitted at that
native resolution and the README asks the browser to display it at half size.
That keeps the screenshots crisp on high-DPI screens instead of soft.
"""
import os
from PIL import Image, ImageDraw, ImageFont

SRC = "plugins/spell-suggestions/.shots/final"
OUT = "plugins/spell-suggestions/assets"

FONT_PATHS = ["C:/Windows/Fonts/segoeuisb.ttf", "C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arialbd.ttf"]


def font(size):
    for path in FONT_PATHS:
        if os.path.exists(path):
            return ImageFont.truetype(path, size)
    return ImageFont.load_default()


def load(name):
    return Image.open(os.path.join(SRC, name)).convert("RGB")


def stack(images, labels, gap=36, pad=36, bg="#ffffff", label_h=68):
    width = max(im.width for im in images) + pad * 2
    height = pad * 2 + sum(im.height + label_h for im in images) + gap * (len(images) - 1)
    canvas = Image.new("RGB", (width, height), bg)
    draw = ImageDraw.Draw(canvas)
    f = font(40)
    y = pad
    for im, label in zip(images, labels):
        draw.text((pad, y + 8), label, font=f, fill="#57606a")
        y += label_h
        canvas.paste(im, (pad, y))
        draw.rectangle([pad - 1, y - 1, pad + im.width, y + im.height], outline="#d0d7de")
        y += im.height + gap
    return canvas


def side_by_side(images, labels, gap=36, pad=36, bg="#ffffff", label_h=68):
    f = font(40)
    probe = ImageDraw.Draw(Image.new("RGB", (1, 1), bg))
    # A column must fit both its picture and its caption, or the caption is
    # clipped at the canvas edge.
    widths = []
    for im, label in zip(images, labels):
        left, _, right, _ = probe.textbbox((0, 0), label, font=f)
        widths.append(max(im.width, right - left))
    height = pad * 2 + label_h + max(im.height for im in images)
    width = pad * 2 + sum(widths) + gap * (len(images) - 1)
    canvas = Image.new("RGB", (width, height), bg)
    draw = ImageDraw.Draw(canvas)
    x = pad
    for im, label, column in zip(images, labels, widths):
        draw.text((x, pad + 8), label, font=f, fill="#57606a")
        # Pad to the shared column width so both panels line up exactly.
        frame = Image.new("RGB", (column, im.height), bg)
        frame.paste(im, (0, 0))
        canvas.paste(frame, (x, pad + label_h))
        draw.rectangle([x - 1, pad + label_h - 1, x + column, pad + label_h + im.height], outline="#d0d7de")
        x += column + gap
    return canvas


def save(img, name):
    path = os.path.join(OUT, name)
    img.save(path, optimize=True)
    print(name, img.size, os.path.getsize(path))


os.makedirs(OUT, exist_ok=True)

# 1. Hero: the whole app window, sized for a README column.
app = load("app.png")
hero = app.resize((1600, round(app.height * 1600 / app.width)), Image.LANCZOS)
save(hero, "hero.png")

# 2. Before / after: the composer strip, native resolution.
save(stack([load("strip-before.png"), load("strip-after.png")],
           ["Before \u2014 right-click a flagged word",
            "After \u2014 pick \u201creceive\u201d and it is replaced in place"]),
     "before-after.png")

# 3. Menu close-ups, native resolution (displayed at half size).
save(load("menu-clean.png"), "menu.png")
save(load("unknown-clean.png"), "no-suggestions.png")

# 4. Scroll proof.
save(side_by_side([load("scroll-top.png"), load("scroll-bottom.png")],
                  ["Top of the list", "Scrolled down to Redo"]),
     "scroll.png")
