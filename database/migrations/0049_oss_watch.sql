-- 开源项目跟踪（2026-10-03 命主令）：admin 私用模块，盯 GitHub 上游开源项目的更新节奏，
-- 首跟踪 zai-org/ZCode。水位与每轮摘要走 settings（osswatch.watermarks / osswatch.lastrun），
-- 表里只落「出刊单位」：一条 release / 一批 tag / 一批 commit，每条挂一条 AI 大白话解读。
CREATE TABLE oss_projects (
  slug        text PRIMARY KEY,
  name        text NOT NULL,
  repo_url    text NOT NULL,
  vendor      text NOT NULL DEFAULT '',
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oss_updates (
  id            bigserial PRIMARY KEY,
  project_slug  text NOT NULL REFERENCES oss_projects(slug) ON DELETE CASCADE,
  kind          text NOT NULL,            -- release | tag | commit_batch
  payload       jsonb NOT NULL DEFAULT '{}',
  -- pending = 待解读（含解读失败下轮补）；done = 已解读
  digest_status text NOT NULL DEFAULT 'pending',
  digest        jsonb,
  receipt_id    bigint,
  digested_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX oss_updates_recent ON oss_updates (project_slug, created_at DESC);
CREATE INDEX oss_updates_digest_pending ON oss_updates (digest_status) WHERE digest_status = 'pending';
