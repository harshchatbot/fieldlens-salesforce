#!/usr/bin/env python3
import os
import struct
import zlib

OUT_DIR = '/Users/harshveersinghnirwan/Downloads/fieldlens-salesforce/icons'
SIZES = [16, 32, 48, 128]


def crc32(data: bytes) -> int:
    return zlib.crc32(data) & 0xFFFFFFFF


def chunk(tag: bytes, data: bytes) -> bytes:
    return struct.pack('!I', len(data)) + tag + data + struct.pack('!I', crc32(tag + data))


def png_rgba(width: int, height: int, pixels: bytes) -> bytes:
    sig = b'\x89PNG\r\n\x1a\n'
    ihdr = struct.pack('!IIBBBBB', width, height, 8, 6, 0, 0, 0)

    # Add filter byte 0 before each row.
    stride = width * 4
    raw = bytearray()
    for y in range(height):
        raw.append(0)
        row = pixels[y * stride:(y + 1) * stride]
        raw.extend(row)

    compressed = zlib.compress(bytes(raw), 9)
    return sig + chunk(b'IHDR', ihdr) + chunk(b'IDAT', compressed) + chunk(b'IEND', b'')


def set_px(buf: bytearray, size: int, x: int, y: int, rgba):
    if x < 0 or y < 0 or x >= size or y >= size:
        return
    i = (y * size + x) * 4
    buf[i:i+4] = bytes(rgba)


def draw_rect(buf: bytearray, size: int, x0: int, y0: int, x1: int, y1: int, rgba):
    for y in range(max(0, y0), min(size, y1)):
        for x in range(max(0, x0), min(size, x1)):
            set_px(buf, size, x, y, rgba)


def draw_circle(buf: bytearray, size: int, cx: int, cy: int, r: int, rgba):
    r2 = r * r
    for y in range(cy - r, cy + r + 1):
        for x in range(cx - r, cx + r + 1):
            dx, dy = x - cx, y - cy
            if dx * dx + dy * dy <= r2:
                set_px(buf, size, x, y, rgba)


def icon_pixels(size: int) -> bytes:
    # Palette aligned with Salesforce-like blue.
    bg1 = (1, 118, 211, 255)
    bg2 = (1, 92, 167, 255)
    white = (255, 255, 255, 255)
    light = (198, 230, 255, 255)

    buf = bytearray(size * size * 4)

    # Vertical gradient background.
    for y in range(size):
        t = y / max(1, size - 1)
        r = int(bg1[0] * (1 - t) + bg2[0] * t)
        g = int(bg1[1] * (1 - t) + bg2[1] * t)
        b = int(bg1[2] * (1 - t) + bg2[2] * t)
        for x in range(size):
            set_px(buf, size, x, y, (r, g, b, 255))

    # Rounded-corner mask effect.
    corner = max(2, size // 6)
    for y in range(size):
        for x in range(size):
            dx = min(x, size - 1 - x)
            dy = min(y, size - 1 - y)
            if dx < corner and dy < corner:
                cx = corner if x < size // 2 else size - 1 - corner
                cy = corner if y < size // 2 else size - 1 - corner
                if (x - cx) ** 2 + (y - cy) ** 2 > corner ** 2:
                    set_px(buf, size, x, y, (0, 0, 0, 0))

    # Stylized F + lens motif.
    stroke = max(1, size // 10)
    pad = max(2, size // 6)
    f_w = max(2, size // 5)

    # F vertical
    draw_rect(buf, size, pad, pad, pad + f_w, size - pad, white)
    # F top
    draw_rect(buf, size, pad, pad, size // 2 + stroke, pad + stroke + 1, white)
    # F mid
    draw_rect(buf, size, pad, size // 2 - stroke, size // 2, size // 2 + 1, white)

    # Lens circle and handle
    r = max(2, size // 6)
    cx = int(size * 0.68)
    cy = int(size * 0.45)
    draw_circle(buf, size, cx, cy, r, light)
    draw_circle(buf, size, cx, cy, max(1, r - stroke), (0, 0, 0, 0))

    # Handle
    for i in range(stroke + 1):
        for t in range(r + stroke + 2):
            x = cx + t // 2 + i
            y = cy + t // 2 + i
            set_px(buf, size, x, y, light)

    return bytes(buf)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        pixels = icon_pixels(size)
        data = png_rgba(size, size, pixels)
        path = os.path.join(OUT_DIR, f'icon{size}.png')
        with open(path, 'wb') as f:
            f.write(data)
        print(path)


if __name__ == '__main__':
    main()
