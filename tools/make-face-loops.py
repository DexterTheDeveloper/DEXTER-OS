#!/usr/bin/env python3
"""Generate DEXTER's four face loops from the existing neon-helmet art. Procedural only: no new art.

    python3 tools/make-face-loops.py --out . [--src tools/face-source.png] [--frames DIR] [--sheet DIR]

SOURCE: tools/face-source.png is a byte copy of /Users/iiiglobe/dexter/assets/dexter_face.png (1024x1024,
sha256 1a701b16d221b5cc7153494f1f374516fc8e8cc8226b34835b36d053b53ddb8c). The loops come from THAT file, not
from the repo's avatar.png, which is a lighter re-encode of the same art. A future Kling regeneration should
start from the same source.

Needs Pillow + numpy + ffmpeg (libvpx-vp9, libwebp_anim). Writes avatar-{idle,listening,thinking,speaking}.webm
and the same names as animated .webp. Kling-made loops can replace them later under the same names.

States (all seamless loops; every effect is periodic in the loop length):
  idle       4.0 s  slow breathing glow + faint scanline drift
  listening  2.0 s  eye-glow pulse in time with a soft sweep around the frame
  thinking   1.5 s  gold scanline sweep down the visor + highlight rotating around the frame
  speaking   0.8 s  eyes + visor bars flicker like a VU (visual pattern, not audio-driven)
"""
import argparse
import math
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageFilter

SIZE = 512
FPS = 24
STATES = {  # name -> (seconds, fps)
    'idle': (4.0, FPS),
    'listening': (2.0, FPS),
    'thinking': (1.5, FPS),
    'speaking': (0.8, 25),
}
CYAN = np.array([0.0, 212 / 255, 1.0], dtype=np.float32)
GOLD = np.array([1.0, 190 / 255, 60 / 255], dtype=np.float32)
GREEN = np.array([57 / 255, 1.0, 20 / 255], dtype=np.float32)


def to_img(a):
    return Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8))


def blur(a, radius):
    """Gaussian blur an HxWx3 (or HxW) float array via Pillow."""
    if a.ndim == 2:
        im = Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8), 'L')
        return np.asarray(im.filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32) / 255
    return np.asarray(to_img(a).filter(ImageFilter.GaussianBlur(radius)), dtype=np.float32) / 255


def smooth01(x):
    return 0.5 - 0.5 * math.cos(2 * math.pi * x)  # 0 at x=0, 1 at x=0.5, back to 0 at x=1 (loops)


class Face:
    def __init__(self, src):
        im = Image.open(src).convert('RGB').resize((SIZE, SIZE), Image.LANCZOS)
        self.base = np.asarray(im, dtype=np.float32) / 255
        b = self.base
        r, g, bl = b[..., 0], b[..., 1], b[..., 2]
        lum = 0.2126 * r + 0.7152 * g + 0.0722 * bl
        self.lum = lum
        # soft masks from the art's own colours
        self.eyes = blur(((g > 0.45) & (g > r * 1.4) & (g > bl * 1.4)).astype(np.float32), 2)
        self.frame = blur(((r > 0.35) & (r > bl * 2.0)).astype(np.float32), 2)       # gold + red frame
        self.lines = blur(((bl > 0.35) & (bl > r * 1.8) & (g < bl)).astype(np.float32), 1.5)  # blue helmet
        self.glow = blur(np.clip(lum * 1.4, 0, 1), 1)                                  # everything lit
        self.halo = blur(b, 10)                                                         # wide soft halo
        self.eye_layer = b * self.eyes[..., None]
        self.eye_halo = blur(self.eye_layer, 14)
        self.frame_layer = b * self.frame[..., None]
        self.frame_halo = blur(self.frame_layer, 8)
        ys, xs = np.mgrid[0:SIZE, 0:SIZE].astype(np.float32)
        self.y01 = ys / SIZE
        self.ang = np.arctan2(ys - SIZE / 2, xs - SIZE / 2)                            # -pi..pi
        # eye centres (for the VU bars + flicker), measured from the mask
        ey, ex = np.nonzero(self.eyes > 0.5)
        self.eye_cy = float(ey.mean()) / SIZE if len(ey) else 0.46

    # ---------- helpers ----------
    def sweep(self, t, sigma=0.55, lobes=1):
        """Angular weight 0..1 of a highlight rotating once per loop (lobes copies)."""
        theta = 2 * math.pi * t
        d = self.ang - theta
        d = (d + math.pi) % (2 * math.pi) - math.pi
        if lobes == 2:
            d = np.minimum(np.abs(d), np.abs((d + math.pi + math.pi) % (2 * math.pi) - math.pi))
        return np.exp(-(d / sigma) ** 2).astype(np.float32)

    def band(self, y_center, height):
        """Soft horizontal band centred at y_center (0..1), height in px."""
        d = (self.y01 - y_center) * SIZE
        return np.exp(-(d / height) ** 2).astype(np.float32)

    # ---------- states ----------
    def idle(self, t):
        s = smooth01(t)                                           # one breath per loop
        out = self.base * (0.93 + 0.09 * s) + self.halo * (0.14 * s)
        scan = self.band((t * 1.3) % 1.3 - 0.15, 22)              # drifts top -> bottom, leaves the frame
        out += (scan * self.glow * 0.10)[..., None] * CYAN
        return out

    def listening(self, t):
        p = smooth01(t)                                           # one eye pulse per loop
        out = self.base + self.eye_halo * (0.9 * p) + self.eye_layer * (0.55 * p)
        w = self.sweep(t, sigma=0.6)                              # one soft revolution per loop
        out += self.frame_halo * (0.9 * w)[..., None] + self.frame_layer * (0.5 * w)[..., None]
        out += (self.eyes * 0.25 * p)[..., None] * GREEN
        return out

    def thinking(self, t):
        # gold scan sweeps the visor top -> bottom
        y = -0.12 + 1.24 * t
        scan = self.band(y, 16)
        lit = scan * self.glow
        out = self.base + (lit * 0.9)[..., None] * GOLD + (blur(lit, 6) * 0.5)[..., None] * GOLD
        # a crisper highlight rotating the other way around the frame
        w = self.sweep(1 - t, sigma=0.35)
        out += self.frame_halo * (1.1 * w)[..., None] + self.frame_layer * (0.7 * w)[..., None]
        out += (self.frame * w * 0.25)[..., None] * GOLD
        return out

    def speaking(self, t):
        # looping pseudo-random flicker: integer-multiple sines so the loop is seamless
        def sig(phase, k):
            v = (0.5 + 0.30 * math.sin(2 * math.pi * (3 * t) + phase)
                 + 0.22 * math.sin(2 * math.pi * (5 * t) + 1.7 * phase + k)
                 + 0.16 * math.sin(2 * math.pi * (7 * t) + 0.9 * phase + 2 * k)
                 + 0.10 * math.sin(2 * math.pi * (11 * t) + 2.3 * phase))
            return min(1.0, max(0.0, v))
        e = sig(0.0, 0.4)
        out = self.base + self.eye_halo * (0.8 * e) + self.eye_layer * (0.5 * e)
        out += (self.eyes * 0.25 * e)[..., None] * GREEN
        out = out * (1 + 0.04 * e)
        # VU bars in the visor plate below the eyes
        bars = np.zeros((SIZE, SIZE), dtype=np.float32)
        n = 5
        cx0, cy, bw, gap, hmax = 0.5, self.eye_cy + 0.145, 10, 8, 40
        x_left = cx0 * SIZE - (n * bw + (n - 1) * gap) / 2
        for i in range(n):
            h = 6 + hmax * sig(0.9 * i + 0.3, 1.3 * i)
            x0 = int(round(x_left + i * (bw + gap)))
            y1 = int(round(cy * SIZE + hmax * 0.5))
            y0 = int(round(y1 - h))
            bars[y0:y1, x0:x0 + bw] = 1.0
        bars = blur(bars, 0.8)
        out += (bars * 0.85)[..., None] * CYAN + (blur(bars, 6) * 0.7)[..., None] * CYAN
        return out


