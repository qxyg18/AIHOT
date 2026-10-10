"""ym81 高德三类词采集扩充引擎（品牌词/品类词/集团词 → 对账·候选池·入驻图谱）。

设计正本=artifacts/2026-10-01/ym81-amap-expansion/design.md（命主 2026-10-01 批准默认口径）。
授权与纪律沿用 ym8/商场线：非商用自用、低频慢查、逐条落盘中断零损失、
配额到顶提前收工（quotaHit 记 state，人工清除后复跑）、不改种子本体。
场景与分页（设计§二§三；ym118 起①扩为全量翻页）：
①brands 61品牌主词×81城全量翻页（≤40页/城）——count 对账 + 分门店档案
（brand-stores.json，供品牌榜门店统计与后续门店地址专项页）；ym154 起主词键后
追加别名键（keywords/brand-alias.json，主轮完成后自动续跑增量，对账走 aliasCities 面）；
②cat-mall 81城×购物中心≤10页候选池；③④cat-kids 81城×童装/童鞋≤3页品牌分布；
⑤group 集团词表全国搜≤15页（不带city，请求量降98%）；
⑥proximity 邻近匹配（150m strong/400m weak）+店名内嵌商场名双信号，纯本地不调API。
预算（设计§四）：默认 2000 请求/班（2026-10-07 命主升配令由 500 调档；月更窗 1-3 日让位 80），由 run_collect 分账传入。
产物（设计§七）：out/expand/*.json；断点游标 state/amap-expand-state.json。
"""
import argparse
import json
import math
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SEED_BRANDS = REPO / "database" / "seeds" / "lb-brands-2026-10.json"
SEED_MALLS = REPO / "database" / "seeds" / "lb-malls-2026-10.json"
MALL_COORDS = HERE / "out" / "mall-coords.json"
CITY_IDS = HERE / "state" / "city-ids.json"
KW_GROUP = HERE / "keywords" / "group-lines.json"
KW_CATEGORY = HERE / "keywords" / "category-words.json"
KW_ALIAS = HERE / "keywords" / "brand-alias.json"   # ym154：品牌别名清单（延伸调查产出，文件缺失=别名队列为空）
OUT_DIR = HERE / "out" / "expand"
F_COUNTS = OUT_DIR / "brand-store-counts.json"
F_STORES = OUT_DIR / "brand-stores.json"
F_CITY_MALLS = OUT_DIR / "city-malls.json"
F_MALL_CAND = OUT_DIR / "mall-candidates.json"
F_CITY_KIDS = OUT_DIR / "city-kids.json"
F_PRESENCE = OUT_DIR / "brand-city-presence.json"
F_BRAND_CAND = OUT_DIR / "brand-candidates.json"
F_GROUP = OUT_DIR / "group-projects.json"
F_TENANCY = OUT_DIR / "tenancy-graph.json"
STATE = HERE / "state" / "amap-expand-state.json"
LOG = HERE / "logs" / "amap-expand.log"
CONFIG = Path("D:/secrets/radar-collect/config.json")

QUOTA_MARKS = ("CUOTAS", "LIMIT", "EXCEED")
STRONG_M, WEAK_M = 150.0, 400.0          # 邻近匹配半径（设计§六）
SAME_MALL_M = 200.0                       # 场景②⑤ 同场判定（坐标信号）
PAGES = {"brands": 40, "cat-mall": 10, "cat-kids": 3, "group": 15}
OFFSET = {"brands": 25, "cat-mall": 25, "cat-kids": 25, "group": 25}
SAMPLE_CAP = 60                          # counts 兼容样本上限（设计§三原 3 页×20 口径）


class QuotaHit(Exception):
    pass


def load_json(path, default):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return default


def save_json(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=1), encoding="utf-8")
    tmp.replace(path)


def log(msg):
    line = f"[{datetime.now().isoformat(timespec='seconds')}] {msg}"
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")
    print(line)


