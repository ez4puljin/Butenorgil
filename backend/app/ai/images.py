"""Зургийг Claude-д илгээхэд бэлтгэнэ: EXIF эргүүлэлт, урт тал ≤ 1600px, JPEG (токен ба хэмжээ хэмнэнэ)."""
from __future__ import annotations

import base64
import io

MAX_SIDE = 1600


def to_jpeg(data: bytes, max_side: int = MAX_SIDE, quality: int = 85) -> bytes:
    from PIL import Image, ImageOps
    try:
        import pillow_heif  # type: ignore  # iPhone HEIC
        pillow_heif.register_heif_opener()
    except ImportError:
        pass
    img = ImageOps.exif_transpose(Image.open(io.BytesIO(data)))
    img = img.convert("RGB")
    img.thumbnail((max_side, max_side))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, optimize=True)
    return buf.getvalue()


def image_block(jpeg: bytes) -> dict:
    return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                        "data": base64.b64encode(jpeg).decode()}}
