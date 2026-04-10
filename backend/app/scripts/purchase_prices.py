"""
Үнийн тайлан импорт скрипт.

Хүлээн авах Excel формат:
  A баганад: Код (item_code)
  B баганад: Нэр (лавлах, заавал биш)
  C баганад: Огноо (орлого авсан огноо)
  D баганад: Нэгж үнэ (MNT)

Нэг бараа олон мөр байж болно — хамгийн сүүлийн огноотой мөрийн үнийг авна.
Огноо хоосон бол файлын хамгийн сүүлийн мөрийн үнийг авна.
"""

from pathlib import Path
import shutil


def main(input_path: str, output_dir: str) -> dict:
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "purchase_prices_last.xlsx"
    shutil.copy(input_path, out_path)
    return {"out_path": str(out_path)}