def render(face, name, frames_dir):
    secs, fps = STATES[name]
    n = int(round(secs * fps))
    fn = getattr(face, name)
    d = os.path.join(frames_dir, name)
    os.makedirs(d, exist_ok=True)
    for i in range(n):
        to_img(fn(i / n)).save(os.path.join(d, '%03d.png' % i))
    return d, n, fps


def encode(name, d, fps, out_dir, crf, webp_q, webp_fps):
    webm = os.path.join(out_dir, 'avatar-%s.webm' % name)
    webp = os.path.join(out_dir, 'avatar-%s.webp' % name)
    common = ['ffmpeg', '-v', 'error', '-y', '-framerate', str(fps), '-i', os.path.join(d, '%03d.png')]
    subprocess.run(common + ['-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', str(crf), '-pix_fmt', 'yuv420p',
                             '-row-mt', '1', '-deadline', 'good', '-cpu-used', '1', '-an', webm], check=True)
    subprocess.run(common + ['-vf', 'fps=%s' % webp_fps, '-c:v', 'libwebp_anim', '-lossless', '0', '-quality', str(webp_q),
                             '-compression_level', '6', '-loop', '0', '-pix_fmt', 'yuv420p', '-an', webp], check=True)
    return webm, webp


def contact_sheet(d, n, path, cols=8):
    idx = [int(i * n / cols) for i in range(cols)]
    tiles = [Image.open(os.path.join(d, '%03d.png' % i)).resize((256, 256)) for i in idx]
    sheet = Image.new('RGB', (256 * cols, 256))
    for k, im in enumerate(tiles):
        sheet.paste(im, (256 * k, 0))
    sheet.save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--src', default=os.path.join(os.path.dirname(os.path.abspath(__file__)), 'face-source.png'))
    ap.add_argument('--out', default='.')
    ap.add_argument('--frames', default=None, help='keep PNG frames here (default: temp dir)')
    ap.add_argument('--sheet', default=None, help='write a contact sheet per state here')
    ap.add_argument('--crf', type=int, default=30)
    ap.add_argument('--webp-quality', type=int, default=70)
    ap.add_argument('--webp-fps', type=int, default=24)
    a = ap.parse_args()
    frames = a.frames or tempfile.mkdtemp(prefix='dexter-face-')
    face = Face(a.src)
    total = 0
    for name in STATES:
        d, n, fps = render(face, name, frames)
        if a.sheet:
            os.makedirs(a.sheet, exist_ok=True)
            contact_sheet(d, n, os.path.join(a.sheet, 'sheet-%s.png' % name))
        webm, webp = encode(name, d, fps, a.out, a.crf, a.webp_quality, a.webp_fps if name != 'speaking' else 25)
        sw, sp = os.path.getsize(webm), os.path.getsize(webp)
        total += sw
        print('%-10s %3d frames @%2d fps  webm %6.1f KB  webp %6.1f KB' % (name, n, fps, sw / 1024, sp / 1024))
    print('webm total %.1f KB' % (total / 1024))
    if not a.frames:
        shutil.rmtree(frames, ignore_errors=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
