# -*- coding: utf-8 -*-
"""DB 店仓档案只读导入器（TZR-20261003 T19/ym251，plan §13）。

把店仓档案 xlsx 的 13 个允许列只读转成 store_archive_bridge 的确定性 SQL
（UPSERT ON CONFLICT (archive_hash,row_ref)），不回写工作台、不碰源文件。
纪律（卡面 AC1/AC2）：允许列外字段一概不读；deterministic 初判只写
state_basis/brand_evidence 事实注记，open_state 全量 pending_review——
跨城同名、SW/J 归属、D/B 品牌不明、转让多主体/合并、计划开店、闭店、
权限冲突都留人工核验，零自动确认；mall_slug 一律留空待人工确认。
产物 SQL 经 stdin/文件交给 psql（隔离库），脚本自身零数据库驱动依赖。

用法：
  python import-db-occupancy.py --archive <xlsx> [--sheet download] [--out sql路径|stdout]
      [--expected-sha256 <hash>] [--source-url <url注记>]
摘要 JSON 走 stderr；SQL 走 --out 或 stdout。退出码：0 正常 / 1 参数或校验失败。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path

import openpyxl

# db-archive-intake.json allowed_columns 白名单（AC1：只导出允许字段）
ALLOWED_COLUMNS = (
    "编号", "店仓名称", "省份", "城市", "区县", "渠道类别", "店仓类别",
    "营业状态", "是否允许零售", "开店时间", "闭店时间", "关联节点", "可用",
)
# 五状态词汇（0052 CHECK 单一词汇；导入器只产 pending_review）
PENDING = "pending_review"
ARCHIVE_NOTE = "archive_file_date=档案文件标识非状态截止日；未匹配不等于未入驻（plan §13）"


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def cell_text(value: object) -> str:
    """单元格→窄文本：日期统一 ISO 形态，None/空白→''。"""
    if value is None:
        return ""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    return str(value).strip()


def sql_quote(text: str) -> str:
    return "'" + text.replace("'", "''") + "'"


def build_rows(sheet, header_map: dict[str, int]) -> list[dict[str, str]]:
    """逐行提取允许列；编号为空的行跳过。所有行 open_state=pending_review（AC2）。"""
    rows: list[dict[str, str]] = []
    duplicates: dict[str, int] = {}
    for idx, row in enumerate(sheet.iter_rows(min_row=header_map["_min_row"] + 1), start=header_map["_min_row"] + 1):
        get = lambda col: cell_text(row[header_map[col]].value) if header_map.get(col) is not None and header_map[col] < len(row) else ""
        code = get("编号")
        if not code:
            continue
        duplicates[code] = duplicates.get(code, 0) + 1
        name = get("店仓名称")
        business = get("营业状态")
        closed = get("闭店时间")
        opened = get("开店时间")
        retail = get("是否允许零售")
        store_type = get("店仓类别")
        node = get("关联节点")
        city = get("城市")
        # state_basis 只拼档案事实，不做任何入驻/闭店判定（档案闭店≠可自动判历史，AC2）
        basis_parts = [f"档案营业状态={business}" if business else "档案营业状态缺",
                       f"允许零售={retail}" if retail else "允许零售未标"]
        if opened:
            basis_parts.append(f"档案开店时间={opened}")
        if closed:
            basis_parts.append(f"档案闭店时间={closed}")
        if node:
            basis_parts.append(f"关联节点={node}")
        if duplicates[code] > 1:
            basis_parts.append("同编号多行(转让/合并多主体疑义)待核")
        prefix = code[0].upper() if code[0:1].isascii() and code[0:1].isalpha() else "?"
        brand_evidence = f"店仓类别={store_type or '缺'}；编号前缀={prefix}(前缀不构成品牌证明)"
        rows.append({
            "row_ref": f"{sheet.title}:{idx}",
            "store_code": code,
            "subject_era": node or "(档案未单列主体era)",
            "city": city,
            "channel": get("渠道类别"),
            "brand_evidence": brand_evidence,
            "state_basis": "；".join(basis_parts) + f"；{ARCHIVE_NOTE}",
        })
    return rows


def main() -> int:
    ap = argparse.ArgumentParser(description="店仓档案只读导入器（T19）")
    ap.add_argument("--archive", required=True)
    ap.add_argument("--sheet", default="download")
    ap.add_argument("--out", default=None, help="SQL 输出路径；缺省 stdout")
    ap.add_argument("--expected-sha256", default=None, help="期望的源文件 sha256（db-archive-intake 口径）")
    ap.add_argument("--source-url", default=None, help="源 URL 注记（进 state_basis 尾注，可缺省）")
    args = ap.parse_args()

    archive = Path(args.archive)
    if not archive.exists():
        print(json.dumps({"ok": False, "error": f"archive not found: {archive}"}, ensure_ascii=False), file=sys.stderr)
        return 1
    before = sha256_file(archive)
    if args.expected_sha256 and before != args.expected_sha256:
        print(json.dumps({"ok": False, "error": "sha256 mismatch", "expected": args.expected_sha256, "actual": before}, ensure_ascii=False), file=sys.stderr)
        return 1

    wb = openpyxl.load_workbook(archive, read_only=True, data_only=True)  # 只读打开，零写回
    try:
        if args.sheet in wb.sheetnames:
            sheet = wb[args.sheet]
        else:
            sheet = wb[wb.sheetnames[0]]
        header_map: dict[str, int] = {}
        for ridx, row in enumerate(sheet.iter_rows(min_row=1, max_row=5), start=1):
            for cidx, cell in enumerate(row):
                text = cell_text(cell.value)
                if text in ALLOWED_COLUMNS and text not in header_map:
                    header_map[text] = cidx
            if len(header_map) == len(ALLOWED_COLUMNS):
                header_map["_min_row"] = ridx
                break
        if "_min_row" not in header_map:
            missing = [c for c in ALLOWED_COLUMNS if c not in header_map]
            print(json.dumps({"ok": False, "error": f"header incomplete, missing={missing}"}, ensure_ascii=False), file=sys.stderr)
            return 1
        rows = build_rows(sheet, header_map)
    finally:
        wb.close()
    after = sha256_file(archive)
    if before != after:  # AC1：源文件只读 hash 不变
        print(json.dumps({"ok": False, "error": "source file changed during read", "before": before, "after": after}, ensure_ascii=False), file=sys.stderr)
        return 1

    lines = ["BEGIN;", "-- T19 store_archive_bridge 只读导入（幂等 UPSERT；五状态默认待核，零自动确认）"]
    for r in rows:
        lines.append(
            "INSERT INTO store_archive_bridge "
            "(archive_hash,row_ref,store_code,subject_era,city,channel,brand_evidence,open_state,state_basis) "
            f"VALUES ({sql_quote(before)},{sql_quote(r['row_ref'])},{sql_quote(r['store_code'])},"
            f"{sql_quote(r['subject_era'])},{sql_quote(r['city'])},{sql_quote(r['channel'])},"
            f"{sql_quote(r['brand_evidence'])},'{PENDING}',{sql_quote(r['state_basis'])}) "
            "ON CONFLICT (archive_hash,row_ref) DO UPDATE SET "
            "store_code=EXCLUDED.store_code, subject_era=EXCLUDED.subject_era, city=EXCLUDED.city, "
            "channel=EXCLUDED.channel, brand_evidence=EXCLUDED.brand_evidence, "
            # 人工态（非 pending_review）不被重跑导入打回：状态面冻结给人工，事实面照常刷新（ISSUE-1）
            "open_state = CASE WHEN store_archive_bridge.open_state = 'pending_review' "
            "THEN EXCLUDED.open_state ELSE store_archive_bridge.open_state END, "
            "state_basis = CASE WHEN store_archive_bridge.open_state = 'pending_review' "
            "THEN EXCLUDED.state_basis ELSE store_archive_bridge.state_basis END, "
            "updated_at=now();"
        )
    lines.append("COMMIT;")
    sql_text = "\n".join(lines) + "\n"
    if args.out:
        Path(args.out).write_text(sql_text, encoding="utf-8", newline="\n")
    else:
        sys.stdout.write(sql_text)

    summary = {
        "ok": True,
        "source": str(archive),
        "source_sha256": before,
        "source_sha256_after": after,
        "sheet": args.sheet,
        "imported_rows": len(rows),
        "open_state": PENDING,
        "allowed_columns": list(ALLOWED_COLUMNS),
        "auto_confirm_count": 0,
    }
    if args.source_url:
        summary["source_url"] = args.source_url
    print(json.dumps(summary, ensure_ascii=False), file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
