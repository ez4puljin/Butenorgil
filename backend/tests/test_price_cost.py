from datetime import date

from app.services import price_cost as pc

D, B, RETAIL = pc.DEPARTMENT_ID, pc.BRANCH_ID, "3iHyxYCL73LhG5yTk"
PROD = {"_id": "P1", "categoryId": "C1", "tagIds": ["T1"]}


def plan(**kw):
    p = {"_id": "x", "type": "fixed", "value": 100, "applyType": "product", "products": ["P1"],
         "branchIds": [B], "departmentIds": [D], "isPriority": True}
    p.update(kw)
    return p


def test_parse_items_skips_brackets_in_strings():
    s = 'foo; var items = [{"a": "x [y] \\"]\\" z", "b": [1, [2]]}, {"c": 3}]; var other = [9];'
    assert pc.parse_items(s) == [{"a": 'x [y] "]" z', "b": [1, [2]]}, {"c": 3}]


def test_parse_items_missing():
    assert pc.parse_items("var nope = [1]") is None
    assert pc.items_from_response({"blocks": [{"content": "x"}, {"content": "var items = []"}]}) == []


def test_plan_applies_department_scope():
    assert pc.plan_applies(plan(), PROD)
    assert pc.plan_applies(plan(departmentIds=[D, RETAIL]), PROD)          # хуваалцсан
    assert not pc.plan_applies(plan(departmentIds=[RETAIL]), PROD)         # зөвхөн жижиглэн
    assert pc.plan_applies(plan(branchIds=[], departmentIds=[]), PROD)     # хоосон = бүгдэд
    assert not pc.plan_applies(plan(branchIds=["other"]), PROD)


def test_plan_applies_types_and_exclusions():
    assert not pc.plan_applies(plan(products=["P2"]), PROD)
    assert not pc.plan_applies(plan(productsExcluded=["P1"]), PROD)
    assert pc.plan_applies(plan(applyType="category", categories=["C1"]), PROD)
    assert not pc.plan_applies(plan(applyType="category", categories=["C1"], categoriesExcluded=["C1"]), PROD)
    assert pc.plan_applies(plan(applyType="tag", tags=["T1"]), PROD)
    assert not pc.plan_applies(plan(applyType="tag", tags=["T1"], tagsExcluded=["T1"]), PROD)
    assert not pc.plan_applies(plan(applyType="bundle"), PROD)


def test_plan_applies_dates():
    t = date(2026, 10, 26)
    assert not pc.plan_applies(plan(isEndDateEnabled=True, endDate="2026-10-01T00:00:00Z"), PROD, t)
    assert not pc.plan_applies(plan(isStartDateEnabled=True, startDate="2026-11-01T00:00:00Z"), PROD, t)
    assert pc.plan_applies(plan(isEndDateEnabled=False, endDate="2026-10-01T00:00:00Z"), PROD, t)


def test_plan_price():
    assert pc.plan_price(3480, plan(type="subtraction", value=210)) == 3270          # 103118
    assert pc.plan_price(4140, plan(type="subtraction", value=-430)) == 4570         # сөрөг = нэмэгдэл
    assert pc.plan_price(1000, plan(type="percentage", value=6)) == 940
    assert pc.plan_price(22800, plan(type="fixed", value=19000)) == 19000
    assert pc.plan_price(None, plan(type="subtraction", value=1)) is None
    assert pc.plan_price(100, plan(value=None)) is None


def test_config_price_overlaps():
    assert pc.config_price(3480, []) == (3480, "base")
    assert pc.config_price(3480, [plan(type="subtraction", value=210)]) == (3270, "plan")
    # нөхцөлтэй (бөөний) plan 1 ширхэгийн үнэд нөлөөлөхгүй
    assert pc.config_price(3480, [plan(type="subtraction", value=210, isQuantityEnabled=True)]) == (3480, "base")
    # олон plan — isPriority-тэйгээс хамгийн бага (таамаг)
    two = [plan(type="percentage", value=6), plan(type="fixed", value=5370)]
    assert pc.config_price(6000, two) == (5370, "guess")
    mixed = [plan(type="fixed", value=5000, isPriority=False), plan(type="fixed", value=5500)]
    assert pc.config_price(6000, mixed) == (5500, "guess")


def test_classify():
    assert pc.classify(20500, 20500.2) == "eq"
    assert pc.classify(19500, 20500) == "low"      # 102061
    assert pc.classify(96000, 92500) == "high"     # 101151
    assert pc.classify(100, None) == "none"


def test_guard_30pct():
    assert pc.guard(130, 100, 30)
    assert not pc.guard(131, 100, 30)
    assert not pc.guard(69, 100, 30)
    assert pc.guard(500, None, 30)                 # өмнөх үнэгүй бол хэвийн
