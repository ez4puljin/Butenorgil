"""
master_merge.py
items_master_streamlit.py-ийн build_master_from_uploads логикийг
ашиглаж Эрхэт + Эрксэс файлыг нэгтгэнэ.
"""
from pathlib import Path
import re
import numpy as np
import pandas as pd


# ── Байршил tag жагсаалт ─────────────────────────────────────────────────────
LOCATION_TAGS = [
    "Архи Ус ундаа пиво",
    "Бөөний агуулах",
    "Гэрээт компани",
    "Жижиглэн Архи",
    "Жижиглэн агуулах",
    "Зааланд ирдэг",
    "Тоглоом, Гэр ахуй (Граш)",
]


def _norm_tag(s: str) -> str:
    # Strip leading '*' marker (used in Erxes exports to flag location tags)
    return re.sub(r"\s+", " ", s.lstrip("*").strip().lower())


LOCATION_TAGS_NORM = {_norm_tag(x) for x in LOCATION_TAGS}


# ── Tag helpers ───────────────────────────────────────────────────────────────
def split_tags(tag_str) -> list:
    if tag_str is None or (isinstance(tag_str, float) and np.isnan(tag_str)):
        return []
    s = str(tag_str).replace("，", ",")
    return [p.strip() for p in s.split(",") if p.strip()]


def split_location_and_price(tag_str):
    """
    Erxes exports mark location tags with a leading '*' (e.g. '*Архи Ус ундаа пиво').
    Fall back to LOCATION_TAGS_NORM matching for entries without the '*' marker.
    The '*' is stripped from the output tag name.
    """
    loc, price = [], []
    for t in split_tags(tag_str):
        is_starred = t.startswith("*")
        t_clean = t.lstrip("*").strip()
        if not t_clean:
            continue
        if is_starred or _norm_tag(t_clean) in LOCATION_TAGS_NORM:
            loc.append(t_clean)
        else:
            price.append(t)
    return loc, price


def agg_tags_union_keep_order(series: pd.Series):
    seen, out = set(), []
    for v in series.dropna():
        for t in split_tags(v):
            nt = _norm_tag(t)
            if nt not in seen:
                seen.add(nt)
                out.append(t)
    return ", ".join(out) if out else np.nan


# ── Column helpers ────────────────────────────────────────────────────────────
def col_to_idx(col_letter: str) -> int:
    n = 0
    for ch in col_letter.strip().upper():
        n = n * 26 + (ord(ch) - ord("A") + 1)
    return n - 1


def safe_get_col(df: pd.DataFrame, col_letter: str) -> pd.Series:
    idx = col_to_idx(col_letter)
    if idx < 0 or idx >= df.shape[1]:
        return pd.Series([np.nan] * len(df))
    return df.iloc[:, idx]


def normalize_code(v) -> str:
    if pd.isna(v):
        return ""
    s = re.sub(r"\.0$", "", str(v).strip())
    return re.sub(r"\s+", "", s)


def normalize_blank(v):
    if pd.isna(v):
        return np.nan
    s = str(v).strip()
    # Treat common placeholder values (including Erxes "-" for no image) as blank
    _BLANKS = {"", "nan", "none", "-", "–", "—", "null", "n/a", "na"}
    return np.nan if s.lower() in _BLANKS else v


def first_nonnull(s: pd.Series):
    s2 = s.dropna()
    return s2.iloc[0] if len(s2) else np.nan


def drop_leading_nondata_rows(df: pd.DataFrame, code_col_idx: int) -> pd.DataFrame:
    if df.empty:
        return df
    col = df.iloc[:, code_col_idx].astype(str).str.strip()
    bad = col.isna() | (col == "") | col.str.contains(
        r"^код$|^code$|^nan$", case=False, regex=True
    )
    for i in range(len(df)):
        if not bad.iloc[i]:
            return df.iloc[i:].copy()
    return df.iloc[0:0].copy()


def read_excel_noheader(path: str) -> pd.DataFrame:
    p = str(path)
    engine = "xlrd" if p.lower().endswith(".xls") else "openpyxl"
    return pd.read_excel(p, sheet_name=0, header=None, engine=engine)