def request_page(key, keyword, city, page, offset, interval):
    """v3 place/text 单页；city=None 全国搜（场景⑤）。返回 (pois, count)。"""
    params = {"keywords": keyword, "offset": offset, "page": page, "key": key,
              "extensions": "base"}
    if city:
        params["city"] = city
        params["citylimit"] = "true"
    url = "https://restapi.amap.com/v3/place/text?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(
        url, headers={"User-Agent": "radar-collect/1.0 (personal use)"})
    err = None
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as e:   # 网络/解析异常捕获（P2①：不向上抛，防连带跳过点评线）
        err = f"network_error={type(e).__name__}: {e}"
    time.sleep(interval)
    if err:
        return [], 0, err
    if data.get("status") != "1":
        err = f"api_status={data.get('status')} info={data.get('info')}"
        if any(m in str(data.get("info", "")).upper() for m in QUOTA_MARKS):
            raise QuotaHit(err)
        return [], 0, err
    pois = data.get("pois") or []
    return pois, int(data.get("count") or 0), None


def haversine(lng1, lat1, lng2, lat2):
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lng2 - lng1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(a))


def poi_brief(p):
    loc = (p.get("location") or "").split(",")
    try:
        lng, lat = float(loc[0]), float(loc[1])
    except (IndexError, ValueError):
        lng = lat = None
    biz = p.get("biz_ext") or {}
    rating = biz.get("rating")
    if isinstance(rating, list):
        rating = None
    return {"poi_id": p.get("id"), "name": p.get("name"), "type": p.get("type"),
            "address": p.get("address"), "province": p.get("pname"),
            "city": p.get("cityname"), "district": p.get("adname"),
            "rating": rating, "lng": lng, "lat": lat}


# ---------- 输入源 ----------

def cities_list():
    return sorted(load_json(CITY_IDS, {}).keys())


_BRAND_CACHE = None


def brands():
    global _BRAND_CACHE
    if _BRAND_CACHE is None:
        data = load_json(SEED_BRANDS, {}).get("brands") or []
        _BRAND_CACHE = [(b["slug"], b.get("name"), (b.get("keywords") or [b.get("name")])[0],
                         b.get("keywords") or []) for b in data if b.get("slug")]
    return _BRAND_CACHE


def alias_plan():
    """ym154：{slug: [补充采集别名,...]}。只收检索效果不同的真实挂牌名（大小写变体不收）。"""
    data = load_json(KW_ALIAS, {})
    plan = data.get("brands") or {}
    return {slug: [w for w in (rec.get("aliases") or []) if w]
            for slug, rec in plan.items() if rec.get("aliases")}


def group_words():
    groups = load_json(KW_GROUP, {}).get("groups") or []
    return [(g.get("group"), w) for g in groups for w in g.get("lines") or []]


def category_words():
    data = load_json(KW_CATEGORY, {})
    return data.get("mall") or [], data.get("kids") or []


def mall_pool():
    """匹配池：419 已补坐标商场 + 候选池新商场（若有）。返回 [(ref, name, city, lng, lat)]。"""
    pool = []
    for slug, rec in (load_json(MALL_COORDS, {}) or {}).items():
        pool.append((slug, rec.get("name") or rec.get("poi_name") or "",
                     rec.get("city"), rec.get("lng"), rec.get("lat"), "seed"))
    for poi_id, rec in (load_json(F_MALL_CAND, {}) or {}).items():
        pool.append((poi_id, rec.get("name") or "", rec.get("city"),
                     rec.get("lng"), rec.get("lat"), "candidate"))
    return pool


def norm_name(name):
    for ch in "（）()·—- ":
        name = name.replace(ch, "")
    return name.upper().replace("广场", "").replace("购物中心", "")


def match_seed(poi, pool, city):
    """同场判定（设计§七）：归一名互含 或 同城坐标<SAME_MALL_M。返回 ref 或 None。"""
    nm = norm_name(poi.get("name") or "")
    best = None
    for ref, pname, pcity, lng, lat, kind in pool:
        if nm and pname and len(nm) >= 3:
            pn = norm_name(pname)
            if pn and (pn in nm or nm in pn) and min(len(pn), len(nm)) >= 3:
                if pcity in (None, "", city):
                    return ref
        if poi.get("lng") is not None and lng is not None and \
                (pcity in (None, "", city)) and city:
            d = haversine(poi["lng"], poi["lat"], lng, lat)
            if d < SAME_MALL_M and (best is None or d < best[1]):
                best = (ref, d)
    return best[0] if best else None


# ---------- 场景任务队列与执行 ----------

