#!/usr/bin/env python3
"""Render the app's icon set from the same brand colours index.html uses.

    python3 tools/icons/make_icons.py

Writes apple-touch-icon.png (180), icon-192.png, icon-512.png and
favicon-32.png to the repo root. The vector favicon (favicon.svg) is
hand-written and is *not* produced here — every modern browser prefers it;
these PNGs exist for the places that can't take an SVG at all: iOS home
screens (apple-touch-icon), the web app manifest, and older Safari.

Stdlib only, on purpose. This repo has no build step and no Node/Python
dependency for the site itself, and adding Pillow just to draw a circle
would make a four-file asset the reason someone has to install anything.
zlib and struct are all a PNG needs.
"""
import struct
import zlib
from pathlib import Path

# Straight from :root in index.html — --dot-light, --dot, --dot-deep and
# --surface. Change them there and re-run this; don't hand-edit the PNGs.
DOT_LIGHT = (0x6F, 0xBF, 0x47)
DOT = (0x3E, 0x85, 0x23)
DOT_DEEP = (0x2F, 0x6B, 0x18)
SURFACE = (0xFF, 0xFF, 0xFF)

# Supersampling factor. The circle edge and the gradient are both smooth
# ramps; sampling each output pixel 4x4 times is what keeps the rim from
# looking like stairs at 32px, where it shows most.
SS = 4


def _lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def _dot_colour(t):
    """The .dot radial-gradient, sampled at normalised radius t (0 at the
    highlight, 1 at the rim): --dot-light 0%, --dot 55%, --dot-deep 100%."""
    if t <= 0.55:
        return _lerp(DOT_LIGHT, DOT, t / 0.55)
    return _lerp(DOT, DOT_DEEP, (t - 0.55) / 0.45)


def render(size, dot_fraction):
    """One icon: the dot centred on an opaque --surface ground.

    dot_fraction is the dot's diameter as a share of the canvas. Opaque
    because iOS composites a transparent home-screen icon onto black, and a
    dark-green dot on black is a smudge.
    """
    n = size * SS
    radius = n * dot_fraction / 2.0
    cx = cy = n / 2.0
    # The highlight sits at 32%/26% of the *circle's* box, matching the
    # `circle at 32% 26%` in the CSS, not the centre of the canvas.
    hx = cx + (0.32 - 0.5) * radius * 2
    hy = cy + (0.26 - 0.5) * radius * 2
    # Farthest-corner, as CSS radial-gradient defaults to: the ramp has to
    # be normalised against the distance from the off-centre highlight to
    # the far edge of the circle, or the rim colour is never reached.
    span = ((cx - hx) ** 2 + (cy - hy) ** 2) ** 0.5 + radius

    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            r = g = b = 0
            for sy in range(SS):
                py = y * SS + sy + 0.5
                for sx in range(SS):
                    px = x * SS + sx + 0.5
                    inside = (px - cx) ** 2 + (py - cy) ** 2 <= radius * radius
                    if inside:
                        t = (((px - hx) ** 2 + (py - hy) ** 2) ** 0.5) / span
                        c = _dot_colour(min(t, 1.0))
                    else:
                        c = SURFACE
                    r += c[0]; g += c[1]; b += c[2]
            k = SS * SS
            row += bytes((r // k, g // k, b // k))
        rows.append(bytes(row))
    return rows


def write_png(path, rows, size):
    def chunk(tag, data):
        body = tag + data
        return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body))

    # Bit depth 8, colour type 2 (truecolour, no alpha), no interlace.
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0)
    # Filter type 0 (None) on every scanline. These are tiny flat images;
    # a smarter filter would save bytes that don't matter and cost clarity.
    raw = b"".join(b"\x00" + r for r in rows)
    png = (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", ihdr)
           + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))
    path.write_bytes(png)
    return len(png)


def main():
    root = Path(__file__).resolve().parents[2]
    # apple-touch-icon is padded (iOS draws it edge to edge inside its own
    # rounded mask, so a full-bleed dot would be clipped); the manifest and
    # favicon sizes are drawn tighter, since they're shown as-is.
    targets = [
        ("apple-touch-icon.png", 180, 0.62),
        ("icon-192.png", 192, 0.78),
        ("icon-512.png", 512, 0.78),
        ("favicon-32.png", 32, 0.82),
    ]
    for name, size, fraction in targets:
        rows = render(size, fraction)
        written = write_png(root / name, rows, size)
        print(f"{name:24} {size}x{size}  {written:>7} bytes")


if __name__ == "__main__":
    main()
