# 场景⑦ mall-cat 冒烟测试（不触网，mock request_page；命主 2026-10-13 商业体+品类词反推）
# 跑法：python -X utf8 tests/test_mall_cat.py（在 collectors 目录下）
import json
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import collect_amap_expand as m


def fake_page_factory(pages):
    """pages: [[poi,...], ...] 逐页返回。"""
    def fake(key, kw, city, page, off, iv):
        if page - 1 < len(pages):
            return pages[page - 1], sum(len(p) for p in pages), None
        return [], 0, None
    return fake


def setup(tmp):
    m.F_MALL_BRAND = tmp / "mall-brand-dist.json"
    m.F_FOUND = tmp / "poi-found-brands.json"
    # 每用例清台账（用例间隔离）
    m.F_MALL_BRAND.unlink(missing_ok=True)
    m.F_FOUND.unlink(missing_ok=True)
    # 匹配池：本场（坐标 120.1,30.1）+ 周边场（120.101,30.1，约 100m）
    m.mall_pool = lambda: [
        ("mall-a", "龙湖杭州滨江天街", "杭州", 120.1, 30.1, "seed"),
        ("mall-b", "星光大道广场", "杭州", 120.101, 30.1, "seed"),
    ]
    m._BRAND_CACHE = [("balabala", "巴拉巴拉", "巴拉巴拉", ["巴拉巴拉", "BALABALA"])]


