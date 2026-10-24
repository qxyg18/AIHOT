-- 共享契约·禁用态字段（TZR-20261003 T01/ym239，2026-10-04）：为源候选生命周期、文章元数据补全、
-- 深读输入身份、模型政策/证书版本、回执 operation intent、后台入驻桥/机会审核与身份 capability
-- 一次补齐最小持久面。全部为兼容增量：新表不接线（默认禁用态），新列可空或带默认，旧读取与
-- 旧写入不受影响；具体业务阈值不在此猜值（缺值时对应自动动作关闭，由各自 owner 卡在启用前冻结）。
-- 卡面：D:/agent-hub/artifacts/2026-10-03/tongzhuang-radar-diagnosis/execution/T01（release packet 冻结件）。

-- A. 源候选生命周期（plan §5）：官方根 → 候选 → 追加式 checks 证据。
CREATE TABLE source_official_roots (
  id                text PRIMARY KEY,
  entity_type       text NOT NULL CHECK (entity_type IN ('brand', 'mall')),
  entity_slug       text NOT NULL,
  root_url          text NOT NULL,
  -- 已批准 origin 集：同域入口发现只在集内放行；每次重定向仍须逐跳校验（plan §5）
  approved_origins  text[] NOT NULL DEFAULT '{}',
  -- 官方主体身份证明的证据摘要与出处（不含凭据）
  identity_evidence jsonb NOT NULL DEFAULT '{}',
  rights_note       text,
  -- approved=可参与候选发现；suspended=停用（证据保留）
  status            text NOT NULL DEFAULT 'approved' CHECK (status IN ('approved', 'suspended')),
  verified_at       timestamptz,
  verified_by       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_slug, root_url)
);

