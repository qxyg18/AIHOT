"""高德 POI 搜索：为商业体种子补坐标+评分（GCJ-02，高德原生坐标系）。

口径（命主 2026-09-30 授权）：非商用自用、低频慢查、正常通道、月更全量+日更增量。
接口=v3 place/text（keywords+city 城市限定）：商场类 POI 首条命中质量高，
且 biz_ext.rating 对购物中心有评分（ym8「商场无评分」结论已按实测修正），评分随月更刷新。
选点策略：同名>双向包含（短名优先）+购物类加分；非购物类命中时去城市前缀重搜一次，
仍非购物则打 needsReview 标记待人工复核。
输出 out/mall-coords.json（slug -> POI 档案），不改种子文件本体；并入种子是后续人工审过的独立步骤。
"""
import json
import os
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SEED = REPO / "database" / "seeds" / "lb-malls-2026-10.json"
OUT = HERE / "out" / "mall-coords.json"
STATE = HERE / "state" / "amap-state.json"
LOG = HERE / "logs" / "amap.log"
sys.path.insert(0, str(HERE))  # 直跑/被导入两种入口都可解析同目录共享件
from radar_time import now_local, parse_local  # noqa: E402  （宿主时区显式化，ym670/C1-03）

# 凭据路径：平台条件默认 + 环境变量 RADAR_COLLECT_CONFIG 覆写（同 run_collect.py）
CONFIG = Path(os.environ.get("RADAR_COLLECT_CONFIG")
              or ("D:/secrets/radar-collect/config.json" if os.name == "nt"
                  else "/srv/secrets/radar-collect/config.json"))

QUOTA_MARKS = ("CUOTAS", "LIMIT", "EXCEED")


def load_json(path, default):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return default


def log(msg):
    line = f"[{now_local().isoformat(timespec='seconds')}] {msg}"
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")
    print(line)


def request_once(key, keyword, city, interval):
    url = "https://restapi.amap.com/v3/place/text?" + urllib.parse.urlencode(
        {"keywords": keyword, "city": city, "citylimit": "true",
         "offset": 5, "page": 1, "key": key})
    req = urllib.request.Request(
        url, headers={"User-Agent": "radar-collect/1.0 (personal use)"})
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    finally:
        time.sleep(interval)
    if data.get("status") != "1":
        return {"error": f"api_status={data.get('status')} info={data.get('info')}"}
    pois = data.get("pois") or []
    if not pois:
        return {"error": "no_result"}
    return {"pois": pois}


def poi_score(p, name):
    n = p.get("name") or ""
    s = -1
    if n == name:
        s = 100
    elif name in n or n in name:
        s = 50 - min(len(n), 40)  # 同为包含命中时，名越短越接近纯实体（防选中「XX-母婴室」类附属点）
    if (p.get("type") or "").startswith("购物服务"):
        s += 30
    return s


def pick_poi(pois, name):
    best = max(((poi_score(p, name), -i, p) for i, p in enumerate(pois)),
               key=lambda t: (t[0], t[1]))
    return best[2]


def to_record(picked, name, m, now, alt_keyword=None):
    location = picked.get("location") or ""
    parts = location.split(",")
    if len(parts) != 2:
        return {"error": "bad_location"}
    biz = picked.get("biz_ext") or {}
    rating = biz.get("rating")
    if isinstance(rating, list):
        rating = None
    opentime = biz.get("opentime2")
    if isinstance(opentime, list):
        opentime = None
    record = {"poi_id": picked.get("id"), "poi_name": picked.get("name"),
              "type": picked.get("type"), "address": picked.get("address"),
              "district": picked.get("adname"), "tel": picked.get("tel"),
              "opentime": opentime, "rating": rating,
              "lng": float(parts[0]), "lat": float(parts[1]),
              "name": name, "city": m.get("city"), "province": m.get("province"),
              "fetchedAt": now}
    if alt_keyword:
        record["altKeyword"] = alt_keyword
    if not (picked.get("type") or "").startswith("购物服务"):
        record["needsReview"] = True
    return record


def alt_keywords(m):
    name = m.get("name") or ""
    for prefix in filter(None, [m.get("city"), m.get("province")]):
        if name.startswith(prefix) and len(name) > len(prefix) + 1:
            yield name[len(prefix):]


def search_poi(key, m, interval):
    name = m["name"]
    city = m.get("city") or ""
    now = now_local().isoformat(timespec="seconds")
    first = request_once(key, name, city, interval)
    if "error" in first:
        return {"error": first["error"]}
    picked = pick_poi(first["pois"], name)
    if (picked.get("type") or "").startswith("购物服务"):
        return to_record(picked, name, m, now)
    for alt in alt_keywords(m):
        again = request_once(key, alt, city, interval)
        if "error" in again:
            continue
        candidate = pick_poi(again["pois"], alt)
        if (candidate.get("type") or "").startswith("购物服务"):
            return to_record(candidate, name, m, now, alt_keyword=alt)
    return to_record(picked, name, m, now)


def refresh_due(state, cfg):
    window = int(cfg.get("monthly_due_window_days", 3))
    if now_local().day > window:
        return False
    last = state.get("lastRefreshAt")
    if not last:
        return True
    return (now_local() - parse_local(last)).days >= 25


def main(mode="incremental"):
    cfg = load_json(CONFIG, {})
    key = (cfg.get("amap_key") or "").strip()
    if not key:
        log("amap_key 未配置，本轮跳过")
        return 0
    interval = float(cfg.get("request_interval_sec", 3))
    malls = load_json(SEED, {}).get("malls") or []
    coords = load_json(OUT, {})
    state = load_json(STATE, {})
    if mode == "refresh":
        targets = [m for m in malls if m.get("slug")]
        log(f"月更刷新模式：全量 {len(targets)} 家（坐标+评分一起刷新）")
    else:
        targets = []
        for m in malls:
            slug = m.get("slug")
            if not slug or slug in coords:
                continue
            targets.append(m)
        log(f"增量模式：待补 {len(targets)}/{len(malls)}（失败条目每晚自动重试）")
    ok = failed = 0
    for m in targets:
        slug, name = m["slug"], m["name"]
        result = search_poi(key, m, interval)
        now = now_local().isoformat(timespec="seconds")
        if "error" in result:
            failed += 1
            state[slug] = {"error": result["error"], "at": now}
            log(f"FAIL {slug} {name}: {result['error']}")
            if any(mark in result["error"] for mark in QUOTA_MARKS):
                left = len(targets) - ok - failed
                log(f"配额到顶，提前收工，剩余约 {left} 家明晚续跑")
                break
        else:
            result["fetchedAt"] = now
            coords[slug] = result
            state[slug] = {"ok": True, "at": now}
            ok += 1
            flag = " [待复核]" if result.get("needsReview") else ""
            log(f"OK {slug} {name} -> {result['lng']},{result['lat']}"
                f" rating={result.get('rating')} ({result.get('type')}){flag}")
        # 逐条落盘：慢查口径下中断零损失
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(coords, ensure_ascii=False, indent=1), encoding="utf-8")
        STATE.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    if mode == "refresh":
        state["lastRefreshAt"] = now_local().isoformat(timespec="seconds")
        STATE.write_text(json.dumps(state, ensure_ascii=False, indent=1), encoding="utf-8")
    remaining = sum(1 for m in malls if m.get("slug") and m["slug"] not in coords)
    review = sum(1 for v in coords.values() if v.get("needsReview"))
    log(f"本轮完成（{mode}）：成功 {ok} 失败 {failed}，全库剩余待补 {remaining}，待复核 {review}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "incremental"))
