from pathlib import Path
import shutil

def main(input_path: str, output_dir: str) -> dict:
    out_dir = Path(output_dir); out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / "accounts_receivable_last.xlsx"
    shutil.copy(input_path, out_path)
    return {"out_path": str(out_path)}
