"""ym118: 门店档案产物 → 站点库 同步（宿主侧，挂在 run_collect.py 扩充线之后）。

把 out/expand 的门店档案产物与同步脚本本体拷入 api 容器，再经容器内
node scripts/sync-brand-stores.ts 落库（宿主无 DB 端口，落库必须在容器内跑）。
产物未变化时跳过（水位=两产物+商场字典三件共五文件的 size+mtime），失败只记日志不阻断主管线。
"""
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
OUT = HERE / "out"
EXPAND = OUT / "expand"
CONTAINER = "aihot-api-1"
DEST_EXPAND = "/app/scripts/collectors/out/expand"
DEST_OUT = "/app/scripts/collectors/out"
WATERMARK = HERE / "state" / "brand-stores-sync.json"


def run(cmd, timeout=300):
    # CREATE_NO_WINDOW：宿主链跑在 pythonw 下，docker 每次裸 spawn 都会新弹黑框
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout,
                          creationflags=0x08000000)


def fingerprint():
    """产物 + 商场字典输入一起入指纹：字典单独增长时也要触发重算（归位率随商场池提升）。"""
    fp = {}
    for f in ("brand-stores.json", "brand-store-counts.json", "mall-candidates.json", "group-projects.json"):
        p = EXPAND / f
        if p.exists():
            st = p.stat()
            fp[f] = [st.st_size, int(st.st_mtime)]
    p = OUT / "mall-coords.json"
    if p.exists():
        st = p.stat()
        fp["mall-coords.json"] = [st.st_size, int(st.st_mtime)]
    return fp


def main():
    fp = fingerprint()
    if not fp.get("brand-store-counts.json"):
        print("[skip] 采集产物不存在")
        return 0, "SKIP-产物不存在"
    prev = {}
    if WATERMARK.exists():
        try:
            prev = json.loads(WATERMARK.read_text(encoding="utf-8")).get("fingerprint") or {}
        except Exception:
            prev = {}
    if prev == fp:
        print("[skip] 产物未变化")
        return 0, "SKIP-未变化"
    copies = [
        (REPO / "scripts" / "sync-brand-stores.ts", "/app/scripts/"),
        (EXPAND / "brand-stores.json", DEST_EXPAND + "/"),
        (EXPAND / "brand-store-counts.json", DEST_EXPAND + "/"),
        (EXPAND / "mall-candidates.json", DEST_EXPAND + "/"),
        (EXPAND / "group-projects.json", DEST_EXPAND + "/"),
        (OUT / "mall-coords.json", DEST_OUT + "/"),
    ]
    for src, dest in copies:
        if not src.exists():
            print(f"[fail] 缺文件 {src.name}")
            return 1, f"FAIL-缺文件 {src.name}"
        r = run(["docker", "cp", str(src), f"{CONTAINER}:{dest}"], timeout=180)
        if r.returncode != 0:
            print(f"[fail] cp {src.name}: {r.stderr.strip()[:200]}")
            return 1, f"FAIL-cp {src.name}"
    r = run(["docker", "exec", CONTAINER, "sh", "-c",
             "cd /app && node scripts/sync-brand-stores.ts"])
    tail = (r.stdout or r.stderr or "").strip().splitlines()
    print("\n".join(tail[-14:]))
    if r.returncode != 0:
        print(f"[fail] 容器内同步 rc={r.returncode}")
        return 1, f"FAIL-容器rc={r.returncode}"
    WATERMARK.parent.mkdir(parents=True, exist_ok=True)
    WATERMARK.write_text(json.dumps({"fingerprint": fp}, ensure_ascii=False), encoding="utf-8")
    return 0, "OK-已同步"


if __name__ == "__main__":
    rc, tag = main()
    sys.exit(rc)
