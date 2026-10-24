# ym154 别名轮冒烟测试（不触网，mock request_page；审计 P2#5 落盘，含 P1#1 误杀回归案例）
# 跑法：python -X utf8 tests/test_alias_smoke.py（在 collectors 目录下）
import json
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import collect_amap_expand as m


def fake_page_factory(pois, count):
    def fake(key, kw, city, page, off, iv):
        return (pois if page == 1 else []), (count if page == 1 else 0), None
    return fake


def run_case(tmp, slug, alias, pois, count=30):
    m.F_COUNTS = tmp / "counts.json"
    m.F_STORES = tmp / "stores.json"
    st = {"done": {"brands": []}}
    res, info = m.run_brands("KEY", slug, "杭州", 0.01, st, alias)
    counts = json.loads(m.F_COUNTS.read_text(encoding="utf-8"))
    stores = json.loads(m.F_STORES.read_text(encoding="utf-8"))
    return res, info, counts, stores


def main():
    tmp = Path(tempfile.mkdtemp())
    fails = []
    try:
        # 1) P1#1 误杀回归：店名只含别名词（别名词不在种子 kws）必须保留
        only_alias_pois = [
            {"id": "a1", "name": "FROG PRINCE(龙湖天街店)", "location": "120.1,30.1",
             "pname": "浙江省", "cityname": "杭州市", "adname": "西湖区", "type": "购物服务"},
            {"id": "a2", "name": "亚卡迪 JACADI PARIS 北京店", "location": "116.4,39.9",
             "pname": "北京市", "cityname": "北京市", "adname": "朝阳区", "type": "购物服务"},
            {"id": "a3", "name": "NB KIDS 青岛旗舰", "location": "120.4,36.1",
             "pname": "山东省", "cityname": "青岛市", "adname": "市南区", "type": "购物服务"},
            {"id": "a4", "name": "小帆船 petit bateau 上海店", "location": "121.4,31.2",
             "pname": "上海市", "cityname": "上海市", "adname": "黄浦区", "type": "购物服务"},
            {"id": "a5", "name": "S-BOX 斯乃纳童鞋汇", "location": "121.5,31.3",
             "pname": "上海市", "cityname": "上海市", "adname": "静安区", "type": "购物服务"},
        ]
        m.request_page = fake_page_factory(only_alias_pois, 5)
        for slug, alias, poi_id in (
            ("frog-prince-kids", "FROG PRINCE", "a1"),
            ("jacadi", "亚卡迪", "a2"),
            ("nb-kids", "NB KIDS", "a3"),
            ("petit-bateau", "小帆船", "a4"),
            ("sinaner", "S-BOX", "a5"),
        ):
            shutil.rmtree(tmp, ignore_errors=True); tmp.mkdir()
            _, info, counts, stores = run_case(tmp, slug, alias, only_alias_pois)
            kept_ids = set((stores.get(slug) or {}).get("stores") or {})
            if poi_id not in kept_ids:
                fails.append(f"P1#1回归失败: {slug}@{alias} 误杀 {info}")
        print("1) 误杀回归（5词）:", "PASS" if not fails else fails)

        # 2) 噪声拦截：店名不含品牌任何词的 POI 必须被滤（含其他品牌店=非本品牌目标）
        shutil.rmtree(tmp, ignore_errors=True); tmp.mkdir()
        noise_pois = [
            {"id": "a1", "name": "FROG PRINCE(龙湖天街店)", "location": "120.1,30.1",
             "pname": "浙江省", "cityname": "杭州市", "adname": "西湖区", "type": "购物服务"},
            {"id": "a2", "name": "青蛙王子童装万达店", "location": "120.2,30.2",
             "pname": "浙江省", "cityname": "杭州市", "adname": "拱墅区", "type": "购物服务"},
            {"id": "n1", "name": "某同名异物不相关店", "location": "120.3,30.3",
             "pname": "浙江省", "cityname": "杭州市", "adname": "西湖区", "type": "餐饮服务"},
            {"id": "n2", "name": "亚卡迪 JACADI PARIS 北京店", "location": "116.4,39.9",
             "pname": "北京市", "cityname": "北京市", "adname": "朝阳区", "type": "购物服务"}]
        m.request_page = fake_page_factory(noise_pois, 4)
        _, info, counts, stores = run_case(tmp, "frog-prince-kids", "FROG PRINCE", noise_pois)
        kept_ids = set((stores.get("frog-prince-kids") or {}).get("stores") or {})
        if kept_ids != {"a1", "a2"}:
            fails.append(f"噪声拦截异常: kept={kept_ids}")
        ac = counts["frog-prince-kids"]["aliasCities"]["杭州"]["FROG PRINCE"]
        if not (ac["raw"] == 4 and ac["kept"] == 2):
            fails.append(f"对账面数值异常: {ac}")
        if not ac.get("sample"):
            fails.append("aliasCities 缺 sample 目检材料（P1#3）")
        print("2) 噪声拦截+对账面+sample:", "PASS" if not fails else fails)

        # 3) 主词轮回归：全量收不滤、cities 口径正常、与 aliasCities 并存
        shutil.rmtree(tmp, ignore_errors=True); tmp.mkdir()
        m.request_page = fake_page_factory(noise_pois, 6)
        m.F_COUNTS = tmp / "counts.json"; m.F_STORES = tmp / "stores.json"
        st = {"done": {"brands": []}}
        res, info = m.run_brands("KEY", "frog-prince-kids", "宁波", 0.01, st)
        counts = json.loads(m.F_COUNTS.read_text(encoding="utf-8"))
        stores = json.loads(m.F_STORES.read_text(encoding="utf-8"))
        e = counts["frog-prince-kids"]
        if e["cities"]["宁波"]["count"] != 6:
            fails.append("主词轮 cities 口径异常")
        if "n1" not in (stores["frog-prince-kids"]["stores"]):
            fails.append("主词轮应全量收不滤")
        if e.get("aliasCities"):
            fails.append("主词轮不应写 aliasCities")
        print("3) 主词轮回归:", "PASS" if not fails else fails)

        # 4) 队列等价性：别名件缺失=4941 主词键零别名
        plan_backup = m.alias_plan
        m.alias_plan = lambda: {}
        keys = m.task_keys("brands", m.cities_list())
        m.alias_plan = plan_backup
        if not (len(keys) == 4941 and not any("|@" in k for k, _ in keys)):
            fails.append(f"基线等价失败: {len(keys)}")
        # 真实别名件：55 别名 -> 9396 键，两段式
        keys2 = m.task_keys("brands", m.cities_list())
        ak = [k for k, _ in keys2 if "|@" in k]
        idx = next(i for i, (k, _) in enumerate(keys2) if "|@" in k)
        if not (len(keys2) == 9396 and len(ak) == 55 * 81 and idx == 4941):
            fails.append(f"真实件队列异常: {len(keys2)}/{len(ak)}/{idx}")
        print("4) 队列等价+两段式:", "PASS" if not fails else fails)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
        m.request_page = m.__dict__.get("_orig_request_page", m.request_page)
    if fails:
        print("SMOKE FAIL"); sys.exit(1)
    print("SMOKE ALL PASS")


if __name__ == "__main__":
    main()
