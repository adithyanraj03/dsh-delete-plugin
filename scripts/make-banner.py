"""Regenerate assets/banner-light.png and assets/banner-dark.png.

Self-contained 1400x400 banners in the dsh-graft/balance grammar: flat
background, a soft teal glow, the plugin icon as the mark, a bold wordmark, a
monospace tagline, and two tilted mock cards on the right (the risk-consent
dialog and a pinned workspace row). Run: python scripts/make-banner.py
"""
from pathlib import Path
import sys

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "assets"
OUT = Path(sys.argv[1]) if len(sys.argv) > 1 else ASSETS
W, H = 1400, 400
TEAL = (47, 191, 160)
RED = (201, 66, 63)
GOLD = (232, 160, 32)
PANEL = (33, 33, 38)
PANEL_BORDER = (70, 70, 78)

FONT_BOLD = "C:/Windows/Fonts/segoeuib.ttf"
FONT_REG = "C:/Windows/Fonts/segoeui.ttf"
FONT_MONO = "C:/Windows/Fonts/consola.ttf"


def rounded(img, radius):
    mask = Image.new("L", img.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, img.width - 1, img.height - 1], radius, fill=255)
    out = img.convert("RGBA")
    out.putalpha(mask)
    return out


def card(base, panel_img, x, y, w, h, radius, angle=0.0):
    shadow = Image.new("RGBA", base.size, (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle([x + 6, y + 8, x + 6 + w, y + 8 + h], radius, fill=(0, 0, 0, 41))
    base.alpha_composite(shadow)
    piece = rounded(panel_img.resize((w, h), Image.LANCZOS), radius)
    border = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(border).rounded_rectangle([0, 0, w - 1, h - 1], radius, outline=(0, 0, 0, 36), width=2)
    piece.alpha_composite(border)
    if angle:
        piece = piece.rotate(angle, expand=True, resample=Image.BICUBIC)
    base.alpha_composite(piece, (x, y))


def pin_glyph(d, cx, cy, s, color):
    # A simple push-pin: round head + needle.
    d.ellipse([cx - s, cy - s, cx + s, cy + s], fill=color)
    d.line([cx, cy + s, cx - s * 0.7, cy + s * 2.2], fill=color, width=max(2, int(s * 0.5)))


def dialog_card():
    img = Image.new("RGBA", (400, 150), PANEL + (255,))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, 399, 149], 12, outline=PANEL_BORDER, width=2)
    d.text((18, 16), "Permanently delete this session?", font=ImageFont.truetype(FONT_BOLD, 16), fill=(236, 236, 236))
    d.text((18, 46), "Session log, workspace accounting and", font=ImageFont.truetype(FONT_REG, 12), fill=(154, 163, 178))
    d.text((18, 64), "live session state will be removed.", font=ImageFont.truetype(FONT_REG, 12), fill=(154, 163, 178))
    # Cancel button
    d.rounded_rectangle([212, 102, 288, 132], 7, outline=PANEL_BORDER, width=2)
    d.text((230, 108), "Cancel", font=ImageFont.truetype(FONT_REG, 13), fill=(236, 236, 236))
    # Delete button
    d.rounded_rectangle([298, 102, 382, 132], 7, fill=RED)
    d.text((316, 108), "Delete", font=ImageFont.truetype(FONT_BOLD, 13), fill=(255, 255, 255))
    return img


def workspace_card():
    img = Image.new("RGBA", (430, 170), PANEL + (255,))
    d = ImageDraw.Draw(img)
    d.rounded_rectangle([0, 0, 429, 169], 12, outline=PANEL_BORDER, width=2)
    # workspace row: folder + title + pin badge
    d.rounded_rectangle([18, 20, 40, 38], 3, outline=TEAL, width=2)
    d.text((52, 20), "dsh-delete-plugin", font=ImageFont.truetype(FONT_BOLD, 15), fill=(236, 236, 236))
    pin_glyph(d, 232, 28, 6, TEAL)
    d.text((372, 20), "…", font=ImageFont.truetype(FONT_BOLD, 16), fill=(154, 163, 178))
    # open menu with the Pin workspace item highlighted
    d.rounded_rectangle([40, 58, 300, 150], 10, fill=(24, 24, 28), outline=PANEL_BORDER, width=2)
    d.rounded_rectangle([48, 66, 292, 96], 7, fill=(42, 42, 48))
    pin_glyph(d, 64, 80, 6, TEAL)
    d.text((82, 72), "Pin workspace", font=ImageFont.truetype(FONT_REG, 14), fill=(236, 236, 236))
    d.text((82, 108), "Rename", font=ImageFont.truetype(FONT_REG, 14), fill=(154, 163, 178))
    d.text((82, 128), "Delete workspace", font=ImageFont.truetype(FONT_REG, 14), fill=(239, 74, 87))
    return img


def glow(base):
    overlay = Image.new("RGBA", base.size, (0, 0, 0, 0))
    d = ImageDraw.Draw(overlay)
    for r, alpha in ((165, 10), (120, 12), (75, 14)):
        d.ellipse([170 - r, 200 - r, 170 + r, 200 + r], fill=TEAL + (alpha,))
    base.alpha_composite(overlay)


def banner(bg, ink, tag, out):
    base = Image.new("RGBA", (W, H), bg + (255,))
    glow(base)
    icon = Image.open(ASSETS / "icon.png").convert("RGBA").resize((210, 210), Image.LANCZOS)
    base.alpha_composite(icon, (60, 95))
    d = ImageDraw.Draw(base)
    d.text((320, 225), "delete", font=ImageFont.truetype(FONT_BOLD, 110), fill=ink, anchor="ls")
    d.text((324, 272), "Delete sessions · pin workspaces.", font=ImageFont.truetype(FONT_MONO, 18), fill=tag, anchor="ls")
    card(base, dialog_card(), 975, 45, 400, 150, 12)
    card(base, workspace_card(), 855, 175, 430, 170, 12, angle=-2)
    base.convert("RGB").save(OUT / out)
    print("wrote", out)


banner((244, 245, 247), (26, 31, 44), (92, 100, 112), "banner-light.png")
banner((20, 24, 36), (244, 245, 247), (154, 163, 178), "banner-dark.png")