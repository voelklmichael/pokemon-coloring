"""Runs background-removal models on the artwork test set (see docs/BACKGROUND_REMOVAL.md).

Writes testdata/{model}/{config}/{file}: the artwork as RGBA, alpha = foreground mask.
  config = {variant}-{fit}-{post}
    variant  model file (fp32, or a quantized version)
    fit      stretch: resize to the model's square input; pad: keep aspect, extend the edge pixels
    post     raw: the model's soft mask; clean: threshold 0.5, keep large blobs, fill holes, dilate
Also writes stats.json per config (time per image). Existing outputs are skipped.

Setup:  python3 -m venv .venv && .venv/bin/pip install onnxruntime numpy pillow scipy
        (models are downloaded to .cache/models on first use)
Usage:  .venv/bin/python scripts/segment.py [model ...]
"""
import json
import sys
import time
import urllib.request
from pathlib import Path

import numpy as np
import onnxruntime as ort
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
TESTDATA = ROOT / 'testdata'
MODELS_DIR = ROOT / '.cache' / 'models'

REMBG = 'https://github.com/danielgatis/rembg/releases/download/v0.0.0'
IMGLY = 'https://staticimgly.com/@imgly/background-removal-data/1.7.0/dist'
IMAGENET = ((0.485, 0.456, 0.406), (0.229, 0.224, 0.225))
HALF = ((0.5, 0.5, 0.5), (1.0, 1.0, 1.0))
IMAGENET_MEAN = ((0.485, 0.456, 0.406), (1.0, 1.0, 1.0))

# model -> input size, normalization (as in rembg), output: logits (sigmoid) or rescaled to its min..max,
# variants (file, url, fits)
MODELS = {
    'u2netp': dict(size=320, norm=IMAGENET, logits=False, minmax=True, variants={
        'fp32': ('u2netp.onnx', f'{REMBG}/u2netp.onnx', ['stretch', 'pad']),
    }),
    'isnet-general': dict(size=1024, norm=HALF, logits=False, minmax=True, variants={
        'fp32': ('isnet-general-use.onnx', f'{REMBG}/isnet-general-use.onnx', ['stretch', 'pad']),
        'quint8': ('isnet-quint8.onnx', 'imgly:/models/isnet_quint8', ['stretch']),
    }),
    'isnet-anime': dict(size=1024, norm=IMAGENET_MEAN, logits=False, minmax=True, variants={
        'fp32': ('isnet-anime.onnx', f'{REMBG}/isnet-anime.onnx', ['stretch', 'pad']),
    }),
    'birefnet-lite': dict(size=1024, norm=IMAGENET, logits=True, minmax=False, variants={
        'fp32': ('birefnet-lite.onnx', f'{REMBG}/BiRefNet-general-bb_swin_v1_tiny-epoch_232.onnx', ['stretch', 'pad']),
    }),
    'rmbg-1.4': dict(size=1024, norm=HALF, logits=False, minmax=True, variants={
        'fp32': ('rmbg-1.4.onnx', 'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model.onnx', ['stretch', 'pad']),
        'quantized': ('rmbg-1.4-quantized.onnx',
                      'https://huggingface.co/briaai/RMBG-1.4/resolve/main/onnx/model_quantized.onnx', ['stretch']),
    }),
}


def download(file: str, url: str) -> Path:
    path = MODELS_DIR / file
    if path.exists():
        return path
    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    print(f'downloading {file}')
    tmp = path.with_suffix('.part')
    if url.startswith('imgly:'):
        # @imgly/background-removal serves its models in chunks listed in resources.json.
        with urllib.request.urlopen(f'{IMGLY}/resources.json') as r:
            chunks = json.load(r)[url.removeprefix('imgly:')]['chunks']
        with open(tmp, 'wb') as out:
            for c in chunks:
                with urllib.request.urlopen(f"{IMGLY}/{c['name']}") as r:
                    out.write(r.read())
    else:
        urllib.request.urlretrieve(url, tmp)
    tmp.rename(path)
    return path


