# -*- coding: utf-8 -*-
"""童装雷达采集器内存看门狗（mem_watchdog.pyw）

目的：防止采集器内存膨胀导致整机卡死。常驻隐藏运行，监控所有命令行含
run_collect.py 的 python/pythonw 进程（任意启动方式都能覆盖，无需 pid 文件）：
  - 工作集 ≥ WARN_MB  ：记 WARN 日志（同一进程 10 分钟限一条，防刷屏）
  - 工作集 ≥ KILL_MB  ：杀整个进程树，并清掉孤儿 run.lock（每小时调度自动续跑）
  - 系统可用内存 < SYS_MIN_MB 且存在目标：兜底保机，杀全部目标进程树
识别 = NtQueryInformationProcess 读 PEB 命令行（纯 ctypes，无第三方依赖）。
阈值环境变量可调：MEMWATCH_POLL_SEC / WARN_MB / KILL_MB / SYS_MIN_MB / SAMPLE_SEC。
停止：创建 state/.mem_watchdog.stop（下轮轮询自动退出并删标记）。
日志：logs/mem-watchdog.log（512KB 轮转，与 hide_agent_console 同款）。
"""
import ctypes
import ctypes.wintypes as w
import datetime
import os
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
STATE = HERE / "state"
LOG_PATH = HERE / "logs" / "mem-watchdog.log"
STOP_FLAG = STATE / ".mem_watchdog.stop"
RUN_LOCK = HERE / "state" / "run.lock"
TARGET_MARK = "run_collect.py"
MUTEX_NAME = "RadarMemWatchdog"
LOG_MAX_BYTES = 512 * 1024
WARN_INTERVAL_SEC = 600
PYTHON_NAMES = {"python.exe", "pythonw.exe"}
TH32CS_SNAPPROCESS = 0x00000002

POLL_SEC = float(os.environ.get("MEMWATCH_POLL_SEC", "15"))
WARN_MB = float(os.environ.get("MEMWATCH_WARN_MB", "1200"))
KILL_MB = float(os.environ.get("MEMWATCH_KILL_MB", "2000"))
SYS_MIN_MB = float(os.environ.get("MEMWATCH_SYS_MIN_MB", "600"))
SAMPLE_SEC = float(os.environ.get("MEMWATCH_SAMPLE_SEC", "300"))

k32 = ctypes.WinDLL("kernel32", use_last_error=True)
ntdll = ctypes.WinDLL("ntdll", use_last_error=True)
psapi = ctypes.WinDLL("psapi", use_last_error=True)
ERROR_ALREADY_EXISTS = 183

# x64 句柄/指针安全：显式声明签名
k32.OpenProcess.restype = ctypes.c_void_p
k32.OpenProcess.argtypes = [w.DWORD, w.BOOL, w.DWORD]
k32.ReadProcessMemory.restype = w.BOOL
k32.ReadProcessMemory.argtypes = [ctypes.c_void_p, ctypes.c_void_p,
                                  ctypes.c_void_p, ctypes.c_size_t,
                                  ctypes.POINTER(ctypes.c_size_t)]
ntdll.NtQueryInformationProcess.restype = ctypes.c_int
ntdll.NtQueryInformationProcess.argtypes = [ctypes.c_void_p, ctypes.c_int,
                                            ctypes.c_void_p, w.ULONG, ctypes.c_void_p]
k32.TerminateProcess.restype = w.BOOL
k32.TerminateProcess.argtypes = [ctypes.c_void_p, w.UINT]


class PROCESSENTRY32W(ctypes.Structure):
    _fields_ = [
        ("dwSize", w.DWORD), ("cntUsage", w.DWORD),
        ("th32ProcessID", w.DWORD),
        ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)),
        ("th32ModuleID", w.DWORD),
        ("cntThreads", w.DWORD),
        ("th32ParentProcessID", w.DWORD),
        ("pcPriClassBase", ctypes.c_long),
        ("dwFlags", w.DWORD), ("szExeFile", ctypes.c_wchar * 260),
    ]


class PBI(ctypes.Structure):  # PROCESS_BASIC_INFORMATION（x64，48 字节）
    _fields_ = [
        ("ExitStatus", ctypes.c_int32), ("_pad", ctypes.c_int32),
        ("PebBaseAddress", ctypes.c_void_p),
        ("AffinityMask", ctypes.c_void_p),
        ("BasePriority", ctypes.c_void_p),
        ("UniqueProcessId", ctypes.c_void_p),
        ("Reserved3", ctypes.c_void_p),
    ]


