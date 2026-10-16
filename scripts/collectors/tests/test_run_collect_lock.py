# -*- coding: utf-8 -*-
"""run_collect 锁语义测试套件（ym670/C1-03 验收①：Linux 容器内锁竞争用例通过；未知≠已死路径有测试）。

被测件=同目录上级 run_collect.py（跨平台三态 pid_alive + 锁接管决策）。
运行：python -X utf8 tests/test_run_collect_lock.py
依赖：仅标准库；全程不触网（沙箱凭据为空 → 取得锁后即「凭据未配置」退出）。
平台：Linux 容器/WSL 与 Windows 均可跑；POSIX 专属用例（EPERM 未知/僵尸）自动按环境跳过。
安全：子进程强制 RADAR_COLLECT_CONFIG=沙箱空凭据，绝不读生产 D:/secrets。
"""
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SRC = HERE.parent
RUN_COLLECT = SRC / "run_collect.py"
RADAR_TIME = SRC / "radar_time.py"
LOCK_STALE_SEC = 6 * 3600

sys.path.insert(0, str(SRC))
import run_collect as rc  # noqa: E402

RESULTS = []


def check(name, cond, detail=""):
    RESULTS.append((name, bool(cond)))
    mark = "PASS" if cond else "FAIL"
    extra = f"  [{detail}]" if detail and not cond else ""
    print(f"{mark}  {name}{extra}")


def make_sandbox(tmp):
    col = Path(tmp) / "scripts" / "collectors"
    (col / "state").mkdir(parents=True)
    shutil.copy(RUN_COLLECT, col / "run_collect.py")
    shutil.copy(RADAR_TIME, col / "radar_time.py")
    (col / "config.json").write_text("{}", encoding="utf-8")  # 空凭据沙箱
    return col


def run_collect(col):
    env = os.environ.copy()
    env["RADAR_COLLECT_CONFIG"] = str(col / "config.json")  # 硬性隔离：绝不读生产凭据
    env.pop("AMAP_FORCE", None)
    return subprocess.run([sys.executable, "-X", "utf8", str(col / "run_collect.py")],
                          capture_output=True, encoding="utf-8", errors="replace",
                          timeout=60, env=env, cwd=str(col.parent.parent))


def run_log(col):
    p = col / "logs" / "run.log"
    return p.read_text(encoding="utf-8") if p.exists() else ""


def write_lock(col, text, age_sec=0):
    lock = col / "state" / "run.lock"
    lock.parent.mkdir(parents=True, exist_ok=True)
    lock.write_text(text, encoding="utf-8")
    if age_sec:
        t = time.time() - age_sec
        os.utime(lock, (t, t))
    return lock


def sleeper(sec=120):
    return subprocess.Popen([sys.executable, "-c", f"import time; time.sleep({sec})"])


_GRANDCHILD_SRC = (
    "import subprocess, sys\n"
    "p = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(120)'],\n"
    "                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\n"
    "print(p.pid, flush=True)\n"
)


def spawn_detached_and_kill():
    """返回「已死且无句柄残留」的 pid。

    Windows 句柄语义：本进程若持有 Popen 句柄，进程死后内核对象仍在，OpenProcess 仍成功
    （测试夹具陷阱，非被测代码问题）——故经 helper 转生孙进程（helper 退出即释放句柄），
    再 os.kill 终止（Windows=TerminateProcess 且自关句柄），得到真死 pid。"""
    out = subprocess.run([sys.executable, "-c", _GRANDCHILD_SRC],
                         capture_output=True, encoding="utf-8", timeout=30)
    gpid = int(out.stdout.strip())
    os.kill(gpid, 9)
    time.sleep(0.3)  # 等内核对象释放
    return gpid


def is_nonroot_posix():
    return os.name == "posix" and (not hasattr(os, "geteuid") or os.geteuid() != 0)


# ---------- A. pid_alive 三态单元 ----------

def case_pid_alive_units():
    check("pid_alive(自身)==True", rc.pid_alive(os.getpid()) is True)
    alive_child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
    check("pid_alive(存活子进程)==True", rc.pid_alive(alive_child.pid) is True, f"pid={alive_child.pid}")
    alive_child.kill()
    alive_child.wait()
    dpid = spawn_detached_and_kill()
    check("pid_alive(已死无句柄残留)==False", rc.pid_alive(dpid) is False, f"pid={dpid} got={rc.pid_alive(dpid)!r}")
    check("pid_alive('123')==True（字符串 pid 兼容）", rc.pid_alive(str(os.getpid())) is True)
    check("pid_alive(None)==None", rc.pid_alive(None) is None)
    check("pid_alive('')==None", rc.pid_alive("") is None)
    check("pid_alive(0)==None（进程组语义，不判死）", rc.pid_alive(0) is None)
    check("pid_alive(-1)==None", rc.pid_alive(-1) is None)
    if os.name != "nt":
        check("pid_alive(超范围 pid)==False（不可能存在）", rc.pid_alive(2 ** 33) is False)
        if is_nonroot_posix():
            r = rc.pid_alive(1)
            check("pid_alive(pid 1 非 root)==None（EPERM：未知≠已死）", r is None, f"got={r!r}")
        else:
            print("SKIP  pid1-EPERM 用例（root 环境不产生 EPERM）")
        pid = os.fork()
        if pid == 0:
            os._exit(0)  # 不 reap：留僵尸
        time.sleep(0.3)
        r = rc.pid_alive(pid)
        check("pid_alive(僵尸)==False（已终止未回收=已死）", r is False, f"pid={pid} got={r!r}")
        os.waitpid(pid, 0)
    else:
        r = rc.pid_alive(4)  # Windows System 进程：常规权限 ACCESS_DENIED
        if r is None:
            check("pid_alive(保护进程 System)==None（ACCESS_DENIED：未知≠已死）", True)
        elif r is True:
            print("SKIP  nt-保护进程用例（当前权限可打开，无法产生 ACCESS_DENIED）")
        else:
            check("pid_alive(保护进程 System)==None（ACCESS_DENIED：未知≠已死）", False, "误判为已死")