def task_keys(scenario, cities, brand_filter=None, city_filter=None, word_filter=None):
    cs = city_filter or cities
    keys = []
    if scenario == "brands":
        bf = set(brand_filter or [])
        # 两段式队列（ym154）：全部主词键在前（主轮 ym118 跑完），别名键在后
        # （增量轮在主轮结束后同队列自动衔接，预算/游标/配额自停机制共用）。
        for slug, name, primary, _ in brands():
            if bf and slug not in bf:
                continue
            for c in cs:
                keys.append((f"brands|{slug}|{c}", (slug, c, None)))
        plan = alias_plan()
        for slug, aliases in plan.items():
            if bf and slug not in bf:
                continue
            for a in aliases:
                for c in cs:
                    keys.append((f"brands|{slug}|{c}|@{a}", (slug, c, a)))
    elif scenario == "cat-mall":
        words, _ = category_words()
        for c in cs:
            for w in words:
                keys.append((f"cat-mall|{c}|{w}", (c, w)))
    elif scenario == "cat-kids":
        _, words = category_words()
        for c in cs:
            for w in words:
                keys.append((f"cat-kids|{c}|{w}", (c, w)))
    elif scenario == "group":
        wf = set(word_filter or [])
        for grp, w in group_words():
            if wf and w not in wf:
                continue
            for c in cs:
                keys.append((f"group|{w}|{c}", (grp, w, c)))
    return keys


def run_brands(key, slug, city, interval, state, alias=None):
    """ym118：全量翻页（≤40页/城）——count 对账 + 分门店档案双写。

    counts 条目保持兼容（count/countCapped/pageCapped/sample[60]/fetchedAt），新增 province；
    brand-stores.json 按品牌存全量门店（poi_id 为键，跨城去重、增量补齐）。
    ym154 别名轮（alias 非 None）：用别名检索，对账写 aliasCities 独立面
    （主词 cities[city].count 口径不动），stores 只收店名含本品牌任一词的 POI
    （别名检索面更宽，同名异物噪声拦截）。"""
    brand = next(b for b in brands() if b[0] == slug)
    _, name, primary, kws = brand
    word = alias or primary
    counts = load_json(F_COUNTS, {})
    stores_all = load_json(F_STORES, {})
    entry = counts.get(slug) or {"brandName": name, "cities": {}}
    got, total, err, last_len, pages = [], 0, None, 0, 0
    for page in range(1, PAGES["brands"] + 1):
        pois, cnt, e = request_page(key, word, city, page, OFFSET["brands"], interval)
        if e:
            err = e
            break
        if cnt:
            total = cnt          # 尾部空页会回 count=0：真值只接受非零（ym118 审计 P1 修复）
        last_len = len(pois)
        pages = page
        got.extend(poi_brief(p) for p in pois)
        if last_len < OFFSET["brands"]:
            break                      # 末页（不足一页）
        if 0 < cnt < 800 and len(got) >= cnt:
            break                      # count 可信且已取满（count≥800=假 cap 值，不据此截断）
    if err and not got:
        return "error", err
    seen, uniq = set(), []
    for p in got:
        if p.get("poi_id") and p["poi_id"] not in seen:
            seen.add(p["poi_id"])
            uniq.append(p)
    page_capped = last_len == OFFSET["brands"] and len(uniq) < total
    stamped = datetime.now().isoformat(timespec="seconds")
    if alias:
        # 过滤表须并入当前 alias（审计P1#1）：店名只含别名词的 POI 否则被自家过滤器误杀
        kept = [p for p in uniq
                if match_brand_of(p["name"], [(slug, name, primary, [alias] + list(kws) or [primary])])]
        be = stores_all.get(slug) or {"brandName": name, "stores": {}}
        for p in kept:
            be["stores"][p["poi_id"]] = {**p, "fetchedAt": stamped}
        stores_all[slug] = be
        save_json(F_STORES, stores_all)
        entry.setdefault("aliasCities", {}).setdefault(city, {})[alias] = {
            "count": total, "kept": len(kept), "raw": len(uniq), "fetchedAt": stamped,
            "sample": kept[:10]}   # kept 样本留档供混入型噪声目检（审计P1#3：kept/raw 测不出混入，目检判据用 sample）
        counts[slug] = entry
        save_json(F_COUNTS, counts)
        return "ok", (f"alias[{alias}] count={total} kept={len(kept)} raw={len(uniq)} "
                      f"total={len(be['stores'])} pages={pages}")
    province = next((p.get("province") for p in uniq if p.get("province")), None)
    entry["cities"][city] = {"count": total,
                             "countCapped": total >= 800,  # 高德大词 count 假 cap 值防御
                             "pageCapped": page_capped,    # 翻页上限截断（设计§三到顶标记）
                             "province": province,
                             "sample": uniq[:SAMPLE_CAP],
                             "fetchedAt": datetime.now().isoformat(timespec="seconds")}
    counts[slug] = entry
    save_json(F_COUNTS, counts)
    be = stores_all.get(slug) or {"brandName": name, "stores": {}}
    for p in uniq:
        be["stores"][p["poi_id"]] = {**p, "fetchedAt": stamped}
    stores_all[slug] = be
    save_json(F_STORES, stores_all)
    return "ok", f"count={total} fetched={len(uniq)} total={len(be['stores'])} pages={pages}"


