#!/usr/bin/env python3
"""Downscale and recompress a single raster image from stdin to stdout."""
import io
import json
import sys

from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 50_000_000


def emit(meta):
    print('MH_IMAGE_META ' + json.dumps(meta, separators=(',', ':')), file=sys.stderr, flush=True)


def fail(message):
    print('MH_IMAGE_ERROR ' + message, file=sys.stderr, flush=True)
    sys.exit(1)


def main():
    if len(sys.argv) != 4:
        fail('usage: image-compress.py MAX_DIMENSION QUALITY MIN_BYTES')
    try:
        max_dimension, quality, min_bytes = (int(value) for value in sys.argv[1:4])
    except ValueError:
        fail('invalid numeric argument')

    raw = sys.stdin.buffer.read()
    if not raw:
        fail('empty input')

    try:
        image = Image.open(io.BytesIO(raw))
        image.seek(0)
        image = ImageOps.exif_transpose(image)
    except Exception as exc:  # PIL raises several decoder-specific errors.
        fail('decode failed: ' + type(exc).__name__)

    original_width, original_height = image.size
    original_bytes = len(raw)
    needs_resize = max(original_width, original_height) > max_dimension
    has_alpha = image.mode in ('RGBA', 'LA') or (image.mode == 'P' and 'transparency' in image.info)

    if not needs_resize and original_bytes <= min_bytes:
        emit({
            'changed': False,
            'format': 'original',
            'width': original_width,
            'height': original_height,
            'originalWidth': original_width,
            'originalHeight': original_height,
            'bytes': original_bytes,
            'originalBytes': original_bytes,
        })
        sys.stdout.buffer.write(raw)
        return

    if needs_resize:
        image.thumbnail((max_dimension, max_dimension), Image.LANCZOS)

    output = io.BytesIO()
    if has_alpha:
        if image.mode not in ('RGBA', 'LA'):
            image = image.convert('RGBA')
        image.save(output, format='PNG', optimize=True, compress_level=9)
        output_format = 'PNG'
    else:
        if image.mode not in ('RGB', 'L'):
            image = image.convert('RGB')
        image.save(output, format='JPEG', quality=quality, optimize=True, progressive=True)
        output_format = 'JPEG'

    encoded = output.getvalue()
    # Do not replace an already efficient image with a larger recompression.
    changed = len(encoded) < original_bytes
    if changed:
        output_width, output_height = image.size
    else:
        encoded = raw
        output_format = 'original'
        output_width, output_height = original_width, original_height

    emit({
        'changed': changed,
        'format': output_format,
        'width': output_width,
        'height': output_height,
        'originalWidth': original_width,
        'originalHeight': original_height,
        'bytes': len(encoded),
        'originalBytes': original_bytes,
    })
    sys.stdout.buffer.write(encoded)


if __name__ == '__main__':
    main()