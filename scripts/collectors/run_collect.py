"""童装雷达·商户数据采集调度器（高德=夜档，点评=滴灌）。

命主授权口径（2026-09-30）：非商用自用、全权操作、月更全量+日更增量、封了再议。
命主 2026-10-13 令：高德采集只跑凌晨 1-6 点档（NIGHT 窗）；同日晚修订=20000 次/晚仅限
10-14 凌晨一次性追进度，此后恢复常态额度规划（额度规则引擎单源 night_allowance）。
提速令=官方并发上限 30 次/秒，请求间隔 3s→0.2s（config request_interval_sec）。
调度=schtasks radar-merchant-collect 每小时 :15（窗口外高德段即刻跳过，点评滴灌不受影响）。
凭据=D:/secrets/radar-collect/config.json（amap_key / dianping_cookie），未配置则本轮静默跳过。
语义：
  高德 POI=增量补坐标+失败重试；每月 1-3 日窗口全量刷新（评分随月更）；
  点评热度=个人号滴灌（每小时一轮约10家、25秒+抖动），探针一次先行；
  名录扩容不在本管线（走联商/赢商公开榜单人工通道，zw19 口径）。
"""
import ctypes
import json
import os
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
# 命主 2026-10-13 令：高德采集固定夜档（凌晨 1-6 点，最后一班可自然延尾）。
NIGHT_START_HOUR = 1
NIGHT_END_HOUR = 6
# 命主 2026-10-13 修订令：20000 次/晚仅限 10-14 凌晨一次性；常态额度规划在引擎单源
# （collect_amap_expand.night_allowance），此处不再自带额度常量防两处漂移。


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


def in_night_window(now=None):
    h = (now or datetime.now()).hour
    return NIGHT_START_HOUR <= h < NIGHT_END_HOUR


def pid_alive(pid):
    """Windows 进程存活探测（os.kill(pid,0) 在 Windows 会真杀进程，禁用）。"""
    try:
        h = ctypes.windll.kernel32.OpenProcess(0x1000, 0, int(pid))  # PROCESS_QUERY_LIMITED_INFORMATION
        if h:
            ctypes.windll.kernel32.CloseHandle(h)
            return True
        return False
    except (ValueError, AttributeError):
        return False


def lock_holder_pid():
    """run.lock 末列=持有进程 pid。兼容多格式（AUD-M1 修复）：旧版仅时间戳（末列含冒号→
    ValueError）/中间版 datetime+pid 三列（末列=pid）/现行版 iso+pid 两列（末列=pid）——
    任何解析失败 → None=无法判活，走锁龄兜底（旧语义不变）。"""
    try:
        parts = LOCK.read_text(encoding="utf-8").split()
        return int(parts[-1]) if parts else None
    except (OSError, ValueError, IndexError):
        return None


def main():
    if LOCK.exists():
        age = time.time() - LOCK.stat().st_mtime
        holder = lock_holder_pid()
        if holder is not None and not pid_alive(holder):
            # 持有者已死（看门狗杀/崩溃）→ 立即接管，不等锁龄（ym565：防夜间档假死空跑）
            log(f"陈旧锁（持有者 pid={holder} 已死，锁龄 {int(age)}s），接管")
        elif age < LOCK_STALE_SEC:
            log(f"上一轮仍在运行（锁龄 {int(age)}s），本轮跳过")
            return 0
        else:
            log(f"发现陈旧锁（锁龄 {int(age)}s），接管")
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    LOCK.write_text(f"{datetime.now().isoformat(timespec='seconds')} {os.getpid()}", encoding="utf-8")
    try:
        cfg = load_json(CONFIG, {})
        key = (cfg.get("amap_key") or "").strip()
        cookie = (cfg.get("dianping_cookie") or "").strip()
        if not key and not cookie:
            log("凭据未配置（D:/secrets/radar-collect/config.json），本轮跳过")
            return 0
        if key:
            if in_night_window() or os.environ.get("AMAP_FORCE") == "1":
                import collect_amap
                if collect_amap.refresh_due(load_json(collect_amap.STATE, {}), cfg):
                    collect_amap.main("refresh")
                else:
                    collect_amap.main("incremental")
                # ym81 扩充线（品牌词/品类词/集团词/商业体品类词）：额度规则引擎单源
                # （collect_amap_expand.night_allowance）——20000 次/晚仅限 10-14 凌晨追进度
                # 一次性，此后恢复常态规划（月更窗 1-3 日让位 80，其余 2000/晚；同晚多班
                # nightUsed 累计共享）；quotaHit 停线标志由引擎自查跳过，人工清除后复跑；
                # 异常隔离——扩充线故障（含 import 失败）不得连带跳过点评线）
                try:
                    import collect_amap_expand
                    collect_amap_expand.main(["--scenario", "all",
                                              "--budget", str(collect_amap_expand.night_allowance())])
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
            else:
                log(f"高德采集不在夜档（{NIGHT_START_HOUR}:00-{NIGHT_END_HOUR}:00），本轮跳过（AMAP_FORCE=1 可手动强跑）")
        if cookie:
            import collect_dianping
            collect_dianping.main([])
        log("本轮调度结束")
        return 0
    finally:
        LOCK.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