CREATE TABLE source_candidates (
  id                  bigserial PRIMARY KEY,
  -- endpoint 归一身份：同 endpoint 并发发现只落一行（AC2 唯一约束）
  endpoint_identity   text NOT NULL UNIQUE,
  url                 text NOT NULL,
  kind                text NOT NULL DEFAULT 'web_list',
  root_id             text REFERENCES source_official_roots (id),
  discovered_via      text NOT NULL DEFAULT '',
  -- 唯一状态链 discovered→probing→eligible→activated；不满足条件转 parked/rejected（plan §5）
  status              text NOT NULL DEFAULT 'discovered'
                        CHECK (status IN ('discovered', 'probing', 'eligible', 'activated', 'parked', 'rejected')),
  policy_version      text NOT NULL DEFAULT '',
  config_hash         text NOT NULL DEFAULT '',
  proof_hash          text NOT NULL DEFAULT '',
  -- CAS 版本：stale worker 冲突不推进（plan §5；更新以 version 为乐观锁）
  version             integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  samples_ok          integer NOT NULL DEFAULT 0,
  samples_total       integer NOT NULL DEFAULT 0,
  last_probe_at       timestamptz,
  -- 手动 tombstone：人工退役后禁止被再发现而自动复活（plan §5）；三字段须同现
  manual_retired      boolean NOT NULL DEFAULT false,
  retired_at          timestamptz,
  retired_by          text,
  retire_reason       text,
  -- 激活后回链既有 sources（人工退役时置空，不删源）
  activated_source_id text REFERENCES sources (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CHECK (NOT manual_retired OR (retired_at IS NOT NULL AND retired_by IS NOT NULL))
);
CREATE INDEX source_candidates_status_idx ON source_candidates (status, updated_at DESC);

CREATE TABLE source_candidate_checks (
  id             bigserial PRIMARY KEY,
  candidate_id   bigint NOT NULL REFERENCES source_candidates (id) ON DELETE CASCADE,
  -- 身份/权利/域与重定向/robots/日期/渠道相关/运行健康：分项证据（plan §5）
  check_key      text NOT NULL CHECK (check_key IN ('identity', 'rights', 'domain', 'robots', 'date', 'relevance', 'health')),
  verdict        text NOT NULL CHECK (verdict IN ('pass', 'fail', 'unknown')),
  evidence       jsonb NOT NULL DEFAULT '{}',
  policy_version text NOT NULL DEFAULT '',
  checked_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX source_candidate_checks_candidate_idx ON source_candidate_checks (candidate_id, checked_at DESC);

-- 追加式证据守卫（AC2）：checks 行只许 INSERT，UPDATE/DELETE/TRUNCATE 一律拒绝。
-- 同 0048 口径：表 owner 仍可先评审后停用触发器；正常 DML 不可绕。
CREATE FUNCTION contract_tables_append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only (T01 contract): UPDATE/DELETE/TRUNCATE forbidden; evidence arrives via INSERT only', TG_TABLE_NAME;
END $$;

CREATE TRIGGER source_candidate_checks_append_only BEFORE UPDATE OR DELETE ON source_candidate_checks
  FOR EACH ROW EXECUTE FUNCTION contract_tables_append_only_guard();
CREATE TRIGGER source_candidate_checks_no_truncate BEFORE TRUNCATE ON source_candidate_checks
  FOR EACH STATEMENT EXECUTE FUNCTION contract_tables_append_only_guard();

-- B. 元数据补全（F1/T03）：日期与详情的补全状态；元数据提交不增 content revision、不触发收费重分析。
ALTER TABLE articles
  ADD COLUMN metadata_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN metadata_retry_at timestamptz,
  ADD COLUMN metadata_checked_at timestamptz,
  -- 发布日期精度：day/month/year；NULL=未核或未知（原始声明保留在既有 published_at_claim）
  ADD COLUMN published_at_precision text
    CHECK (published_at_precision IS NULL OR published_at_precision IN ('day', 'month', 'year')),
  -- 有效日期冲突证据（并列留证待核，不平均不猜，editing-manual §6）
  ADD COLUMN date_conflict jsonb NOT NULL DEFAULT '{}';
CREATE INDEX articles_metadata_retry_idx ON articles (metadata_retry_at) WHERE metadata_retry_at IS NOT NULL;

-- C. 深读输入身份与持久退避（F5/T08）：ready 行只在其 input 版本仍为当前时有效；
-- legacy 行（NULL）=非当前，按未命中兜底，不猜测旧输入。
ALTER TABLE article_deep_reads
  ADD COLUMN input_revision integer,
  ADD COLUMN input_hash text,
  ADD COLUMN attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN retry_at timestamptz;
CREATE INDEX article_deep_reads_retry_idx ON article_deep_reads (retry_at) WHERE retry_at IS NOT NULL;

-- D. 模型政策/证书版本与 CAS（T16）：provider 事实与版本单源落行，更新走 version 乐观锁。
ALTER TABLE model_watch_models
  ADD COLUMN policy_version text NOT NULL DEFAULT '',
  ADD COLUMN catalog_version text NOT NULL DEFAULT '',
  ADD COLUMN probe_version text NOT NULL DEFAULT '',
  ADD COLUMN cert_version text NOT NULL DEFAULT '',
  -- 脱敏 provider 事实（不含凭据）
  ADD COLUMN provider_facts jsonb NOT NULL DEFAULT '{}',
  ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1);

-- 逐能力验收原始样本（append-only）：model_free_capabilities 留"最新结论"行，本表保留每轮判卷样本。
CREATE TABLE model_free_eval_samples (
  id              bigserial PRIMARY KEY,
  model_id        text NOT NULL,
  capability      text NOT NULL,
  dataset_version text NOT NULL DEFAULT '',
  prompt_version  text NOT NULL DEFAULT '',
  policy_version  text NOT NULL DEFAULT '',
  verdict         text NOT NULL,
  pass_count      integer NOT NULL DEFAULT 0,
  payload         jsonb NOT NULL DEFAULT '{}',
  receipt_id      bigint,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_free_eval_samples_model_idx ON model_free_eval_samples (model_id, capability, created_at DESC);

CREATE TRIGGER model_free_eval_samples_append_only BEFORE UPDATE OR DELETE ON model_free_eval_samples
  FOR EACH ROW EXECUTE FUNCTION contract_tables_append_only_guard();
CREATE TRIGGER model_free_eval_samples_no_truncate BEFORE TRUNCATE ON model_free_eval_samples
  FOR EACH STATEMENT EXECUTE FUNCTION contract_tables_append_only_guard();

-- E. 回执 operation intent / 资源预留 / 费用实证（T16，plan §12）。
ALTER TABLE receipts
  -- operationKey 不含候选 model：同一操作跨模型共享此键（unknown 跨模型停车据此查询）
  ADD COLUMN operation_key text,
  ADD COLUMN reserved_input_tokens integer,
  ADD COLUMN reserved_output_tokens integer,
  -- 实际费用证据（provider 用量事实；缺费用不记零）
  ADD COLUMN cost_evidence jsonb NOT NULL DEFAULT '{}';
CREATE INDEX receipts_operation_key_idx ON receipts (operation_key) WHERE operation_key IS NOT NULL;

-- F. 后台入驻桥与机会审核（T19，plan §13）：只读导入最小字段 + 人工确认 mall 桥 + 人工核验反馈。
CREATE TABLE store_archive_bridge (
  id                bigserial PRIMARY KEY,
  archive_hash      text NOT NULL,
  row_ref           text NOT NULL,
  store_code        text NOT NULL DEFAULT '',
  subject_era       text NOT NULL DEFAULT '',
  city              text NOT NULL DEFAULT '',
  channel           text NOT NULL DEFAULT '',
  brand_evidence    text NOT NULL DEFAULT '',
  -- 五状态词汇（plan §13）；默认待核，不自动判"已确认在营"
  open_state        text NOT NULL DEFAULT 'pending_review'
                      CHECK (open_state IN ('confirmed_open', 'historical', 'planned', 'pending_review', 'not_found')),
  state_basis       text NOT NULL DEFAULT '',
  mall_slug         text,
  mall_confirmed_by text,
  mall_confirmed_at timestamptz,
  note              text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (archive_hash, row_ref)
);
CREATE INDEX store_archive_bridge_mall_idx ON store_archive_bridge (mall_slug) WHERE mall_slug IS NOT NULL;

CREATE TABLE opportunity_reviews (
  id           bigserial PRIMARY KEY,
  entity_type  text NOT NULL CHECK (entity_type IN ('brand', 'mall')),
  entity_slug  text NOT NULL,
  review_state text NOT NULL DEFAULT 'pending_review'
                 CHECK (review_state IN ('confirmed_open', 'historical', 'planned', 'pending_review', 'not_found')),
  missing      jsonb NOT NULL DEFAULT '[]',
  feedback     text,
  hub_ref      text,
  reviewed_by  text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (entity_type, entity_slug)
);

-- G. 身份 capability 兼容存储（T20，plan §16）：服务端权威判定；无默认行=缺 grant 一律拒绝（fail-closed）。
CREATE TABLE admin_cap_grants (
  principal   text NOT NULL,
  capability  text NOT NULL CHECK (capability IN ('admin:operate', 'channel:read', 'channel:feedback', 'channel:confirm')),
  granted_by  text NOT NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  revoked_at  timestamptz,
  note        text,
  PRIMARY KEY (principal, capability)
);
-- H. 0045 归档镜像纪律（VERIFY 绿跑抓出并修复的兼容缺陷，两处）：
--   ① articles/publications/analyses 的 schema 变更必须镜像到 *_archived（LIKE 只在建表时
--      复制列）——本卡给 articles 增列后同批镜像 articles_archived；归档列按 0045 口径
--      不加默认/约束（归档只留痕、须接受任意值）。
--   ② 0045 的 articles_archive_del() 原用 INSERT ... SELECT OLD.*, now()（位置映射）：
--      LIKE+尾追镜像后的列序（archived_at 在前、镜像列在后）与 articles 列序错位，任何
--      DELETE FROM articles（delete-articles/delete-sources/test-db-cleanup 等路径）都会
--      报类型错。本卡改为显式列清单（列序无关；后续 articles 增列漏补只少归档该列，
--      降级不中断）。publications/analyses 触发面本卡不动。
ALTER TABLE articles_archived
  ADD COLUMN metadata_attempts integer,
  ADD COLUMN metadata_retry_at timestamptz,
  ADD COLUMN metadata_checked_at timestamptz,
  ADD COLUMN published_at_precision text,
  ADD COLUMN date_conflict jsonb;

CREATE OR REPLACE FUNCTION articles_archive_del() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO articles_archived (
    id, source_id, identity_key, url, title, author, language, published_at, published_at_claim,
    discovered_at, source_updated_at, timeline_at, backfill, backfill_reason, revision, content_hash,
    excerpt, body_text, body_html, body_status, media, x_post, raw, created_at, updated_at,
    grouped_at, processing_state, processing_error, processing_queued_at, processing_attempts,
    processing_retry_at, x_article, metadata_attempts, metadata_retry_at, metadata_checked_at,
    published_at_precision, date_conflict, archived_at
  ) SELECT
    OLD.id, OLD.source_id, OLD.identity_key, OLD.url, OLD.title, OLD.author, OLD.language,
    OLD.published_at, OLD.published_at_claim, OLD.discovered_at, OLD.source_updated_at,
    OLD.timeline_at, OLD.backfill, OLD.backfill_reason, OLD.revision, OLD.content_hash, OLD.excerpt,
    OLD.body_text, OLD.body_html, OLD.body_status, OLD.media, OLD.x_post, OLD.raw, OLD.created_at,
    OLD.updated_at, OLD.grouped_at, OLD.processing_state, OLD.processing_error,
    OLD.processing_queued_at, OLD.processing_attempts, OLD.processing_retry_at, OLD.x_article,
    OLD.metadata_attempts, OLD.metadata_retry_at, OLD.metadata_checked_at,
    OLD.published_at_precision, OLD.date_conflict, now();
  RETURN OLD;
END $$;
