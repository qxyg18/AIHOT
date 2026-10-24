#!/usr/bin/env bash
# 童装雷达镜像站 · 快照导出（C 方案验证版）
# 从本地 Postgres 导出公开面数据到 data/*.json。
# 口径：文章只取标题 + 提要（正文前 140 字）+ 来源 + 原文链接，不含全文。
# 说明：Node 侧 spawn docker 在本机被沙箱拦（EBUSY），故导出这一跳走 bash。
set -euo pipefail

ROOT="/d/myhot-dev"
OUT="$ROOT/mirror/data"
LIMIT=800
cd "$ROOT"
mkdir -p "$OUT"

echo "[1/5] articles ..."
docker compose exec -T db psql -U aihot -d aihot -t -A -v ON_ERROR_STOP=1 -f - > "$OUT/articles.json" <<SQL
select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
  select a.id,
         a.title,
         coalesce(s.name, a.source_id) as source_name,
         to_char(coalesce(a.published_at, a.discovered_at) at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI') as published_at,
         a.url,
         left(btrim(regexp_replace(coalesce(a.body_text, ''), '\s+', ' ', 'g')), 140) as lead_text
  from articles a
  left join sources s on s.id = a.source_id
  where a.title is not null and btrim(a.title) <> ''
  order by coalesce(a.published_at, a.discovered_at) desc
  limit $LIMIT
) t;
SQL

echo "[1b/5] article_ids（全量 id 清单，供爬虫种子，不含内容）..."
docker compose exec -T db psql -U aihot -d aihot -t -A -v ON_ERROR_STOP=1 -f - > "$OUT/article_ids.json" <<'SQL'
select coalesce(json_agg(id), '[]'::json) from articles where title is not null and btrim(title) <> '';
SQL

echo "[2/5] boards ..."
docker compose exec -T db psql -U aihot -d aihot -t -A -v ON_ERROR_STOP=1 -f - > "$OUT/boards.json" <<'SQL'
select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
  select r.board,
         m.name as model_name,
         r.rank,
         r.score,
         r.confidence,
         left(btrim(regexp_replace(coalesce(r.summary, ''), '\s+', ' ', 'g')), 200) as summary
  from lb_rankings r
  join lb_models m on m.id = r.model_id
  where r.run_id = (select id from lb_runs where status='published' order by generated_at desc limit 1)
  order by r.board, r.rank
) t;
SQL

echo "[3/5] topics ..."
docker compose exec -T db psql -U aihot -d aihot -t -A -v ON_ERROR_STOP=1 -f - > "$OUT/topics.json" <<'SQL'
select coalesce(json_agg(row_to_json(t)), '[]'::json) from (
  select slug, name, grp, definition from topics order by position
) t;
SQL

echo "[4/5] hot ..."
docker compose exec -T db psql -U aihot -d aihot -t -A -v ON_ERROR_STOP=1 -f - > "$OUT/hot.json" <<'SQL'
select entries::text from hot_rankings order by computed_at desc limit 1;
SQL

echo "[5/5] meta ..."
docker compose exec -T db psql -U aihot -d aihot -t -A -v ON_ERROR_STOP=1 -f - > "$OUT/meta.json" <<SQL
select json_build_object(
  'generated_at', to_char(now() at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI:SS'),
  'data_cutoff', (select to_char(max(coalesce(published_at, discovered_at)) at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI') from articles),
  'articles_total', (select count(*) from articles),
  'articles_exported', $LIMIT,
  'sources_enabled', (select count(*) from sources where enabled),
  'topics_total', (select count(*) from topics),
  'leaderboard_run', (select id from lb_runs where status='published' order by generated_at desc limit 1),
  'leaderboard_generated_at', (select to_char(generated_at at time zone 'Asia/Shanghai', 'YYYY-MM-DD HH24:MI') from lb_runs where status='published' order by generated_at desc limit 1),
  'scope', 'mirror-readonly',
  'content_policy', 'title-excerpt-link-only'
);
SQL

echo "导出完成："
ls -lh "$OUT" | awk 'NR>1 {print "  " $9 "  " $5}'
