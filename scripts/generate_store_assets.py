#!/usr/bin/env python3
import struct
import zlib
from pathlib import Path

ROOT = Path('/Users/harshveersinghnirwan/Downloads/fieldlens-salesforce')
OUT = ROOT / 'store_assets'

FONT = {
    'A': ['01110','10001','10001','11111','10001','10001','10001'],
    'B': ['11110','10001','10001','11110','10001','10001','11110'],
    'C': ['01110','10001','10000','10000','10000','10001','01110'],
    'D': ['11110','10001','10001','10001','10001','10001','11110'],
    'E': ['11111','10000','10000','11110','10000','10000','11111'],
    'F': ['11111','10000','10000','11110','10000','10000','10000'],
    'G': ['01110','10001','10000','10111','10001','10001','01110'],
    'H': ['10001','10001','10001','11111','10001','10001','10001'],
    'I': ['11111','00100','00100','00100','00100','00100','11111'],
    'K': ['10001','10010','10100','11000','10100','10010','10001'],
    'L': ['10000','10000','10000','10000','10000','10000','11111'],
    'M': ['10001','11011','10101','10101','10001','10001','10001'],
    'N': ['10001','10001','11001','10101','10011','10001','10001'],
    'O': ['01110','10001','10001','10001','10001','10001','01110'],
    'P': ['11110','10001','10001','11110','10000','10000','10000'],
    'R': ['11110','10001','10001','11110','10100','10010','10001'],
    'S': ['01111','10000','10000','01110','00001','00001','11110'],
    'T': ['11111','00100','00100','00100','00100','00100','00100'],
    'U': ['10001','10001','10001','10001','10001','10001','01110'],
    'V': ['10001','10001','10001','10001','01010','01010','00100'],
    'W': ['10001','10001','10001','10101','10101','10101','01010'],
    'X': ['10001','01010','00100','00100','00100','01010','10001'],
    'Y': ['10001','01010','00100','00100','00100','00100','00100'],
    '0': ['01110','10001','10011','10101','11001','10001','01110'],
    '1': ['00100','01100','00100','00100','00100','00100','01110'],
    '2': ['01110','10001','00001','00010','00100','01000','11111'],
    '3': ['11110','00001','00001','01110','00001','00001','11110'],
    '4': ['00010','00110','01010','10010','11111','00010','00010'],
    '5': ['11111','10000','10000','11110','00001','00001','11110'],
    ':': ['00000','00100','00100','00000','00100','00100','00000'],
    '-': ['00000','00000','00000','11111','00000','00000','00000'],
    '(': ['00010','00100','01000','01000','01000','00100','00010'],
    ')': ['01000','00100','00010','00010','00010','00100','01000'],
    ' ': ['00000','00000','00000','00000','00000','00000','00000'],
}


def png_chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack('!I', len(data)) + tag + data + struct.pack('!I', zlib.crc32(tag + data) & 0xFFFFFFFF)


def write_png_rgb(path: Path, w: int, h: int, rgb: bytes):
    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('!IIBBBBB', w, h, 8, 2, 0, 0, 0)
    stride = w * 3
    raw = bytearray()
    for y in range(h):
        raw.append(0)
        raw.extend(rgb[y * stride:(y + 1) * stride])
    comp = zlib.compress(bytes(raw), 9)
    data = sig + png_chunk(b'IHDR', ihdr) + png_chunk(b'IDAT', comp) + png_chunk(b'IEND', b'')
    path.write_bytes(data)


def canvas(w, h, color=(255, 255, 255)):
    return bytearray(color * (w * h))


def fill_rect(buf, w, h, x, y, rw, rh, color):
    x0, y0 = max(0, x), max(0, y)
    x1, y1 = min(w, x + rw), min(h, y + rh)
    for yy in range(y0, y1):
        row = (yy * w + x0) * 3
        for _ in range(x0, x1):
            buf[row:row+3] = bytes(color)
            row += 3


def gradient_bg(buf, w, h, c1, c2):
    for y in range(h):
        t = y / max(1, h - 1)
        color = (
            int(c1[0] * (1 - t) + c2[0] * t),
            int(c1[1] * (1 - t) + c2[1] * t),
            int(c1[2] * (1 - t) + c2[2] * t),
        )
        fill_rect(buf, w, h, 0, y, w, 1, color)


def draw_text(buf, w, h, x, y, text, color=(255, 255, 255), scale=2):
    cx = x
    for ch in text.upper():
        glyph = FONT.get(ch, FONT[' '])
        for gy, row in enumerate(glyph):
            for gx, bit in enumerate(row):
                if bit == '1':
                    fill_rect(buf, w, h, cx + gx * scale, y + gy * scale, scale, scale, color)
        cx += (5 + 1) * scale


