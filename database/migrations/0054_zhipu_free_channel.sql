-- ym436 智谱免费通道（命主令 2026-10-08）：官方价格页+发布记录双证免费的 GLM 家族成员
-- 种子行。model_id 前缀 zhipu: 即通道标识（capability 证书、路由合流、chatJson 预设选择
-- 都按前缀分流）；不在 OpenRouter 目录里，monitor 的 ended 差分与 observing 探针面已护栏。
-- status=vetted：通道端点已实弹探活（glm-4.7-flash 1305 重试后 200、glm-4-flash-250414
-- 秒通，2026-10-08 19:0x 实录）；能力证书由 model-watch.capability-test 夜批逐能力验收
-- （zhipu: 前缀成员自动入选，判卷仍付费 default）。上下文：4.7-flash=200K、4-flash=128K。
INSERT INTO model_watch_models
  (model_id, name, vendor, tier, context_length, supports_vision, supports_json,
   free_from, last_prompt_price, last_completion_price, status, verdict_note, provider_facts)
VALUES
  ('zhipu:glm-4.7-flash', 'GLM-4.7-Flash', 'zhipu', 'free_tier', 200000, false, true,
   now(), '0', '0', 'vetted',
   'ym436 种子：官方免费（2026-01-19 发布，推理型——thinking:disabled 未必被尊重，调用恒给思考余量）',
   '{"channel":"zhipu","baseUrlEnv":"ZHIPU_BASE_URL"}'::jsonb),
  ('zhipu:glm-4-flash-250414', 'GLM-4-Flash-250414', 'zhipu', 'free_tier', 128000, false, true,
   now(), '0', '0', 'vetted',
   'ym436 种子：官方免费（非推理档，结构化任务秒通）',
   '{"channel":"zhipu","baseUrlEnv":"ZHIPU_BASE_URL"}'::jsonb)
ON CONFLICT (model_id) DO NOTHING;