# ---------- B. 锁竞争集成（真实子进程 + 锁文件） ----------

def case_alive_holder_skip():
    with tempfile.TemporaryDirectory() as tmp:
        col = make_sandbox(tmp)
        slp = sleeper()
        try:
            lock = write_lock(col, f"2026-01-01T00:00:00 {slp.pid}")
            before = lock.read_text(encoding="utf-8")
            p = run_collect(col)
            log = run_log(col)
            check("存活持有者: rc==0", p.returncode == 0, p.stderr[-200:])
            check("存活持有者: 记'持有者存活'并跳过", "持有者存活" in log and "本轮跳过" in log)
            check("存活持有者: 锁未被改写", lock.read_text(encoding="utf-8") == before)
            check("存活持有者: 持有者未被打扰", slp.poll() is None)
        finally:
            slp.kill()
            slp.wait()


def case_dead_holder_takeover():
    with tempfile.TemporaryDirectory() as tmp:
        col = make_sandbox(tmp)
        pid = spawn_detached_and_kill()
        lock = write_lock(col, f"2026-01-01T00:00:00 {pid}")
        p = run_collect(col)
        log = run_log(col)
        check("已死持有者: rc==0", p.returncode == 0, p.stderr[-200:])
        check("已死持有者: 立即接管（'已死'+'接管'）", "已死" in log and "接管" in log)
        check("已死持有者: 取得锁后无凭据退出且锁已清理", "凭据未配置" in log and not lock.exists())


def case_unknown_holder_not_taken_over():
    if not is_nonroot_posix():
        print("SKIP  未知持有者用例（需非 root POSIX：容器/WSL 非 root 运行本套件）")
        return
    with tempfile.TemporaryDirectory() as tmp:
        col = make_sandbox(tmp)
        lock = write_lock(col, "2026-01-01T00:00:00 1")  # pid 1=root 持有，EPERM
        p = run_collect(col)
        log = run_log(col)
        check("未知持有者: rc==0 且'无法判活'跳过（未知≠已死）",
              p.returncode == 0 and "无法判活" in log and "本轮跳过" in log, log[-300:])
        check("未知持有者: 锁保留未被接管", lock.exists() and lock.read_text().rstrip().endswith(" 1"))


def case_unknown_holder_stale_takeover():
    if not is_nonroot_posix():
        print("SKIP  未知持有者+超龄用例（需非 root POSIX）")
        return
    with tempfile.TemporaryDirectory() as tmp:
        col = make_sandbox(tmp)
        lock = write_lock(col, "2026-01-01T00:00:00 1", age_sec=LOCK_STALE_SEC + 600)
        p = run_collect(col)
        log = run_log(col)
        check("未知持有者+超龄: 按锁龄兜底接管", "发现陈旧锁" in log and "接管" in log, log[-300:])


def case_alive_holder_stale_takeover():
    with tempfile.TemporaryDirectory() as tmp:
        col = make_sandbox(tmp)
        slp = sleeper()
        try:
            lock = write_lock(col, f"2026-01-01T00:00:00 {slp.pid}", age_sec=LOCK_STALE_SEC + 600)
            p = run_collect(col)
            log = run_log(col)
            check("存活持有者+超龄: 锁龄兜底接管（原语义保持）", "发现陈旧锁" in log and "接管" in log)
            check("存活持有者+超龄: 未杀持有者（接管≠终止）", slp.poll() is None)
        finally:
            slp.kill()
            slp.wait()


def case_legacy_lock_forms():
    with tempfile.TemporaryDirectory() as tmp:
        col = make_sandbox(tmp)
        lock = write_lock(col, "2026-10-01T00:00:00")  # 旧版仅时间戳：无 pid
        p = run_collect(col)
        log = run_log(col)
        check("旧格式锁(无 pid): '无法判活'跳过", p.returncode == 0 and "无法判活" in log and "本轮跳过" in log)
        os.utime(lock, (time.time() - (LOCK_STALE_SEC + 600),) * 2)
        p = run_collect(col)
        log = run_log(col)
        check("旧格式锁+超龄: 锁龄兜底接管", "发现陈旧锁" in log and "接管" in log)
    with tempfile.TemporaryDirectory() as tmp:
        col = make_sandbox(tmp)
        write_lock(col, "2026-01-01 00:00:00 999999999999")  # 中段版本形态：末列=超范围 pid
        p = run_collect(col)
        log = run_log(col)
        check("旧格式锁(超范围 pid): 判死接管（pid 不可能存在）", "已死" in log and "接管" in log, log[-300:])


def main():
    print(f"== ym670 锁语义测试套件 | platform={sys.platform} py={sys.version.split()[0]} euid={getattr(os, 'geteuid', lambda: 'n/a')()}")
    case_pid_alive_units()
    case_alive_holder_skip()
    case_dead_holder_takeover()
    case_unknown_holder_not_taken_over()
    case_unknown_holder_stale_takeover()
    case_alive_holder_stale_takeover()
    case_legacy_lock_forms()
    fails = [n for n, ok in RESULTS if not ok]
    print(f"\n== 结果：{len(RESULTS) - len(fails)}/{len(RESULTS)} PASS，{len(fails)} FAIL")
    for n in fails:
        print("FAIL:", n)
    return 1 if fails else 0


if __name__ == "__main__":
    sys.exit(main())