def draw_logo_mark(buf, w, h, x, y, size):
    fill_rect(buf, w, h, x, y, size, size, (16, 124, 70))
    inset = max(4, size // 10)
    fill_rect(buf, w, h, x + inset, y + inset, size - inset * 2, size - inset * 2, (76, 185, 102))

    fx = x + size // 5
    fy = y + size // 4
    fw = max(3, size // 12)
    fh = size // 2
    fill_rect(buf, w, h, fx, fy, fw, fh, (250, 253, 255))
    fill_rect(buf, w, h, fx, fy, size // 3, fw, (250, 253, 255))
    fill_rect(buf, w, h, fx, fy + fh // 2, size // 4, fw, (250, 253, 255))

    lx = x + size // 2
    ly = y + size // 4
    lw = max(3, size // 12)
    lh = size // 2
    fill_rect(buf, w, h, lx, ly, lw, lh, (250, 253, 255))
    fill_rect(buf, w, h, lx, ly + lh - lw, size // 4, lw, (250, 253, 255))


def make_store_icon():
    w = h = 128
    buf = canvas(w, h)
    gradient_bg(buf, w, h, (15, 128, 74), (31, 163, 85))
    draw_logo_mark(buf, w, h, 12, 12, 104)
    write_png_rgb(OUT / 'store-icon-128.png', w, h, bytes(buf))


def make_tile(path, w, h, headline, subline):
    buf = canvas(w, h)
    gradient_bg(buf, w, h, (10, 27, 42), (18, 58, 82))
    fill_rect(buf, w, h, 0, h - h // 3, w, h // 3, (13, 92, 131))

    logo_size = min(h // 2, 180)
    draw_logo_mark(buf, w, h, 36, (h - logo_size) // 2, logo_size)

    draw_text(buf, w, h, 36 + logo_size + 32, h // 2 - 40, headline, (240, 248, 255), scale=4 if h >= 500 else 3)
    draw_text(buf, w, h, 36 + logo_size + 32, h // 2 + 10, subline, (186, 225, 245), scale=3 if h >= 500 else 2)

    write_png_rgb(path, w, h, bytes(buf))


def make_screenshot(path, title, obj_name, field_name, count_offset):
    w, h = 1280, 800
    buf = canvas(w, h)
    gradient_bg(buf, w, h, (233, 241, 249), (221, 233, 245))
    fill_rect(buf, w, h, 0, 0, w, 66, (1, 118, 211))
    draw_text(buf, w, h, 24, 20, 'SALESFORCE LIGHTNING', (255, 255, 255), scale=3)

    panel_w = 430
    px = w - panel_w
    fill_rect(buf, w, h, px, 0, panel_w, h, (255, 255, 255))
    fill_rect(buf, w, h, px, 0, panel_w, 68, (247, 252, 248))
    fill_rect(buf, w, h, px, 68, panel_w, 1, (216, 228, 221))
    draw_logo_mark(buf, w, h, px + 20, 16, 36)
    draw_text(buf, w, h, px + 66, 24, 'FIELDLENS', (14, 53, 32), scale=2)

    draw_text(buf, w, h, px + 24, 90, title, (22, 53, 77), scale=2)
    draw_text(buf, w, h, px + 24, 120, f'OBJECT: {obj_name}', (64, 92, 115), scale=2)
    draw_text(buf, w, h, px + 24, 146, f'FIELD: {field_name}', (64, 92, 115), scale=2)

    sections = [
        ('VALIDATION RULES', 2 + count_offset),
        ('APEX CLASSES', 3 + count_offset),
        ('APEX TRIGGERS', 1 + count_offset),
        ('FLOWS', 2),
        ('FIELD PERMISSIONS', 6 + count_offset),
    ]
    y = 188
    for label, count in sections:
        fill_rect(buf, w, h, px + 16, y, panel_w - 32, 88, (249, 251, 252))
        fill_rect(buf, w, h, px + 16, y, panel_w - 32, 1, (224, 232, 238))
        draw_text(buf, w, h, px + 28, y + 14, f'{label} ({count})', (23, 54, 76), scale=2)
        draw_text(buf, w, h, px + 28, y + 44, 'OPEN IN SETUP', (1, 118, 211), scale=2)
        y += 96

    fill_rect(buf, w, h, 40, 110, w - panel_w - 80, 64, (255, 255, 255))
    draw_text(buf, w, h, 58, 132, 'RECORD PAGE', (64, 92, 115), scale=2)
    fill_rect(buf, w, h, 40, 196, w - panel_w - 80, 420, (255, 255, 255))
    draw_text(buf, w, h, 58, 220, 'FIELD VALUES AND RELATED LISTS', (96, 118, 136), scale=2)

    write_png_rgb(path, w, h, bytes(buf))


def main():
    OUT.mkdir(exist_ok=True)
    make_store_icon()
    make_tile(OUT / 'small-promo-tile-440x280.png', 440, 280, 'FIELDLENS', 'SALESFORCE FIELD IMPACT')
    make_tile(OUT / 'marquee-promo-tile-1400x560.png', 1400, 560, 'FIELDLENS FOR SALESFORCE', 'IMPACT SCAN FOR FIELDS')

    make_screenshot(OUT / 'screenshot-1-1280x800.png', 'FIELD IMPACT SCAN', 'LEAD', 'NUMBEROFLOCATIONS__C', 0)
    make_screenshot(OUT / 'screenshot-2-1280x800.png', 'DEEP SCAN RESULTS', 'ACCOUNT', 'CUSTOM_STATUS__C', 1)
    make_screenshot(OUT / 'screenshot-3-1280x800.png', 'FIELD PERMISSIONS', 'OPPORTUNITY', 'MY_FORMULA_FIELD__C', 2)
    make_screenshot(OUT / 'screenshot-4-1280x800.png', 'FLOW REFERENCES', 'CASE', 'PRIORITY__C', 0)
    make_screenshot(OUT / 'screenshot-5-1280x800.png', 'PAGE LAYOUT USAGE', 'CONTACT', 'RISK_SCORE__C', 1)

    print(f'Generated PNG assets in {OUT}')


if __name__ == '__main__':
    main()