def predict(session: ort.InferenceSession, img: Image.Image, model: dict, fit: str) -> np.ndarray:
    """Soft foreground mask 0..1 at the image's size."""
    n = model['size']
    w, h = img.size
    if fit == 'stretch':
        box = (0, 0, n, n)
        square = img.resize((n, n), Image.BILINEAR)
    else:
        s = n / max(w, h)
        sw, sh = round(w * s), round(h * s)
        box = ((n - sw) // 2, (n - sh) // 2, (n - sw) // 2 + sw, (n - sh) // 2 + sh)
        # Repeat the edge pixels: a flat border makes the whole artwork look like the "object".
        small = np.asarray(img.resize((sw, sh), Image.BILINEAR))
        square = np.pad(small, ((box[1], n - box[3]), (box[0], n - box[2]), (0, 0)), mode='edge')
    mean, std = (np.array(v, dtype=np.float32) for v in model['norm'])
    x = ((np.asarray(square, dtype=np.float32) / 255 - mean) / std).transpose(2, 0, 1)[None]
    y = session.run(None, {session.get_inputs()[0].name: x})[0][0, 0]
    if model['logits']:
        y = 1 / (1 + np.exp(-y))
    if model['minmax']:
        y = (y - y.min()) / max(float(y.max() - y.min()), 1e-6)
    mask = Image.fromarray(np.clip(y, 0, 1).astype(np.float32), mode='F').crop(box)
    return np.asarray(mask.resize((w, h), Image.BILINEAR))


def clean(mask: np.ndarray) -> np.ndarray:
    """Binary mask: threshold, drop small blobs, fill enclosed holes, grow by a few px."""
    fg = mask >= 0.5
    labels, count = ndimage.label(fg)
    if count:
        areas = ndimage.sum(fg, labels, range(1, count + 1))
        keep = np.flatnonzero((areas >= 0.1 * areas.max()) & (areas >= 0.002 * fg.size)) + 1
        fg = np.isin(labels, keep)
    fg = ndimage.binary_fill_holes(fg)
    fg = ndimage.binary_dilation(fg, iterations=2)
    return fg.astype(np.float32)


def save(img: Image.Image, mask: np.ndarray, path: Path):
    path.parent.mkdir(parents=True, exist_ok=True)
    rgba = img.convert('RGBA')
    rgba.putalpha(Image.fromarray((mask * 255).round().astype(np.uint8), mode='L'))
    rgba.save(path)


def main():
    names = sys.argv[1:] or list(MODELS)
    files = sorted(TESTDATA.glob('*.png'))
    for name in names:
        model = MODELS[name]
        for variant, (file, url, fits) in model['variants'].items():
            session = ort.InferenceSession(str(download(file, url)), providers=['CPUExecutionProvider'])
            for fit in fits:
                out = {post: TESTDATA / name / f'{variant}-{fit}-{post}' for post in ('raw', 'clean')}
                times = []
                for i, f in enumerate(files):
                    if all((d / f.name).exists() for d in out.values()):
                        continue
                    img = Image.open(f).convert('RGB')
                    t = time.perf_counter()
                    mask = predict(session, img, model, fit)
                    times.append(time.perf_counter() - t)
                    save(img, mask, out['raw'] / f.name)
                    save(img, clean(mask), out['clean'] / f.name)
                    print(f'{name} {variant}-{fit} {i + 1}/{len(files)} {f.name} {times[-1]:.2f}s', flush=True)
                if times:
                    stats = dict(model=name, variant=variant, file=file, fit=fit, images=len(times),
                                 model_mb=round((MODELS_DIR / file).stat().st_size / 1e6, 1),
                                 seconds_per_image=round(float(np.mean(times)), 3), provider='CPU')
                    for d in out.values():
                        (d / 'stats.json').write_text(json.dumps(stats, indent=2))


if __name__ == '__main__':
    main()