def main():
    tmp = Path(tempfile.mkdtemp())
    fails = []
    try:
        # 1) 归属：店名内嵌→本场 name-embed；坐标邻近→周边场；无归属→stray 不进分布
        setup(tmp)
        pois = [
            {"id": "p1", "name": "巴拉巴拉(龙湖杭州滨江天街店)", "location": "120.1,30.1",
             "pname": "浙江省", "cityname": "杭州市", "adname": "滨江区", "type": "购物服务"},
            {"id": "p2", "name": "米奇妙妙屋", "location": "120.1012,30.1001",
             "pname": "浙江省", "cityname": "杭州市", "adname": "滨江区", "type": "购物服务"},
            {"id": "p3", "name": "远端小店", "location": "121.0,31.0",
             "pname": "浙江省", "cityname": "杭州市", "adname": "余杭区", "type": "购物服务"},
        ]
        m.request_page = fake_page_factory([pois])
        res, info = m.run_mall_cat("KEY", "mall-a", "龙湖杭州滨江天街", "杭州", "童装", 0.01)
        dist = json.loads(m.F_MALL_BRAND.read_text(encoding="utf-8"))
        found = json.loads(m.F_FOUND.read_text(encoding="utf-8"))
        if res != "ok":
            fails.append(f"1) run 失败 {info}")
        if "p1" not in dist.get("mall-a", {}).get("pois", {}) or \
                dist["mall-a"]["pois"]["p1"].get("matchKind") != "name-embed":
            fails.append(f"1) 店名内嵌归属失败: {dist.get('mall-a')}")
        if dist["mall-a"]["pois"].get("p1", {}).get("brandSlug") != "balabala":
            fails.append("1) 已收录品牌 slug 未落分布")
        if "p2" not in dist.get("mall-b", {}).get("pois", {}):
            fails.append(f"1) 周边场邻近归属失败: {list(dist.get('mall-b', {}).get('pois', {}))}")
        if any("p3" in v.get("pois", {}) for v in dist.values()):
            fails.append("1) 无归属 POI 误进分布")
        if "米奇妙妙屋" not in {v.get("name") for v in found.values()}:
            fails.append(f"1) 未收录品牌未进发现台账: {found}")
        print("1) 归属（内嵌/周边/stray）:", "PASS" if not fails else fails)

        # 2) 去重累计：同 poi 第二轮 seenCount=2、条目不重复（沿用 1) 的台账，此处不清）
        m.request_page = fake_page_factory([pois[:2]])
        m.run_mall_cat("KEY", "mall-a", "龙湖杭州滨江天街", "杭州", "童装", 0.01)
        dist = json.loads(m.F_MALL_BRAND.read_text(encoding="utf-8"))
        pe = dist["mall-a"]["pois"].get("p1", {})
        if pe.get("seenCount") != 2 or len(dist["mall-a"]["pois"]) != 1:
            fails.append(f"2) 跨轮去重累计失败: seenCount={pe.get('seenCount')} n={len(dist['mall-a']['pois'])}")
        print("2) 跨轮去重累计:", "PASS" if not any(f.startswith("2)") for f in fails) else fails)

        # 3) 晋级判据：未知品牌 ≥3 店 promoted；已收录品牌（巴拉巴拉）不进发现台账
        setup(tmp)
        more = [
            {"id": f"q{i}", "name": f"米奇妙妙屋({i}号店)", "location": "120.1012,30.1001",
             "pname": "浙江省", "cityname": "杭州市", "adname": "滨江区", "type": "购物服务"}
            for i in range(1, 4)
        ] + [
            {"id": "q9", "name": "巴拉巴拉童装", "location": "120.1,30.1",
             "pname": "浙江省", "cityname": "杭州市", "adname": "滨江区", "type": "购物服务"},
        ]
        m.request_page = fake_page_factory([more])
        m.run_mall_cat("KEY", "mall-a", "龙湖杭州滨江天街", "杭州", "童装", 0.01)
        found = json.loads(m.F_FOUND.read_text(encoding="utf-8"))
        hit = found.get("米奇妙妙屋")
        if not hit or not hit.get("promoted") or len(hit["poiIds"]) != 3:
            fails.append(f"3) ≥3 店晋级失败: {hit}")
        if any(v.get("name", "").startswith("巴拉巴拉") for v in found.values()):
            fails.append(f"3) 已收录品牌误进发现台账: {found}")
        # 反复出现（≥2 场）晋级：1 店落在 mall-b
        setup(tmp)
        two = [
            {"id": "r1", "name": "童趣小屋", "location": "120.1,30.1",
             "pname": "浙江省", "cityname": "杭州市", "adname": "滨江区", "type": "购物服务"},
            {"id": "r2", "name": "童趣小屋", "location": "120.1012,30.1001",
             "pname": "浙江省", "cityname": "杭州市", "adname": "滨江区", "type": "购物服务"},
        ]
        m.request_page = fake_page_factory([two])
        m.run_mall_cat("KEY", "mall-a", "龙湖杭州滨江天街", "杭州", "童鞋", 0.01)
        found = json.loads(m.F_FOUND.read_text(encoding="utf-8"))
        hit = found.get("童趣小屋")
        if not hit or not hit.get("promoted") or len(hit.get("mallRefs", [])) != 2:
            fails.append(f"3) ≥2 场晋级失败: {hit}")
        print("3) 反复出现晋级（≥3店/≥2场/已收录拦截）:", "PASS" if not any(f.startswith("3)") for f in fails) else fails)

        # 4) 队列过滤：--cities 只出该城商场键、--words 只出该品类词（试点通道，防误跑全量）
        m.category_words = lambda: (["购物中心"], ["童装", "童鞋"])
        m.mall_seeds = lambda: [("m1", "场一", "杭州"), ("m2", "场二", "北京")]
        keys = m.task_keys("mall-cat", [], word_filter=["童装"], city_filter=["杭州"])
        if [k for k, _ in keys] != ["mall-cat|m1|童装"]:
            fails.append(f"4) 城市/词过滤失败: {keys}")
        print("4) 队列城市过滤:", "PASS" if not any(f.startswith("4)") for f in fails) else fails)

        # 5) 商场自身/配套噪声拦截：未收录名含所属商场名不入分布与发现台账；已收录品牌命中不拦
        setup(tmp)
        noise = [
            {"id": "n1", "name": "龙湖杭州滨江天街", "location": "120.1,30.1",
             "pname": "浙江省", "cityname": "杭州市", "adname": "滨江区", "type": "购物服务"},
            {"id": "n2", "name": "龙湖杭州滨江天街母婴室", "location": "120.1,30.1",
             "pname": "浙江省", "cityname": "杭州市", "adname": "滨江区", "type": "生活服务"},
            {"id": "n3", "name": "巴拉巴拉(龙湖杭州滨江天街店)", "location": "120.1,30.1",
             "pname": "浙江省", "cityname": "杭州市", "adname": "滨江区", "type": "购物服务"},
        ]
        m.request_page = fake_page_factory([noise])
        m.run_mall_cat("KEY", "mall-a", "龙湖杭州滨江天街", "杭州", "童装", 0.01)
        dist = json.loads(m.F_MALL_BRAND.read_text(encoding="utf-8"))
        found = json.loads(m.F_FOUND.read_text(encoding="utf-8"))
        ids = set(dist.get("mall-a", {}).get("pois", {}))
        if ids != {"n3"}:
            fails.append(f"5) 商场自身噪声拦截失败: {ids}")
        if any("天街" in v.get("name", "") for v in found.values()):
            fails.append(f"5) 噪声进发现台账: {found}")
        print("5) 商场自身噪声拦截:", "PASS" if not any(f.startswith("5)") for f in fails) else fails)

        # 6) shoumen P1#1 误杀回归：「品牌名+商场名(店)」主流挂牌式必须保留并剥出品牌核心
        setup(tmp)
        brandy = [
            {"id": "b1", "name": "STOKKE龙湖杭州滨江天街", "location": "120.1,30.1",
             "pname": "浙江省", "cityname": "杭州市", "adname": "滨江区", "type": "购物服务"},
            {"id": "b2", "name": "莱丹童装龙湖杭州滨江天街店", "location": "120.1,30.1",
             "pname": "浙江省", "cityname": "杭州市", "adname": "滨江区", "type": "购物服务"},
        ]
        m.request_page = fake_page_factory([brandy])
        m.run_mall_cat("KEY", "mall-a", "龙湖杭州滨江天街", "杭州", "童装", 0.01)
        dist = json.loads(m.F_MALL_BRAND.read_text(encoding="utf-8"))
        found = json.loads(m.F_FOUND.read_text(encoding="utf-8"))
        names = {v.get("name") for v in found.values()}
        row_names = {p.get("brandName") for p in dist.get("mall-a", {}).get("pois", {}).values()}
        if "STOKKE" not in names or "STOKKE" not in row_names:
            fails.append(f"6) 品牌名含商场名被误杀: found={names} rows={row_names}")
        if "莱丹童装" not in names:
            fails.append(f"6) 残余核心剥取失败: {names}")
        print("6) 品牌名含商场名不误杀（P1#1 回归）:", "PASS" if not any(f.startswith("6)") for f in fails) else fails)

        # 7) shoumen P2#3：stray（无归属）门店只记观察不进晋级分母
        setup(tmp)
        stray = [
            {"id": f"s{i}", "name": "街边童趣屋", "location": "121.0,31.0",
             "pname": "浙江省", "cityname": "杭州市", "adname": "余杭区", "type": "购物服务"}
            for i in range(1, 4)
        ]
        m.request_page = fake_page_factory([stray])
        m.run_mall_cat("KEY", "mall-a", "龙湖杭州滨江天街", "杭州", "童装", 0.01)
        found = json.loads(m.F_FOUND.read_text(encoding="utf-8"))
        hits = [v for v in found.values() if v.get("name") == "街边童趣屋"]
        if not hits:
            fails.append(f"7) stray 未进观察台账: {found}")
        elif any(v.get("promoted") for v in hits) or any(len(v.get("attrIds", {})) for v in hits):
            fails.append(f"7) stray 误进晋级分母: {hits}")
        print("7) stray 不进晋级分母（P2#3）:", "PASS" if not any(f.startswith("7)") for f in fails) else fails)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("FAILS:", len(fails))
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
