-- 免费模型能力级验收路由（2026-10-03 ym196 命主令）：每个免费模型×每个能力位做 10 次调用
-- 测试，付费模型判卷（≥9/10 合格），qualified 的组合进能力路由——该能力后续持续调用路由到
-- 该免费模型；付费降为断链过渡档。一行=一次验收结论（复测覆盖旧行，tested_at=最新轮）。
CREATE TABLE model_free_capabilities (
  model_id        text NOT NULL,
  capability      text NOT NULL,
  -- qualified = 判卷合格（可路由）| rejected = 不合格（不路由）
  verdict         text NOT NULL,
  pass_count      integer NOT NULL DEFAULT 0,
  -- 判卷结论：逐样本 pass/fail+理由+judgedModel/promptVersion
  verdict_payload jsonb NOT NULL DEFAULT '{}',
  receipt_id      bigint,
  tested_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model_id, capability)
);
CREATE INDEX model_free_capabilities_cap ON model_free_capabilities (capability, verdict, tested_at DESC);
