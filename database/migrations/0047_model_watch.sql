-- 免费模型信源监控（2026-10-02 命主令）：每 24 小时拉一次 OpenRouter /api/v1/models，
-- 盯免费窗口的开启与结束。一行一个免费期内（或曾经免费）的模型；事件表只记状态迁移
-- （free_start / free_end / verdict / drift / routing / baseline / scan_error），常规扫描
-- 摘要写 settings 的 modelwatch.lastrun，不进事件表防刷屏。
CREATE TABLE model_watch_models (
  model_id            text PRIMARY KEY,
  name                text NOT NULL,
  vendor              text NOT NULL DEFAULT '',
  -- promo = 限时免费窗口（白嫖目标）；free_tier = ":free" 常年免费档（限流，仅陈列不自动启用）
  tier                text NOT NULL DEFAULT 'promo',
  context_length      integer,
  supports_vision     boolean NOT NULL DEFAULT false,
  supports_json       boolean NOT NULL DEFAULT false,
  free_from           timestamptz,
  -- 描述里写明的免费截止（可缺省）；真到期以价格翻正为准，hint 只做展示与提醒
  free_until_hint     date,
  last_prompt_price       text NOT NULL DEFAULT '',
  last_completion_price   text NOT NULL DEFAULT '',
  -- observing = 24h 观察窗内；vetted = 质量过关（可当主力）；simple = 只进简单能力位；
  -- unusable = 探针打不通；listed = 常年免费档陈列；ended = 免费窗口已结束
  status              text NOT NULL DEFAULT 'observing',
  verdict             text,
  verdict_at          timestamptz,
  verdict_by          text,
  verdict_note        text,
  observe_until       timestamptz,
  probe               jsonb,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE model_watch_events (
  id          bigserial PRIMARY KEY,
  model_id    text NOT NULL DEFAULT '',
  kind        text NOT NULL,
  payload     jsonb NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX model_watch_events_recent ON model_watch_events (created_at DESC);
