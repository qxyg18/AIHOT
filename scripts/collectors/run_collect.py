"""童装雷达·商户数据采集夜间调度器。

命主授权口径（2026-09-30）：非商用自用、全权操作、低频慢查、月更全量+日更增量、封了再议。
调度=schtasks radar-merchant-collect 每日 02:30（半夜慢跑）。
凭据=D:/secrets/radar-collect/config.json（amap_key / dianping_cookie），未配置则本轮静默跳过。
语义：
  高德 POI=增量补坐标+失败重试；每月 1-3 日窗口全量刷新（评分随月更）；
  点评热度=个人号滴灌（每晚约20家、25秒+抖动，约三周一圈=月更），探针一次先行；
  名录扩容不在本管线（走联商/赢商公开榜单人工通道，zw19 口径）。
"""
import json
import sys
import time
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
CONFIG = Path("D:/secrets/radar-collect/config.json")
LOG = HERE / "logs" / "run.log"
LOCK = HERE / "state" / "run.lock"
LOCK_STALE_SEC = 6 * 3600


def load_json(path, default):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return default


def log(msg):
    line = f"[{datetime.now().isoformat(timespec='seconds')}] {msg}"
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")
    print(line)


def main():
    if LOCK.exists():
        age = time.time() - LOCK.stat().st_mtime
        if age < LOCK_STALE_SEC:
            log(f"上一轮仍在运行（锁龄 {int(age)}s），本轮跳过")
            return 0
        log(f"发现陈旧锁（锁龄 {int(age)}s），接管")
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    LOCK.write_text(str(datetime.now()), encoding="utf-8")
    try:
        cfg = load_json(CONFIG, {})
        key = (cfg.get("amap_key") or "").strip()
        cookie = (cfg.get("dianping_cookie") or "").strip()
        if not key and not cookie:
            log("凭据未配置（D:/secrets/radar-collect/config.json），本轮跳过")
            return 0
        if key:
            import collect_amap
            if collect_amap.refresh_due(load_json(collect_amap.STATE, {}), cfg):
                collect_amap.main("refresh")
            else:
                collect_amap.main("incremental")
            # ym81 扩充线（品牌词/品类词/集团词，设计§四分账：月更窗 1-3 日让位至 80，
            # 常态 2000/班（2026-10-07 命主升配令由 500 调档）；quotaHit 停线标志由引擎自查跳过，人工清除后复跑；
            # 异常隔离——扩充线故障（含 import 失败）不得连带跳过点评线）
            budget = 80 if datetime.now().day <= 3 else 2000
            try:
                import collect_amap_expand
                collect_amap_expand.main(["--scenario", "all", "--budget", str(budget)])
            except Exception as e:
                log(f"扩充线异常（不影响点评线）：{type(e).__name__}: {e}")
            # ym118：门店档案产物同步进站点库（宿主拷入 api 容器→容器内落库；
            # 产物未变化自动跳过；失败只记日志，不阻断点评线）
            try:
                import sync_brand_stores
                rc, tag = sync_brand_stores.main()
                log(f"门店档案同步：{tag}")
            except Exception as e:
                log(f"门店档案同步异常（不影响主管线）：{type(e).__name__}: {e}")
        if cookie:
            import collect_dianping
            collect_dianping.main([])
        log("本轮调度结束")
        return 0
    finally:
        LOCK.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