class MEMORYSTATUSEX(ctypes.Structure):
    _fields_ = [("dwLength", w.DWORD), ("dwMemoryLoad", w.DWORD),
                ("ullTotalPhys", ctypes.c_ulonglong),
                ("ullAvailPhys", ctypes.c_ulonglong),
                ("ullTotalPageFile", ctypes.c_ulonglong),
                ("ullAvailPageFile", ctypes.c_ulonglong),
                ("ullTotalVirtual", ctypes.c_ulonglong),
                ("ullAvailVirtual", ctypes.c_ulonglong),
                ("ullAvailExtendedVirtual", ctypes.c_ulonglong)]


class PMC(ctypes.Structure):
    _fields_ = [("cb", w.DWORD), ("PageFaultCount", w.DWORD),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t)]


def log(msg):
    try:
        if LOG_PATH.exists() and LOG_PATH.stat().st_size > LOG_MAX_BYTES:
            bak = LOG_PATH.with_suffix(".log.1")
            bak.unlink(missing_ok=True)
            LOG_PATH.rename(bak)
        ts = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        with LOG_PATH.open("a", encoding="utf-8") as fh:
            fh.write("[%s] %s\n" % (ts, msg))
    except Exception:
        pass


def proc_table():
    """{pid: (exe_name_lower, ppid)}"""
    m = {}
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snap and snap != -1:
        try:
            e = PROCESSENTRY32W()
            e.dwSize = ctypes.sizeof(PROCESSENTRY32W)
            if k32.Process32FirstW(snap, ctypes.byref(e)):
                while True:
                    m[e.th32ProcessID] = (e.szExeFile.lower(), e.th32ParentProcessID)
                    if not k32.Process32NextW(snap, ctypes.byref(e)):
                        break
        finally:
            k32.CloseHandle(snap)
    return m