def run_cat_mall(key, city, word, interval):
    malls_all = load_json(F_CITY_MALLS, {})
    cand = load_json(F_MALL_CAND, {})
    pool = mall_pool()
    got, err = [], None
    last_len, cnt_total = 0, 0
    for page in range(1, PAGES["cat-mall"] + 1):
        pois, cnt, e = request_page(key, word, city, page, OFFSET["cat-mall"], interval)
        if e:
            err = e
            break
        last_len, cnt_total = len(pois), cnt
        got.extend(poi_brief(p) for p in pois)
        if len(pois) < OFFSET["cat-mall"] or len(got) >= cnt:
            break
    if err and not got:
        return "error", err
    page_capped = last_len == OFFSET["cat-mall"] and len(got) < cnt_total
    ce = malls_all.get(city) or {}
    ce[word] = {"pois": got, "pageCapped": page_capped,
                "fetchedAt": datetime.now().isoformat(timespec="seconds")}
    malls_all[city] = ce
    save_json(F_CITY_MALLS, malls_all)
    new_c = 0
    for p in got:
        if p["poi_id"] in cand or match_seed(p, pool, city):
            continue
        cand[p["poi_id"]] = {**p, "discoveredFrom": "cat-mall",
                             "needsReview": not (p.get("type") or "").startswith("购物服务"),
                             "fetchedAt": datetime.now().isoformat(timespec="seconds")}
        new_c += 1
    save_json(F_MALL_CAND, cand)
    return "ok", f"pois={len(got)} newCandidates={new_c}"


def match_brand_of(poi_name, brand_table):
    """店名→品牌（场景③④）：品牌任一变体词 upper 互含（词长≥2）。"""
    nm = (poi_name or "").upper()
    for slug, name, _, kws in brand_table:
        for kw in kws or [name]:
            kwu = (kw or "").upper()
            if len(kwu) >= 2 and kwu in nm:
                return slug
    return None


def run_cat_kids(key, city, word, interval):
    kids_all = load_json(F_CITY_KIDS, {})
    presence = load_json(F_PRESENCE, {})
    brand_table = brands()
    got, err = [], None
    for page in range(1, PAGES["cat-kids"] + 1):
        pois, cnt, e = request_page(key, word, city, page, OFFSET["cat-kids"], interval)
        if e:
            err = e
            break
        got.extend(poi_brief(p) for p in pois)
        if len(pois) < OFFSET["cat-kids"] or len(got) >= cnt:
            break
    if err and not got:
        return "error", err
    ce = kids_all.get(city) or {}
    ce[word] = {"pois": got, "fetchedAt": datetime.now().isoformat(timespec="seconds")}
    kids_all[city] = ce
    save_json(F_CITY_KIDS, kids_all)
    for p in got:
        slug = match_brand_of(p["name"], brand_table)
        if not slug:
            continue
        pe = presence.get(slug) or {"cities": {}}
        ce2 = pe["cities"].get(city) or {"count": 0, "pois": []}
        ce2["count"] += 1
        ce2["pois"].append({"poi_id": p["poi_id"], "name": p["name"],
                            "lng": p["lng"], "lat": p["lat"]})
        pe["cities"][city] = ce2
        presence[slug] = pe
    save_json(F_PRESENCE, presence)
    return "ok", f"pois={len(got)} matchedBrands={sum(1 for p in got if match_brand_of(p['name'], brand_table))}"


