"""大众点评热度采集（滴灌模式）。

口径（命主 2026-09-30 授权）：非商用自用、个人号、不允许高速抓、模拟正常使用。
节奏=滴灌：每晚只抓 dianping_pages_per_night（默认20）家，dianping_interval_sec（默认25）秒间隔
+随机抖动，约三周覆盖全库一圈，即月更节奏。探针先行存原始页供解析层开发；
解析层（评分/评论数提取）待真实页面样本到位后补写。
城市 ID 仅内置高置信四城（1上海/2北京/3广州/4深圳），其余记录跳过待解析阶段补表。
"""
import json
import random
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
SEED = REPO / "database" / "seeds" / "lb-malls-2026-10.json"
OUT = HERE / "out" / "dianping"
STATE = HERE / "state" / "dianping-state.json"
LOG = HERE / "logs" / "dianping.log"
CONFIG = Path("D:/secrets/radar-collect/config.json")
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")
CITY_IDS = {"上海": 1, "北京": 2}
# 全量城市ID=resolve_city_ids.py 一次性解析结果（城市首页 cityId 字段），
# 内置表只保留实测确认的两城；其余以 sidecar 为准（文件不存在时仅四城兜底的旧猜测已废）。
_city_ids_sidecar = HERE / "state" / "city-ids.json"
if _city_ids_sidecar.exists():
    try:
        CITY_IDS.update(json.loads(_city_ids_sidecar.read_text(encoding="utf-8")))
    except Exception:
        pass

LOGIN_MARKS = ("account.dianping.com", "mlogin.dianping.com", "pclogin",
               "passport", "login")


def load_json(path, default):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return default


def save_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")


def log(msg):
    line = f"[{datetime.now().isoformat(timespec='seconds')}] {msg}"
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")
    print(line)


def fetch_html(url, cookie):
    req = urllib.request.Request(url, headers={
        "User-Agent": UA,
        "Cookie": cookie,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "zh-CN,zh;q=0.9",
        "Referer": "https://www.dianping.com/",
    })
    with urllib.request.urlopen(req, timeout=25) as resp:
        body = resp.read().decode("utf-8", errors="replace")
        final_url = resp.geturl()
        status = resp.status
    login_wall = any(mark in final_url for mark in LOGIN_MARKS)
    return {"status": status, "final_url": final_url,
            "login_wall": login_wall, "html": body}


def search_url(city, name):
    cid = CITY_IDS.get(city)
    if cid is None:
        return None
    return f"https://www.dianping.com/search/keyword/{cid}/0_{urllib.parse.quote(name)}"


def sleep_like_human(interval):
    time.sleep(interval + random.uniform(0, interval * 0.4))


def probe(cookie, interval):
    """探针：抓 3 页存原始 HTML + 记录重定向/登录墙成色，供解析层开发。"""
    state = load_json(STATE, {})
    if state.get("probe", {}).get("done"):
        return 0
    malls = load_json(SEED, {}).get("malls") or []
    picks = [m for m in malls if m.get("city") in CITY_IDS][:3]
    results = []
    for m in picks:
        url = search_url(m.get("city"), m["name"])
        if url is None:
            continue
        try:
            r = fetch_html(url, cookie)
        except Exception as exc:  # 网络层失败也要记录成色
            r = {"status": None, "final_url": "", "login_wall": False,
                 "html": "", "error": repr(exc)}
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / f"probe-{m['slug']}-{stamp}.html").write_text(r["html"], encoding="utf-8")
        keep = {k: r[k] for k in ("status", "final_url", "login_wall") if k in r}
        keep.update({"slug": m["slug"], "name": m["name"], "url": url})
        if "error" in r:
            keep["error"] = r["error"]
        results.append(keep)
        log(f"PROBE {m['slug']} {m['name']}: status={keep.get('status')} "
            f"login_wall={keep.get('login_wall')} final={keep.get('final_url')[:80]}")
        sleep_like_human(interval)
    state["probe"] = {"done": True, "at": datetime.now().isoformat(timespec="seconds"),
                      "results": results}
    save_json(STATE, state)
    walls = sum(1 for r in results if r.get("login_wall"))
    log(f"探针完成：{len(results)} 页，登录墙 {walls} 页；解析层开发样本在 out/dianping/")
    return 0


def trickle(cookie, interval, per_night):
    """滴灌：每晚抓最久未抓的 per_night 家，全库覆盖一圈即月更闭环。"""
    malls = load_json(SEED, {}).get("malls") or []
    state = load_json(STATE, {})
    pages = state.setdefault("pages", {})
    candidates = [m for m in malls if search_url(m.get("city") or "", m["name"])]
    ranked = sorted(candidates,
                    key=lambda m: (pages.get(m["slug"], {}) or {}).get("at") or "")
    targets = ranked[:per_night]
    log(f"滴灌本轮 {len(targets)} 家（库内可抓 {len(candidates)}，间隔 {interval}s+抖动）")
    ok = failed = walled = 0
    now = datetime.now().isoformat(timespec="seconds")
    for m in targets:
        url = search_url(m.get("city") or "", m["name"])
        try:
            r = fetch_html(url, cookie)
        except Exception as exc:
            failed += 1
            log(f"FAIL {m['slug']}: {exc!r}")
            sleep_like_human(interval)
            continue
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / f"{m['slug']}.html").write_text(r["html"], encoding="utf-8")
        pages[m["slug"]] = {"at": datetime.now().isoformat(timespec="seconds"),
                            "status": r["status"], "login_wall": r["login_wall"]}
        ok += 1
        if r["login_wall"]:
            walled += 1
            log(f"WALL {m['slug']} {m['name']}（cookie 失效信号）")
        sleep_like_human(interval)
    if candidates and all(pages.get(m["slug"]) for m in candidates):
        state["lastFullPass"] = now
        state["lastFullPassStats"] = {"covered": len(candidates)}
        log("全库覆盖一圈完成，月更周期闭环")
    save_json(STATE, state)
    log(f"滴灌完成：成功 {ok} 失败 {failed} 登录墙 {walled}")
    return 0


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    cfg = load_json(CONFIG, {})
    cookie = (cfg.get("dianping_cookie") or "").strip()
    if not cookie:
        log("dianping_cookie 未配置，本轮跳过")
        return 0
    interval = float(cfg.get("dianping_interval_sec", 25))
    per_night = int(cfg.get("dianping_pages_per_night", 20))
    if "--full" in argv:
        log(f"手动全量模式：一轮抓完可抓库（间隔仍为 {interval}s 慢速）")
        trickle(cookie, interval, 10 ** 9)
        return 0
    probe(cookie, interval)
    trickle(cookie, interval, per_night)
    return 0


if __name__ == "__main__":
    sys.exit(main())
