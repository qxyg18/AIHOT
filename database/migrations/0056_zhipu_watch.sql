-- 智谱关注·智谱发布子页（ym437，2026-10-08 命主点名需求②）：盯智谱开放平台文档站的模型发布、
-- 订阅优惠、免费窗口、价格变动与公告改版。日扫 5 个定点页（docs.bigmodel.cn 服务端渲染，.md
-- 后缀直取）+ sitemap.xml lastmod 差分；水位走 settings（zhipuwatch.watermarks / zhipuwatch.lastrun），
-- 表里只落「出刊单位」：一条发布 / 一段活动 / 一版公告页 / 一行免费标注，每条挂一条大白话解读。
-- 【编号说明】卡面原写 0053_zhipu_watch.sql，该号已被 0053_deepread_pub_identity.sql 占用
-- （ym436 期间落地），本卡顺延为 0056。回滚脚本=database/rollback/0056_zhipu_watch.sql（手动）。
CREATE TABLE zhipu_updates (
  id            bigserial PRIMARY KEY,
  kind          text NOT NULL,            -- model_release | plan_promo | free_window | pricing_change | community | other
  title         text NOT NULL,
  url           text NOT NULL,
  published_at  timestamptz,
  payload       jsonb NOT NULL DEFAULT '{}',
  -- 幂等出刊依据：页键|条目键|条目指纹。条目内容变化=新指纹=新条目；同窗重跑撞唯一约束零重复。
  dedup_key     text NOT NULL UNIQUE,
  -- pending = 待解读（含解读失败下轮补）；done = 已解读
  digest_status text NOT NULL DEFAULT 'pending',
  digest        jsonb,
  receipt_id    bigint,
  digested_at   timestamptz,
  review_status text,                     -- null=未复核 | passed | issues
  review        jsonb,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX zhipu_updates_recent ON zhipu_updates (created_at DESC, id DESC);
CREATE INDEX zhipu_updates_digest_pending ON zhipu_updates (digest_status) WHERE digest_status = 'pending';
