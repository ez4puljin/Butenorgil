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


def test_account_filter():
    assert pc.account_ok("кт:310104", ["310104"])
    assert pc.account_ok("кт:310104, дт:150101", ["310104"])
    assert not pc.account_ok("кт:313011", ["310104"])        # Тооллого
    assert not pc.account_ok("", ["310104"])
    assert not pc.account_ok("кт:3101040", ["310104"])


def test_fractional():
    assert pc.is_fractional(2183.33)
    assert not pc.is_fractional(20500.0)
    assert not pc.is_fractional(None)


def _raises(fn):
    try:
        fn()
    except Exception as e:  # noqa: BLE001
        return e
    raise AssertionError("алдаа гарах ёстой байсан")


def test_apply_guards():
    from app.services import price_cost_apply as ap
    good = {"name": "[AUTO-COST HA] 102061 x", "type": "subtraction", "value": -1000.0, "applyType": "product",
            "products": ["P"], "branchIds": [pc.HA_BRANCH_ID, B], "departmentIds": [RETAIL, D], "isPriority": True}
    ap._check_add_doc(good)
    for bad in ({"departmentIds": [D]}, {"departmentIds": []}, {"branchIds": [B]}, {"branchIds": []},
                {"departmentIds": [D, RETAIL, "other"]}, {"products": ["P", "Q"]}, {"type": "fixed"}, {"name": "x"},
                {"value": 0}, {"value": 12.5}, {"applyType": "tag"}):
        assert isinstance(_raises(lambda: ap._check_add_doc({**good, **bad})), ap.ApplyError)
    assert isinstance(_raises(lambda: ap._send("pricingPlanRemove", {})), ap.ApplyError)
    assert isinstance(_raises(lambda: ap._send("productsEdit", {})), ap.ApplyError)
    assert isinstance(_raises(lambda: ap._edit("x", {"departmentIds": []})), ap.ApplyError)


def test_plan_target_compensates_other_plans():
    assert pc.plan_target(None, 19500, 20500) == -1000      # 102061: бусдын plan-гүй = үндсэн − орлого
    assert pc.plan_target(None, 3270, 3420) == -150         # 103118: бусдын −210 plan-ыг нөхнө
    assert pc.plan_target(-1000, 20500, 20500) == -1000     # таарсан — өөрчлөхгүй
    assert pc.plan_target(-150, 3420, 3500) == -230         # орлого өссөн


def test_due_slot_schedule():
    from datetime import datetime as dt
    sch = ["08:30", "18:30"]
    # УБ 08:29 (UTC 00:29) — хараахан болоогүй
    assert pc.due_slot(sch, dt(2026, 10, 27, 0, 29), None) is None
    # УБ 08:31 — өнөөдөр синк хийгдээгүй
    assert pc.due_slot(sch, dt(2026, 10, 27, 0, 31), dt(2026, 10, 26, 10, 31)) == "08:30"
    # 08:30-аас хойш (UTC 00:30) аль хэдийн эхэлсэн — дахин хийхгүй
    assert pc.due_slot(sch, dt(2026, 10, 27, 0, 45), dt(2026, 10, 27, 0, 30)) is None
    # УБ 21:00, сүүлд 08:30-д — 18:30-ийг нөхнө
    assert pc.due_slot(sch, dt(2026, 10, 27, 13, 0), dt(2026, 10, 27, 0, 30)) == "18:30"
    # УБ 00:10 (UTC өмнөх өдөр 16:10) — шинэ өдрийн цаг болоогүй, өчигдрийнхийг нөхөхгүй
    assert pc.due_slot(sch, dt(2026, 10, 26, 16, 10), None) is None
    assert pc.due_slot([], dt(2026, 10, 27, 13, 0), None) is None


def test_hhmm():
    assert pc._hhmm("8:30") == "08:30"
    assert pc._hhmm("24:00") is None
    assert pc._hhmm("x") is None


def test_notify_only_on_change():
    sent = []
    orig = pc._notify
    pc._notify = lambda s, t: sent.append(t)
    try:
        row = {"code": "1", "name": "A", "config": 100, "income": 90, "action": "update", "review": False}
        res = {"rows": [row]}
        pc._notify_new({}, res, res)
        assert not sent
        pc._notify_new({}, {"rows": []}, res)
        assert len(sent) == 1 and "100 → 90" in sent[0]
        pc._notify_new({}, res, {"rows": [{**row, "action": ""}]})
        assert len(sent) == 1
    finally:
        pc._notify = orig
