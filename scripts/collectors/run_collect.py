"""童装雷达·商户数据采集调度器（高德=夜档，点评=滴灌）。

命主授权口径（2026-09-30）：非商用自用、全权操作、月更全量+日更增量、封了再议。
命主 2026-10-13 令：高德采集只跑凌晨 1-6 点档（NIGHT 窗）；同日晚修订=20000 次/晚仅限
10-14 凌晨一次性追进度，此后恢复常态额度规划（额度规则引擎单源 night_allowance）。
提速令=官方并发上限 30 次/秒，请求间隔 3s→0.2s（config request_interval_sec）。
调度=schtasks radar-merchant-collect 每小时 :15（窗口外高德段即刻跳过，点评滴灌不受影响）。
凭据路径=环境变量 RADAR_COLLECT_CONFIG（平台缺省见下方 CONFIG 定义；amap_key / dianping_cookie），未配置则本轮静默跳过。
语义：
  高德 POI=增量补坐标+失败重试；每月 1-3 日窗口全量刷新（评分随月更）；
  点评热度=个人号滴灌（每小时一轮约10家、25秒+抖动），探针一次先行；
  名录扩容不在本管线（走联商/赢商公开榜单人工通道，zw19 口径）。
"""
import json
import os
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from radar_time import now_local  # noqa: E402  （宿主时区显式化，ym670/C1-03）
CONFIG = Path(os.environ.get("RADAR_COLLECT_CONFIG")
              or ("D:/secrets/radar-collect/config.json" if os.name == "nt"
                  else "/srv/secrets/radar-collect/config.json"))
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
    line = f"[{now_local().isoformat(timespec='seconds')}] {msg}"
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open("a", encoding="utf-8") as fh:
        fh.write(line + "\n")
    print(line)


def in_night_window(now=None):
    h = (now or now_local()).hour
    return NIGHT_START_HOUR <= h < NIGHT_END_HOUR


def pid_alive(pid):
    """持锁进程存活探测（跨平台三态）：True=存活 / False=确认已死 / None=未知（无法判活）。

    ym670/C1-03 修复（Linux 阻断项）：原实现无条件走 ctypes.windll——POSIX 上
    AttributeError 被异常路径吞成 False，上层误判「持有者已死」立即接管（本机 PID 锁
    在 Linux 形同虚设）。现按平台分派，且探测失败（权限不足/意外错误）严格区别于
    「确认已死」（None≠False，上层只在 False 时立即接管）。
    仅本机 PID 锁语义，不扩展为跨机锁（多机单写者由部署侧保证）。
    """
    try:
        pid = int(pid)
    except (TypeError, ValueError):
        return None
    if pid <= 0:
        return None  # 0/-1 是进程组语义（POSIX）或非法值：无法判活
    if os.name == "nt":
        try:
            import ctypes
            kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        except (ImportError, OSError, AttributeError):
            return None
        PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
        ERROR_INVALID_PARAMETER = 87  # OpenProcess 失败码：目标 pid 不存在
        try:
            handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        except (OverflowError, ValueError, ctypes.ArgumentError):
            return False  # pid 超出 DWORD 范围：不可能存在
        if handle:
            kernel32.CloseHandle(handle)
            return True
        # 失败码区分：ERROR_INVALID_PARAMETER=进程不存在（已死）；其余（如
        # ERROR_ACCESS_DENIED=权限不足）无法确认 → 未知
        return False if ctypes.get_last_error() == ERROR_INVALID_PARAMETER else None
    # POSIX：os.kill(pid, 0) 只做探活、不发信号（Windows 上 os.kill 会真杀进程，故只在
    # 本分支使用）
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False  # ESRCH=进程不存在
    except PermissionError:
        return None  # EPERM=进程存在但无权探测（无法确认是本采集器持有者）→ 未知
    except OverflowError:
        return False  # pid 超出内核可表示范围：不可能存在
    except OSError:
        return None  # 其余异常一律未知（宁放过不误杀）
    if sys.platform.startswith("linux"):
        # 僵尸（已终止未回收）：kill(pid,0) 仍成功，但持有者已死——判死防假死空跑
        try:
            state = Path(f"/proc/{pid}/stat").read_text(encoding="utf-8", errors="replace")
            if state.rsplit(")", 1)[1].split()[0] == "Z":
                return False
        except (OSError, IndexError):
            pass
    return True


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
        alive = pid_alive(holder) if holder is not None else None
        if alive is False:
            # 持有者确认已死（看门狗杀/崩溃）→ 立即接管，不等锁龄（ym565：防夜间档假死空跑）
            log(f"陈旧锁（持有者 pid={holder} 已死，锁龄 {int(age)}s），接管")
        elif age < LOCK_STALE_SEC:
            # 存活或未知（未知≠已死）→ 不立即接管，锁龄内跳过（ym670：Linux 退出码语义）
            reason = "持有者存活" if alive else "无法判活"
            log(f"上一轮仍在运行（{reason}，锁龄 {int(age)}s），本轮跳过")
            return 0
        else:
            log(f"发现陈旧锁（锁龄 {int(age)}s），接管")
    LOCK.parent.mkdir(parents=True, exist_ok=True)
    LOCK.write_text(f"{now_local().isoformat(timespec='seconds')} {os.getpid()}", encoding="utf-8")
    try:
        cfg = load_json(CONFIG, {})
        key = (cfg.get("amap_key") or "").strip()
        cookie = (cfg.get("dianping_cookie") or "").strip()
        if not key and not cookie:
            log(f"凭据未配置（{CONFIG}），本轮跳过")
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
