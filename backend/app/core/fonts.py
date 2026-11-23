"""PDF-ийн кирилл фонт — Windows ба Linux хоёуланд нь олдох замыг сонгоно.

Сервер Windows-оос Linux руу шилжсэн тул `C:/Windows/Fonts/...` гэж шууд бичвэл PDF
`FileNotFoundError`-оор унадаг. Энд жагсаалтаас эхний байгаа файлыг авна:
Arial (Windows) → Liberation Sans (Linux, Arial-тай ижил өргөнтэй тул байрлал өөрчлөгдөхгүй)
→ DejaVu Sans.
"""
from __future__ import annotations

from pathlib import Path

_ARIAL = (
    ("C:/Windows/Fonts/arial.ttf", "C:/Windows/Fonts/arialbd.ttf"),
    ("/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
     "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf"),
    ("/usr/share/fonts/truetype/liberation2/LiberationSans-Regular.ttf",
     "/usr/share/fonts/truetype/liberation2/LiberationSans-Bold.ttf"),
    ("/usr/share/fonts/liberation-sans/LiberationSans-Regular.ttf",
     "/usr/share/fonts/liberation-sans/LiberationSans-Bold.ttf"),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
     "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"),
)

_NOTO = (
    ("C:/Windows/Fonts/NotoSans-Regular.ttf", "C:/Windows/Fonts/NotoSans-Bold.ttf"),
    ("/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
     "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf"),
)


def _pick(candidates) -> tuple[str, str]:
    for reg, bold in candidates:
        if Path(reg).exists() and Path(bold).exists():
            return reg, bold
    tried = ", ".join(reg for reg, _ in candidates)
    raise FileNotFoundError(f"PDF-ийн кирилл фонт олдсонгүй (шалгасан: {tried})")


def arial_fonts() -> tuple[str, str]:
    """(энгийн, тод) — Arial эсвэл түүнтэй ижил өргөнтэй фонт."""
    return _pick(_ARIAL)


def noto_fonts() -> tuple[str, str]:
    """(энгийн, тод) — Noto Sans байвал түүнийг, үгүй бол Arial-ын жагсаалтаас."""
    return _pick(_NOTO + _ARIAL)
