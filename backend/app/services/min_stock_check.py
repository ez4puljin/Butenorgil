"""
Min-stock rule matching + needs_reorder logic.

Product.warehouse_name (location tags, CSV) + Product.price_tag (price tags, CSV)
vs MinStockRule.location_tags + MinStockRule.price_tags → subset match.

Хамгийн specific rule (илүү олон tag-тай) эхэлнэ; priority бол тэнцвэржүүлнэ.
"""

from __future__ import annotations
from typing import Iterable
from app.models.min_stock_rule import MinStockRule
from app.models.product import Product


def _tags_set(csv: str | None) -> set[str]:
    if not csv:
        return set()
    return {t.strip() for t in str(csv).split(",") if t.strip()}


def find_rule_for_product(product: Product, rules: Iterable[MinStockRule]) -> MinStockRule | None:
    """
    product-ийн tag-ууд rule-ийн БҮХ tag-ийг агуулж байгаа rule-ыг олно.
    Product-specific rule (product_id тохирсон) хамгийн өндөр эрэмбэтэй.
    """
    p_loc = _tags_set(product.warehouse_name)
    p_pri = _tags_set(product.price_tag)
    matches: list[tuple[int, MinStockRule]] = []
    for r in rules:
        if not r.is_active:
            continue
        # Product-specific rule: зөвхөн тухайн бараанд
        if r.product_id is not None:
            if r.product_id == product.id:
                # Хамгийн өндөр priority (1_000_000 base)
                score = 1_000_000 + int(r.priority or 0)
                matches.append((score, r))
            continue
        r_loc = _tags_set(r.location_tags)
        r_pri = _tags_set(r.price_tags)
        # Хоёулаа subset байх ёстой. Хэрэв rule дээр нэг нь ч заагдаагүй бол ignore (match зөвшөөрнө).
        if r_loc and not r_loc.issubset(p_loc):
            continue
        if r_pri and not r_pri.issubset(p_pri):
            continue
        # Хоосон rule (ямар ч tag заагаагүй) бүх бараанд match болно — зайлсхийж болно
        if not r_loc and not r_pri:
            continue
        score = (len(r_loc) + len(r_pri)) * 1000 + int(r.priority or 0)
        matches.append((score, r))
    if not matches:
        return None
    matches.sort(key=lambda x: -x[0])
    return matches[0][1]


def stock_breakdown(product: Product) -> dict:
    """Product.stock_qty (ширхгээр) → хайрцаг + задгай ширхэг."""
    pcs = float(product.stock_qty or 0)
    pack = float(product.pack_ratio or 1) or 1.0
    box = int(pcs // pack) if pack > 0 else 0
    extra = int(round(pcs - box * pack))
    return {"stock_pcs": pcs, "stock_box": box, "stock_extra_pcs": extra, "pack_ratio": pack}


def compute_needs_reorder(product: Product, rule: MinStockRule | None) -> tuple[bool, float]:
    """(needs_reorder, min_qty_box). Харьцуулалт нь ХАЙРЦАГ-аар."""
    if not rule:
        return (False, 0.0)
    min_q = float(rule.min_qty_box or 0)
    bd = stock_breakdown(product)
    return (bd["stock_box"] < min_q, min_q)


def build_rule_index(rules: list[MinStockRule]) -> list[MinStockRule]:
    """Serialize дараалалд rule-ыг бэлдэнэ (active-ийг фильтрлэсэн)."""
    return [r for r in rules if r.is_active]
