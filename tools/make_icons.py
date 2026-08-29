#!/usr/bin/env python3
"""Generate the app icons.

No image libraries are available in this environment, so this rasterises the
mark directly and writes PNGs with zlib + struct. 4x supersampling gives clean
edges. Re-run after changing the design:

    python3 tools/make_icons.py
"""
import math
import struct
import zlib
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "assets"

NAVY = (11, 26, 46)
SEA_DARK = (24, 79, 149)
SEA = (57, 135, 229)
FOAM = (205, 226, 251)
HULL = (255, 255, 255)


def lerp(a, b, t):
    return tuple(round(x + (y - x) * t) for x, y in zip(a, b))


def rounded_rect(x, y, w, h, r):
    """Inside-test for a rounded rectangle in unit-ish pixel space."""
    def test(px, py):
        if px < x or py < y or px > x + w or py > y + h:
            return False
        cx = min(max(px, x + r), x + w - r)
        cy = min(max(py, y + r), y + h - r)
        return (px - cx) ** 2 + (py - cy) ** 2 <= r * r
    return test


def shade(px, py, size, full_bleed):
    """Colour for one sample point, or None for transparent."""
    s = size
    if not full_bleed:
        if not rounded_rect(0, 0, s, s, s * 0.22)(px, py):
            return None

    # Normalised coordinates.
    u, v = px / s, py / s

    # --- sea: a wave crest filling the lower half
    crest = 0.63 + 0.085 * math.sin((u * 1.05 - 0.14) * math.pi * 2)
    if v >= crest:
        depth = (v - crest) / max(1e-6, 1 - crest)
        base = lerp(SEA, SEA_DARK, min(1.0, depth * 1.25))
        # A band of foam along the crest.
        if depth < 0.085:
            return lerp(FOAM, base, depth / 0.085)
        return base

    # --- kayak: a lens shape (two arcs) heeled over, riding the crest
    kx, ky = u - 0.5, v - 0.395
    ang = math.radians(-19)
    rx = kx * math.cos(ang) - ky * math.sin(ang)
    ry = kx * math.sin(ang) + ky * math.cos(ang)

    half_len, half_beam = 0.30, 0.052
    t = rx / half_len
    if abs(t) <= 1.0:
        # Fine ends, full amidships — a boat, not a capsule.
        beam = half_beam * (1 - t * t) ** 0.62
        if abs(ry) <= beam:
            return HULL

    # --- paddle blade, a short stroke off the bow
    pxr, pyr = u - 0.735, v - 0.265
    pa = math.radians(38)
    ax = pxr * math.cos(pa) - pyr * math.sin(pa)
    ay = pxr * math.sin(pa) + pyr * math.cos(pa)
    if abs(ax) <= 0.115 and abs(ay) <= 0.022:
        return FOAM

    return NAVY


def render(size, full_bleed=False, ss=4):
    """Render to raw RGBA rows with `ss`× supersampling."""
    rows = []
    inv = 1.0 / (ss * ss)
    for y in range(size):
        row = bytearray()
        for x in range(size):
            r = g = b = a = 0.0
            for sy in range(ss):
                for sx in range(ss):
                    px = x + (sx + 0.5) / ss
                    py = y + (sy + 0.5) / ss
                    c = shade(px, py, size, full_bleed)
                    if c is not None:
                        r += c[0]; g += c[1]; b += c[2]; a += 255
            if a == 0:
                row += b"\x00\x00\x00\x00"
            else:
                # Un-premultiply against coverage so edges stay crisp.
                n = a / 255.0
                row += bytes((round(r / n), round(g / n), round(b / n), round(a * inv)))
        rows.append(bytes(row))
    return rows


def write_png(path, rows, size):
    raw = b"".join(b"\x00" + r for r in rows)

    def chunk(tag, data):
        c = struct.pack(">I", len(data)) + tag + data
        return c + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = b"\x89PNG\r\n\x1a\n"
    png += chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
    png += chunk(b"IDAT", zlib.compress(raw, 9))
    png += chunk(b"IEND", b"")
    path.write_bytes(png)
    print(f"{path.name}  {size}×{size}  {len(png):,} bytes")


SVG = """<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="22" fill="#0b1a2e"/>
  <path d="M0 70 Q30 50 60 62 T100 58 L100 100 L0 100 Z" fill="#3987e5"/>
  <path d="M0 70 Q30 50 60 62 T100 58 L100 62 Q70 66 60 66 T0 74 Z" fill="#cde2fb"/>
  <ellipse cx="50" cy="39.5" rx="30" ry="5.2" fill="#ffffff" transform="rotate(-19 50 39.5)"/>
  <rect x="62" y="24.5" width="23" height="4.4" rx="2.2" fill="#cde2fb" transform="rotate(38 73.5 26.7)"/>
</svg>
"""


def main():
    OUT.mkdir(exist_ok=True)
    (OUT / "icon.svg").write_text(SVG)
    print("icon.svg")

    for size, name, bleed in [
        (192, "icon-192.png", False),
        (512, "icon-512.png", False),
        (512, "icon-maskable-512.png", True),
        (180, "apple-touch-icon.png", True),
        (32, "favicon-32.png", False),
    ]:
        write_png(OUT / name, render(size, bleed), size)


if __name__ == "__main__":
    main()
