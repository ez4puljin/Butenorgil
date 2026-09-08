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


def build_rule_matcher(rules: Iterable[MinStockRule]):
    """Олон бараанд дүрэм тааруулах хурдан хувилбар.

    Яагаад: `find_rule_for_product` дуудлага бүрт бүх дүрмийг гүйж, бараа
    бүрийн CSV tag-аас set үүсгэдэг. 22,283 мөртэй захиалганд энэ нь 44,566
    удаагийн string задлалт болж ~0.5 сек иддэг (хэмжсэн).

    Энэ хувилбар:
      · барааны тусгай дүрмийг product_id-гаар шууд хайдаг dict болгоно;
      · ЕРӨНХИЙ дүрэм огт байхгүй бол tag-ийн set огт үүсгэхгүй (одоогийн
        байдлаар идэвхтэй 3 дүрэм бүгд барааны тусгай — өөрөөр хэлбэл 22,280
        мөрд ажил огт хийхгүй);
      · ерөнхий дүрмийн үр дүнг (warehouse_name, price_tag) хослолоор кэшилнэ
        (479 ялгаатай хослол vs 22,283 мөр).

    Буцаах: matcher(product) -> MinStockRule | None — `find_rule_for_product`-тэй
    ЯГ ижил үр дүн өгнө.
    """
    active = [r for r in rules if r.is_active]
    specific: dict[int, MinStockRule] = {}
    for r in active:
        if r.product_id is None:
            continue
        cur = specific.get(r.product_id)
        if cur is None or int(r.priority or 0) > int(cur.priority or 0):
            specific[r.product_id] = r
    generic = [r for r in active if r.product_id is None]
    # Хоосон дүрэм (ямар ч tag заагаагүй) match хийхгүй — эх функцтэй ижил.
    generic = [r for r in generic if _tags_set(r.location_tags) or _tags_set(r.price_tags)]
    prepared = [(r, _tags_set(r.location_tags), _tags_set(r.price_tags)) for r in generic]
    cache: dict[tuple, MinStockRule | None] = {}

    def match(product: Product) -> MinStockRule | None:
        r = specific.get(product.id)
        if r is not None:
            return r
        if not prepared:
            return None          # ерөнхий дүрэм алга — tag задлах шаардлагагүй
        key = (product.warehouse_name, product.price_tag)
        if key in cache:
            return cache[key]
        p_loc = _tags_set(product.warehouse_name)
        p_pri = _tags_set(product.price_tag)
        best, best_score = None, None
        for rule, r_loc, r_pri in prepared:
            if r_loc and not r_loc.issubset(p_loc):
                continue
            if r_pri and not r_pri.issubset(p_pri):
                continue
            score = (len(r_loc) + len(r_pri)) * 1000 + int(rule.priority or 0)
            if best_score is None or score > best_score:
                best, best_score = rule, score
        cache[key] = best
        return best

    return match
