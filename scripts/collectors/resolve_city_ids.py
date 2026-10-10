"""点评城市ID解析器：对种子涉及的每个城市，匿名访问其城市首页一次，
从页面数据（cityId 字段）解析数字 ID，落地 state/city-ids.json。
一次性工具：跑完即归档；25 秒间隔慢查口径；已解析的跳过（可重跑续作）。
"""
import json
import re
import time
import urllib.request
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
SLUGS = HERE / "state" / "city-slugs.json"
OUT = HERE / "state" / "city-ids.json"
LOG = HERE / "logs" / "cityids.log"
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36")


def log(msg):
    line = f"[{datetime.now().isoformat(timespec='seconds')}] {msg}"
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")
    print(line)


def main():
    data = json.loads(SLUGS.read_text(encoding="utf-8"))
    slug_by_name = data["slug_by_name"]
    names = data["names"]
    ids = json.loads(OUT.read_text(encoding="utf-8")) if OUT.exists() else {}
    for name in names:
        if name in ids:
            continue
        slug = slug_by_name.get(name)
        if not slug:
            log(f"SKIP {name}: 无slug")
            continue
        city_id = None
        try:
            req = urllib.request.Request(
                f"https://www.dianping.com/{slug}",
                headers={"User-Agent": UA,
                         "Accept-Language": "zh-CN,zh;q=0.9"})
            with urllib.request.urlopen(req, timeout=20) as resp:
                html = resp.read().decode("utf-8", errors="replace")
            m = re.search(r"cityId['\"]?\s*[:=]\s*['\"]?(\d+)", html)
            if m:
                city_id = int(m.group(1))
        except Exception as exc:
            log(f"FAIL {name} ({slug}): {exc!r}")
        if city_id:
            ids[name] = city_id
            log(f"OK {name} ({slug}) -> {city_id}")
        else:
            log(f"MISS {name} ({slug}): 页面未含cityId")
        OUT.parent.mkdir(parents=True, exist_ok=True)
        OUT.write_text(json.dumps(ids, ensure_ascii=False, indent=1), encoding="utf-8")
        time.sleep(25)
    log(f"解析完成：{len(ids)}/{len(names)}")
    return 0


if __name__ == "__main__":
    main()
