from pathlib import Path
import shutil
import pandas as pd


def main(input_path: str, output_dir: str) -> dict:
    # Файлын format шалгах — Үлдэгдлийн тайлан эсвэл өөр тайлан уруу шилжүүлснээс сэргийлнэ.
    # Бараа материалын жагсаалтад 15+ багана байх ёстой.
    try:
        df = pd.read_excel(input_path, header=None, nrows=2)
        if df.shape[1] < 15:
            raise ValueError(
                f"Бараа материалын жагсаалт биш файл орж ирлээ.\n"
                f"Багана тоо: {df.shape[1]} (ёстой 15+).\n"
                f"Эрхэт системээс 'Бараа материал → Бараа материалын жагсаалт'-ыг экспортлон оруулна уу."
            )
    except ValueError:
        raise
    except Exception as e:
        raise ValueError(f"Файлыг унших боломжгүй байна: {e}")

    out_dir = Path(output_dir); out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "erxes_sales_last.xlsx"
    shutil.copy(input_path, out_path)
    return {"out_path": str(out_path)}