def run_group(key, grp, word, city, interval):
    """场景⑤（施工修正：v3 无 city 全国搜实测不可用——count=0/假值，退回城市限定搜）。
    count 字段对大词返回 800/1000 假 cap 值，分布以名过滤后的实取 POI 为准；
    翻页短程（≤2 页）：页<25 条或名过滤后累计≥20 即止。泛词噪声（K11 公交站类）
    靠名过滤（去括号后含集团词）剔除。"""
    projects = load_json(F_GROUP, {})
    pool = mall_pool()
    wu = word.upper()
    got, err = [], None
    for page in (1, 2):
        pois, cnt, e = request_page(key, word, city, page, OFFSET["group"], interval)
        if e:
            err = e
            break
        kept = [poi_brief(p) for p in pois
                if wu in (p.get("name") or "").split("(")[0].upper()]
        got.extend(kept)
        if len(pois) < OFFSET["group"] or len(got) >= 20:
            break
    if err and not got:
        return "error", err
    cand = load_json(F_MALL_CAND, {})
    new_c = 0
    for p in got:
        if p["poi_id"] in cand or match_seed(p, pool, city):
            continue
        cand[p["poi_id"]] = {**p, "discoveredFrom": "group-line",
                             "needsReview": not (p.get("type") or "").startswith("购物服务"),
                             "fetchedAt": datetime.now().isoformat(timespec="seconds")}
        new_c += 1
    save_json(F_MALL_CAND, cand)
    we = projects.get(word) or {"group": grp, "cities": {}}
    we["cities"][city] = {"pois": got,
                          "note": "v3 count 对集团词返回假 cap 值不可信，分布以名过滤实取为准",
                          "fetchedAt": datetime.now().isoformat(timespec="seconds")}
    projects[word] = we
    save_json(F_GROUP, projects)
    return "ok", f"pois={len(got)} newCandidates={new_c}"


RUNNERS = {"brands": run_brands, "cat-mall": run_cat_mall,
           "cat-kids": run_cat_kids, "group": run_group}
SCENARIO_ORDER = ["brands", "cat-mall", "cat-kids", "group"]


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--scenario", default="all",
                    choices=["all", "brands", "cat-mall", "cat-kids", "group", "proximity"])
    ap.add_argument("--budget", type=int, default=2000, help="本轮请求预算（设计§四）")
    ap.add_argument("--brands", default="", help="逗号分隔 slug 过滤（试点用）")
    ap.add_argument("--cities", default="", help="逗号分隔城市过滤（试点用）")
    ap.add_argument("--words", default="", help="逗号分隔集团词过滤（试点用）")
    args = ap.parse_args(argv)

    if args.scenario == "proximity":
        run_proximity()
        return 0

    cfg = load_json(CONFIG, {})
    key = (cfg.get("amap_key") or "").strip()
    if not key:
        log("amap_key 未配置，本轮跳过")
        return 0
    interval = float(cfg.get("request_interval_sec", 3))
    state = load_json(STATE, {})
    if state.get("quotaHitAt"):
        log(f"配额停线标志在案（{state['quotaHitAt']}），扩充线暂停——人工确认后删该字段复跑（封了再议口径）")
        return 0
    cities = cities_list()
    city_f = [c for c in args.cities.split(",") if c] or None
    brand_f = [b for b in args.brands.split(",") if b] or None
    word_f = [w for w in args.words.split(",") if w] or None
    scenarios = SCENARIO_ORDER if args.scenario == "all" else [args.scenario]

    used = 0
    req_count = [0]
    _orig_request_page = request_page

    def counted_page(k, kw, city, page, off, iv):
        req_count[0] += 1
        if req_count[0] > args.budget:
            raise QuotaHit("budget_exhausted")
        return _orig_request_page(k, kw, city, page, off, iv)

    globals()["request_page"] = counted_page

    for sc in scenarios:
        done = set(state.get("done", {}).get(sc) or [])
        keys = task_keys(sc, cities, brand_f, city_f, word_f)
        todo = [(k, t) for k, t in keys if k not in done]
        log(f"场景 {sc}：队列 {len(keys)} 待办 {len(todo)}（预算余 {args.budget - used}）")
        for tk, task in todo:
            try:
                if sc == "brands":
                    res, info = run_brands(key, task[0], task[1], interval, state, task[2])
                else:
                    res, info = RUNNERS[sc](key, *task, interval)
            except QuotaHit as qh:
                if str(qh) == "budget_exhausted":
                    log(f"本轮预算 {args.budget} 用尽，收工（明晚续跑）")
                else:
                    state["quotaHitAt"] = datetime.now().isoformat(timespec="seconds")
                    state["quotaHitInfo"] = str(qh)
                    save_json(STATE, state)
                    log(f"配额/风控信号触顶：{qh}——停线报命主（封了再议）")
                save_json(STATE, state)
                return 0
            used = req_count[0]
            if res == "ok":
                done.add(tk)
                state.setdefault("done", {})[sc] = sorted(done)
                save_json(STATE, state)
                log(f"OK {tk}: {info}")
            else:
                log(f"FAIL {tk}: {info}")
        log(f"场景 {sc} 本段完成，累计请求 {used}")
    state["lastRunAt"] = datetime.now().isoformat(timespec="seconds")
    save_json(STATE, state)
    log(f"本轮结束：请求 {used}/{args.budget}")
    run_proximity()   # 数据有增量后图谱自动重算（纯本地）
    return 0


