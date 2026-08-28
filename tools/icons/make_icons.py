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

# Straight from :root in index.html — --dot and --surface. Change them there
# and re-run this; don't hand-edit the PNGs.
#
# Two colours, because the dot is flat. An earlier version of this script drew
# a radial gradient from a highlight to a shadow edge, which made every icon a
# lit 3D ball — the wrong character for a flat, drawn interface, and not what
# .dot renders in the app.
DOT = (0x3E, 0x85, 0x23)
SURFACE = (0xFF, 0xFF, 0xFF)

# Supersampling factor. The circle edge and the gradient are both smooth
# ramps; sampling each output pixel 4x4 times is what keeps the rim from
# looking like stairs at 32px, where it shows most.
SS = 4


def render(size, dot_fraction):
    """One icon: a flat --dot disc centred on an opaque --surface ground.

    dot_fraction is the dot's diameter as a share of the canvas. Opaque
    because iOS composites a transparent home-screen icon onto black, and a
    dark-green dot on black is a smudge.
    """
    n = size * SS
    radius = n * dot_fraction / 2.0
    cx = cy = n / 2.0
    r2 = radius * radius

    rows = []
    for y in range(size):
        row = bytearray()
        for x in range(size):
            # Supersampling is the only thing doing any work now that the fill
            # is flat: each output pixel is the share of its SSxSS samples that
            # land inside the circle, which is what antialiases the rim.
            covered = 0
            for sy in range(SS):
                dy = y * SS + sy + 0.5 - cy
                dy2 = dy * dy
                for sx in range(SS):
                    dx = x * SS + sx + 0.5 - cx
                    if dx * dx + dy2 <= r2:
                        covered += 1
            k = SS * SS
            row += bytes(round(SURFACE[i] + (DOT[i] - SURFACE[i]) * covered / k)
                         for i in range(3))
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
