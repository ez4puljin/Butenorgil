import importlib

def run_script_import(module_name: str, uploaded_path: str, output_dir: str) -> dict:
    mod = importlib.import_module(f"app.scripts.{module_name}")
    if not hasattr(mod, "main"):
        raise RuntimeError(f"{module_name} модульд main() байхгүй")
    return mod.main(uploaded_path, output_dir)