# ---------- 场景⑥：邻近匹配+店名内嵌双信号（本地） ----------

def run_proximity():
    pool = mall_pool()
    if not pool:
        log("邻近匹配：商场池为空，跳过")
        return
    entries = []   # (brandSlug, brandName, poiName, lng, lat, srcScenario)
    counts = load_json(F_COUNTS, {})
    for slug, entry in counts.items():
        for city, ce in (entry.get("cities") or {}).items():
            for s in ce.get("sample") or []:
                if s.get("lng") is not None:
                    entries.append((slug, entry.get("brandName"), s["name"],
                                    s["lng"], s["lat"], "brands"))
    kids = load_json(F_CITY_KIDS, {})
    brand_table = brands()
    for city, words in kids.items():
        for word, we in words.items():
            for p in we.get("pois") or []:
                slug = match_brand_of(p.get("name"), brand_table)
                if slug and p.get("lng") is not None:
                    entries.append((slug, next(b[1] for b in brand_table if b[0] == slug),
                                    p["name"], p["lng"], p["lat"], "cat-kids"))
    graph = []
    for slug, bname, pname, lng, lat, src in entries:
        best = None
        for ref, mname, mcity, mlng, mlat, kind in pool:
            if mlng is None:
                continue
            d = haversine(lng, lat, mlng, mlat)
            if d > WEAK_M:
                continue
            conf = "strong" if d <= STRONG_M else "weak"
            cand = (ref, mname, d, conf, kind)
            if best is None or (cand[3], cand[2]) < (best[3], best[2]):
                best = cand
        name_embed = None
        pnu = (pname or "").upper()
        for ref, mname, mcity, mlng, mlat, kind in pool:
            mnu = norm_name(mname or "")
            if len(mnu) >= 4 and mnu in pnu:
                name_embed = (ref, mname, kind)
                break
        if name_embed and (best is None or name_embed[0] != best[0]):
            graph.append({"brandSlug": slug, "brand": bname, "mallRef": name_embed[0],
                          "mallName": name_embed[1], "mallKind": name_embed[2],
                          "signal": "name-embed",
                          "confidence": "strong", "distance": None,
                          "needsReview": True, "srcScenario": src,
                          "note": "店名指向与坐标最近场不一致"})
        elif best:
            graph.append({"brandSlug": slug, "brand": bname, "mallRef": best[0],
                          "mallName": best[1], "mallKind": best[4], "signal": "coords",
                          "confidence": best[3], "distance": round(best[2], 1),
                          "needsReview": best[3] == "weak", "srcScenario": src})
    save_json(F_TENANCY, graph)
    strong = sum(1 for g in graph if g["confidence"] == "strong")
    log(f"邻近匹配图谱：{len(graph)} 对（strong {strong} / weak {len(graph) - strong}）"
        f"← 门店样本 {len(entries)} × 商场池 {len(pool)}")
    # 候选新品牌：③④未匹配种子品牌的高频店名（人工审，不改种子）
    freq = {}
    for city, words in kids.items():
        for word, we in words.items():
            for p in we.get("pois") or []:
                if match_brand_of(p.get("name"), brand_table):
                    continue
                core = (p.get("name") or "").split("(")[0].strip()
                if len(core) >= 2:
                    freq.setdefault(core, {"count": 0, "cities": set()})
                    freq[core]["count"] += 1
                    freq[core]["cities"].add(city)
    cand_brands = {k: {"count": v["count"], "cities": sorted(v["cities"])}
                   for k, v in freq.items() if v["count"] >= 3 or len(v["cities"]) >= 2}
    save_json(F_BRAND_CAND, cand_brands)
    if cand_brands:
        log(f"候选新品牌（高频未匹配店名，人工审）：{len(cand_brands)} 个")


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