# ── Баганын байршил (Streamlit-тэй ижил) ─────────────────────────────────────
ERKHET = {
    "code":       "A",   # Код
    "name":       "B",   # Нэр
    "category":   "D",   # Ангилал нэр
    "unit_price": "G",   # Нэгж үнэ
    "weight":     "W",   # Жин
    "box_ratio":  "Q",   # Задрах харьцаа → хайрцагны тоо = round(1/Q)
    "brand_code": "T",   # Брэнд код
    "brand_name": "U",   # Брэнд нэр
    "barcode":    "F",   # Баркод
}

ERXES = {
    "code":      "F",    # code
    "imageUrl":  "B",    # imageUrl
    "tagIds":    "C",    # tagIds
    "createdAt": "L",    # createdAt
}


# ── Гол функц ─────────────────────────────────────────────────────────────────
def main(erkhet_path: str, erxes_path: str, output_dir: str) -> dict:
    out_dir = Path(output_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    erh_raw = read_excel_noheader(erkhet_path)
    erx_raw = read_excel_noheader(erxes_path)

    # ── Erkhet файл бүртгэл шалгах ─────────────────────────────────────────
    # Ёстой product list-д 20+ багана байдаг (Код, Нэр, Ангилал код, Ангилал нэр,
    # Гадаад нэр, Баркод, Нэгж үнэ, ...). Хэрэв багана цөөн (11 мэт)
    # тохиолдолд энэ нь Үлдэгдлийн тайлан бөгөөд master_merge буруу боловсруулна.
    if erh_raw.shape[1] < 15:
        raise ValueError(
            f"Erkhet бараа файл буруу форматтай байна.\n"
            f"Ирсэн багана тоо: {erh_raw.shape[1]} (ёстой 15+).\n"
            f"Та Үлдэгдлийн тайлан эсвэл өөр тайлан орлуулж оруулсан уу?\n"
            f"Зөв: 'Эрхэт → Бараа материал → Бараа материалын жагсаалт' экспортлох."
        )

    erh_raw = drop_leading_nondata_rows(erh_raw, col_to_idx(ERKHET["code"])).reset_index(drop=True)
    erx_raw = drop_leading_nondata_rows(erx_raw, col_to_idx(ERXES["code"])).reset_index(drop=True)

    # ── Эрхэт ────────────────────────────────────────────────────────────────
    code       = safe_get_col(erh_raw, ERKHET["code"]).map(normalize_code)
    name       = safe_get_col(erh_raw, ERKHET["name"]).fillna("").astype(str).str.strip().replace({"nan": ""})
    category   = safe_get_col(erh_raw, ERKHET["category"]).fillna("").astype(str).str.strip().replace({"nan": ""})
    unit_price = pd.to_numeric(safe_get_col(erh_raw, ERKHET["unit_price"]), errors="coerce")
    weight_s   = pd.to_numeric(safe_get_col(erh_raw, ERKHET["weight"]),     errors="coerce")
    box_ratio  = pd.to_numeric(safe_get_col(erh_raw, ERKHET["box_ratio"]),  errors="coerce")
    brand_code = safe_get_col(erh_raw, ERKHET["brand_code"]).fillna("").astype(str).str.strip().replace({"nan": ""})
    brand_name = safe_get_col(erh_raw, ERKHET["brand_name"]).fillna("").astype(str).str.strip().replace({"nan": ""})
    barcode    = safe_get_col(erh_raw, ERKHET["barcode"]).fillna("").astype(str).str.strip().replace({"nan": ""})

    # Хайрцагны тоо = round(1 / box_ratio)
    n = len(erh_raw)
    mask = (box_ratio.notna() & (box_ratio != 0)).to_numpy()
    box_count_arr = np.full(n, np.nan, dtype=float)
    if mask.any():
        box_count_arr[mask] = np.round(1.0 / box_ratio.to_numpy(dtype=float)[mask], 0)
    box_count = pd.Series(box_count_arr).astype("Int64")

    # Хайрцагны жин = жин × хайрцагны тоо (default=1 тохиолдолд анхааруулга)
    w_arr  = weight_s.to_numpy(dtype=float)
    bc_arr = pd.to_numeric(box_count, errors="coerce").to_numpy(dtype=float)
    invalid = np.isnan(w_arr) | np.isnan(bc_arr)
    box_weight_arr = np.where(
        (w_arr == 1.0) & (bc_arr == 1.0), "Ху.жин ба хайрцаг тоо буруу",
        np.where(w_arr  == 1.0, "Ху.жин буруу",
        np.where(bc_arr == 1.0, "Хайрцагны тоо буруу",
                 np.round(w_arr * bc_arr, 6)))
    )
    box_weight_arr = np.where(invalid, "", box_weight_arr)

    base = pd.DataFrame({
        "Код":           code,
        "Нэр":           name,
        "Ангилал нэр":   category,
        "Нэгж үнэ":      unit_price,
        "Жин":           weight_s,
        "Хайрцагны тоо": box_count,
        "Хайрцагны жин": pd.Series(box_weight_arr),
        "Брэнд код":     brand_code,
        "Брэнд нэр":     brand_name,
        "Баркод":        barcode,
    })
    base = base[base["Код"] != ""].copy()
    base = base.drop_duplicates(subset=["Код"], keep="first").reset_index(drop=True)
    base.insert(0, "Барааны индекс", np.arange(1, len(base) + 1))

    # ── Эрксэс ───────────────────────────────────────────────────────────────
    erx = pd.DataFrame({
        "Код":       safe_get_col(erx_raw, ERXES["code"]).map(normalize_code),
        "imageUrl":  safe_get_col(erx_raw, ERXES["imageUrl"]).map(normalize_blank),
        "tagIds":    safe_get_col(erx_raw, ERXES["tagIds"]).map(normalize_blank),
        "createdAt": safe_get_col(erx_raw, ERXES["createdAt"]).map(normalize_blank),
    })
    erx = erx[erx["Код"] != ""].copy()
    erx = (erx.groupby("Код", as_index=False)
              .agg({
                  "imageUrl":  first_nonnull,
                  "createdAt": first_nonnull,
                  "tagIds":    agg_tags_union_keep_order,
              }))

    # ── Нэгтгэл (left join: Эрхэт үндэс) ────────────────────────────────────
    master = base.merge(erx, on="Код", how="left")

    loc_list, price_list = [], []
    for v in master["tagIds"].tolist():
        loc, price = split_location_and_price(v)
        loc_list.append(", ".join(loc))
        price_list.append(", ".join(price))
    master["Байршил tag"]   = loc_list
    master["Үнэ бодох tag"] = price_list

    master = master[[
        "Барааны индекс", "Код", "Нэр", "Ангилал нэр", "Нэгж үнэ", "Жин",
        "Хайрцагны тоо", "Хайрцагны жин", "Брэнд код", "Брэнд нэр", "Баркод",
        "imageUrl", "tagIds", "Байршил tag", "Үнэ бодох tag", "createdAt",
    ]]

    # ── master_refresh.py-д шаардлагатай стандарт баганууд ───────────────────
    master["item_code"]   = master["Код"]
    master["name"]        = master["Нэр"]
    master["brand"]       = master["Брэнд нэр"]
    master["unit_weight"] = master["Жин"].fillna(0.0)
    master["pack_ratio"]  = pd.to_numeric(master["Хайрцагны тоо"], errors="coerce").fillna(1.0)

    # ── Хадгалах ─────────────────────────────────────────────────────────────
    # Sheet 1 "Нэгтгэл"          : бүх Эрхэт бараа + Эрксэс мэдээлэл (left join)
    # Sheet 2 "Эрксэст байхгүй"  : Эрксэст таарах код олдоогүй бараа
    df_no_erxes = master[master["tagIds"].isna()].copy()

    out_path = out_dir / "master_latest.xlsx"
    with pd.ExcelWriter(str(out_path), engine="openpyxl") as writer:
        master.to_excel(writer,      sheet_name="Нэгтгэл",          index=False)
        df_no_erxes.to_excel(writer, sheet_name="Эрксэст байхгүй",  index=False)

    matched = int(master["tagIds"].notna().sum())
    only_e  = len(df_no_erxes)

    return {
        "master_path": str(out_path),
        "total":       len(master),
        "matched":     matched,
        "only_erkhet": only_e,
    }