def read_cmdline(pid):
    """x64：NtQueryInformationProcess → PEB(0x20) → 参数块(0x70) → CommandLine。失败返回 None。"""
    PROCESS_QUERY_INFORMATION = 0x0400
    PROCESS_VM_READ = 0x0010
    h = k32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not h:
        return None
    try:
        pbi = PBI()
        if ntdll.NtQueryInformationProcess(h, 0, ctypes.byref(pbi),
                                           ctypes.sizeof(PBI), None) != 0:
            return None
        if not pbi.PebBaseAddress:
            return None
        params_ptr = ctypes.c_void_p()
        if not k32.ReadProcessMemory(h, ctypes.c_void_p(pbi.PebBaseAddress + 0x20),
                                     ctypes.byref(params_ptr), ctypes.sizeof(params_ptr), None):
            return None
        if not params_ptr.value:
            return None
        us_len = w.USHORT(0)
        us_buf = ctypes.c_void_p()
        if not k32.ReadProcessMemory(h, ctypes.c_void_p(params_ptr.value + 0x70),
                                     ctypes.byref(us_len), 2, None):
            return None
        if not k32.ReadProcessMemory(h, ctypes.c_void_p(params_ptr.value + 0x78),
                                     ctypes.byref(us_buf), ctypes.sizeof(us_buf), None):
            return None
        if not us_buf.value or us_len.value == 0 or us_len.value > 32766:
            return None
        buf = ctypes.create_unicode_buffer(us_len.value // 2)
        if not k32.ReadProcessMemory(h, ctypes.c_void_p(us_buf.value), buf,
                                     us_len.value, None):
            return None
        return buf.value
    finally:
        k32.CloseHandle(h)


def ws_bytes(pid):
    h = k32.OpenProcess(0x1000 | 0x0010, False, pid)  # QUERY_LIMITED | VM_READ
    if not h:
        return None
    try:
        pmc = PMC()
        pmc.cb = ctypes.sizeof(PMC)
        if psapi.GetProcessMemoryInfo(h, ctypes.byref(pmc), pmc.cb):
            return pmc.WorkingSetSize
        return None
    finally:
        k32.CloseHandle(h)


def sys_avail_mb():
    st = MEMORYSTATUSEX()
    st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
    if k32.GlobalMemoryStatusEx(ctypes.byref(st)):
        return st.ullAvailPhys / (1024 * 1024)
    return None


def find_targets():
    """返回 [(pid, cmdline)]：python/pythonw 且命令行含 TARGET_MARK。"""
    out = []
    for pid, (name, _ppid) in proc_table().items():
        if name not in PYTHON_NAMES:
            continue
        cl = read_cmdline(pid)
        if cl and TARGET_MARK in cl.lower():
            out.append((pid, cl))
    return out


def tree_pids(root, table):
    """root 及其全部后代（按快照父链），含 conhost 等子进程。"""
    children = {}
    for pid, (_n, ppid) in table.items():
        children.setdefault(ppid, []).append(pid)
    res, stack = [root], [root]
    while stack:
        cur = stack.pop()
        for c in children.get(cur, []):
            res.append(c)
            stack.append(c)
    return res


def kill_tree(pids):
    PROCESS_TERMINATE = 0x0001
    for pid in pids:
        h = k32.OpenProcess(PROCESS_TERMINATE, False, pid)
        if h:
            k32.TerminateProcess(h, 1)
            k32.CloseHandle(h)


def main():
    k32.CreateMutexW(None, False, MUTEX_NAME)
    if ctypes.get_last_error() == ERROR_ALREADY_EXISTS:
        return  # 已有实例在跑，单例退出
    STATE.mkdir(parents=True, exist_ok=True)
    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    total_gb = "?"
    st = MEMORYSTATUSEX()
    st.dwLength = ctypes.sizeof(MEMORYSTATUSEX)
    if k32.GlobalMemoryStatusEx(ctypes.byref(st)):
        total_gb = "%.1f" % (st.ullTotalPhys / (1024 ** 3))
    log("看门狗启动 pid=%d poll=%.0fs warn=%.0fMB kill=%.0fMB sys_min=%.0fMB 物理内存=%sGB"
        % (os.getpid(), POLL_SEC, WARN_MB, KILL_MB, SYS_MIN_MB, total_gb))

    last_warn = {}    # pid -> ts
    last_sample = 0.0

    while True:
        try:
            if STOP_FLAG.exists():
                log("发现停止标记，看门狗退出")
                STOP_FLAG.unlink(missing_ok=True)
                return

            targets = find_targets()
            avail = sys_avail_mb()

            # 兜底：系统可用内存见底且采集器在跑 → 杀采集器保机
            if targets and avail is not None and avail < SYS_MIN_MB:
                table = proc_table()
                all_pids = []
                for pid, _cl in targets:
                    all_pids.extend(tree_pids(pid, table))
                log("[兜底] 系统可用内存 %.0fMB < %.0fMB，杀采集器进程树 pids=%s 保机"
                    % (avail, SYS_MIN_MB, sorted(set(all_pids))))
                kill_tree(sorted(set(all_pids)))
                time.sleep(2)

            now = time.time()
            for pid, cl in find_targets():
                ws = ws_bytes(pid)
                if ws is None:
                    continue
                ws_mb = ws / (1024 * 1024)
                if ws_mb >= KILL_MB:
                    table = proc_table()
                    pids = tree_pids(pid, table)
                    log("[击杀] pid=%s 工作集 %.0fMB ≥ %.0fMB，杀进程树 pids=%s cmd=[%s]"
                        % (pid, ws_mb, KILL_MB, sorted(pids), cl[:160]))
                    kill_tree(sorted(pids))
                    time.sleep(1)
                    if not find_targets():  # 目标全灭 → 清孤儿锁，下个整点自动续跑
                        if RUN_LOCK.exists():
                            RUN_LOCK.unlink(missing_ok=True)
                            log("[自愈] 已清理孤儿锁 run.lock，等待下轮整点调度续跑")
                elif ws_mb >= WARN_MB:
                    if now - last_warn.get(pid, 0) > WARN_INTERVAL_SEC:
                        last_warn[pid] = now
                        log("[预警] pid=%s 工作集 %.0fMB ≥ %.0fMB（系统可用 %.0fMB）"
                            % (pid, ws_mb, WARN_MB, avail or -1))
                else:
                    last_warn.pop(pid, None)

            # 低频采样留痕：每 SAMPLE_SEC 记一行各目标内存
            if now - last_sample >= SAMPLE_SEC:
                last_sample = now
                cur = find_targets()
                if cur:
                    parts = []
                    for pid, _cl in cur:
                        ws = ws_bytes(pid)
                        parts.append("pid=%s ws=%sMB" % (pid, int(ws / 1048576) if ws else "?"))
                    log("采样 targets=%d [%s] 系统可用=%.0fMB" % (len(cur), "; ".join(parts), avail or -1))

            time.sleep(POLL_SEC)
        except Exception as ex:
            log("轮询异常: %r" % (ex,))
            time.sleep(5)


if __name__ == "__main__":
    main()
