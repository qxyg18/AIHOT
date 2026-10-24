# -*- coding: utf-8 -*-
"""采集线宿主时区显式化（ym670/C1-03）。

问题：原实现直接用宿主 datetime.now()——Windows 宿主=中国时区无感，Linux 容器默认
UTC 会让夜档窗口（1-6 点）、月更窗（每月 1-3 日）、日期键全部漂移。
本模块把「本地时间」固定为 Asia/Shanghai（可用环境变量 RADAR_TZ 覆写），
zoneinfo 数据缺失时退化为固定 +08:00（中国 1991 年后无夏令时，日常口径等价）。
"""
import os
import sys
from datetime import datetime, timedelta, timezone

TZ_NAME = os.environ.get("RADAR_TZ", "Asia/Shanghai")

try:
    from zoneinfo import ZoneInfo
    TZ = ZoneInfo(TZ_NAME)
except Exception:  # ImportError（Python<3.9）或 ZoneInfoNotFoundError（tzdata 缺失）
    if TZ_NAME != "Asia/Shanghai":
        # 审计 I3 销项：非默认时区在无 zoneinfo 数据时会静默按 +08:00 算——显式告警
        sys.stderr.write(
            "[radar_time] 警告：zoneinfo 不可用（缺 tzdata？），RADAR_TZ=%s 无法解析，"
            "按固定 +08:00 计算\n" % TZ_NAME)
    TZ = timezone(timedelta(hours=8), TZ_NAME)


def now_local():
    """采集线统一的「现在」（带显式时区）。"""
    return datetime.now(TZ)


def parse_local(value):
    """解析既有 iso 时间戳：naive（历史落盘，按本地时区补全）→ aware，便于相减。"""
    d = datetime.fromisoformat(value)
    return d.replace(tzinfo=TZ) if d.tzinfo is None else d
