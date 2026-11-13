"""Generate the extension's PNG icons (no third-party packages)."""
import struct, zlib, sys, os

def rrect(x, y, x0, y0, x1, y1, r):
    cx = min(max(x, x0 + r), x1 - r); cy = min(max(y, y0 + r), y1 - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r and x0 <= x <= x1 and y0 <= y <= y1

def circle(x, y, cx, cy, r):
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r

GREEN = (116, 172, 0); WHITE = (255, 255, 255)

def sample(u, v):
    """u, v in 0..1. Return RGBA."""
    if not rrect(u, v, 0.04, 0.04, 0.96, 0.96, 0.22):
        return (0, 0, 0, 0)
    rows = [(0.30, 0.78), (0.50, 0.70), (0.70, 0.60)]
    for cy, x1 in rows:
        if circle(u, v, 0.27, cy, 0.065):
            return WHITE + (255,)
        if rrect(u, v, 0.40, cy - 0.055, x1, cy + 0.055, 0.055):
            return WHITE + (255,)
    return GREEN + (255,)

def render(size, ss=4):
    rows = []
    for py in range(size):
        row = bytearray([0])
        for px in range(size):
            acc = [0, 0, 0, 0]
            for sy in range(ss):
                for sx in range(ss):
                    c = sample((px + (sx + .5) / ss) / size, (py + (sy + .5) / ss) / size)
                    a = c[3]
                    for i in range(3): acc[i] += c[i] * a
                    acc[3] += a
            n = ss * ss
            a = acc[3] / n
            rgb = [int(acc[i] / acc[3]) if acc[3] else 0 for i in range(3)]
            row += bytes(rgb + [int(round(a))])
        rows.append(bytes(row))
    raw = b"".join(rows)
    def chunk(t, d): return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xffffffff)
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))

out = sys.argv[1]
for name, size in [("icon-48", 48), ("icon-96", 96), ("icon-128", 128), ("icon-256", 256), ("icon-512", 512),
                   ("toolbar-16", 16), ("toolbar-32", 32)]:
    with open(os.path.join(out, name + ".png"), "wb") as f:
        f.write(render(size, 4 if size <= 256 else 2))
