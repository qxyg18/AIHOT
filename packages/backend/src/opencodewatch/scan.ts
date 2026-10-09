// opencode 目录同步与存在性预检（ym467 S05）：直连宿主客户端 GET /provider（Basic 鉴权），
// 免费判定 =「-free」后缀或常免费白名单（big-pickle，与 HUB 盯守轴同口径）且客户端报告
// 零价（cost.input/output 都 0——双信号一致才ingest，防把付费档误接进免费池）。
// 动作：①目录新增免费模型 → 自动接入（行+池+事件，走 pool.onboardOpencodeModel）；
// ②池内模型从目录消失 → ended+出池+事件（行保留可回，目录再现由 onboard 复活）；
// ③客户端版本与免费集合快照写 settings（opencodewatch.hello），版本/集合变化出事件
// （版本漂移探测——客户端升级可能断链，pin 版本 1.18.35，见 ym467 卡面）。
// 坏/空目录保护照 modelwatch 扫描（ym249）：目录拉回空免费集合且池内有成员时跳过差分，
// 按失败收口留痕——平台抖动不能集体误判 ended。
import { credential } from "../config.ts";
import { sql } from "../db.ts";
import { addEvent } from "../modelwatch/store.ts";
import { opencodeConfigured, opencodeClientFetch } from "../providers/opencode.ts";
import { getOpencodePool, markOpencodeModelEnded, onboardOpencodeModel } from "./pool.ts";

export const OPENCODE_HELLO_KEY = "opencodewatch.hello";

/** 免费判定（与 HUB opencode_watch.py 同口径）：'-free' 后缀 + 常免费白名单。 */
export function isFreeOpencodeModel(modelId: string): boolean {
  return modelId.endsWith("-free") || modelId === "big-pickle";
}

export interface CatalogModel {
  id: string;
  name: string;
  contextTokens: number | null;
  outputLimit: number | null;
  zeroPrice: boolean;
  status: string | null;
}

/** 纯函数（判别测试用）：池×目录差分——新增（目录有池无）与消失（池有目录无）。 */
export function planOpencodeSync(pool: string[], catalogIds: string[]): { onboard: string[]; gone: string[] } {
  const cur = new Set(catalogIds);
  const prev = new Set(pool);
  return {
    onboard: catalogIds.filter((m) => !prev.has(m)),
    gone: pool.filter((m) => !cur.has(m)),
  };
}

export interface OpencodeCatalog {
  version: string | null;
  /** opencode provider 下的全部模型（不含其他 provider）。 */
  models: CatalogModel[];
  /** 免费集合（双信号过滤后）。 */
  freeIds: string[];
}

interface ProviderModel {
  id?: string;
  name?: string;
  cost?: { input?: number; output?: number };
  limit?: { context?: number; output?: number };
  status?: string;
}

/** 拉客户端目录：POST /session 取版本（顺带活体探针）→ GET /provider 取 opencode 面 → 删会话。 */
export async function fetchOpencodeCatalog(): Promise<OpencodeCatalog> {
  const probe = await opencodeClientFetch("POST", "/session", { body: {}, timeoutMs: 30_000 });
  if (probe.status !== 200) throw new Error(`opencode session probe HTTP ${probe.status}: ${probe.body.slice(0, 200)}`);
  const probeBody = JSON.parse(probe.body) as { id?: string; version?: string };
  if (probeBody.id) {
    try {
      await opencodeClientFetch("DELETE", `/session/${probeBody.id}`, { timeoutMs: 10_000 });
    } catch {
      /* 探针会话清理失败无害 */
    }
  }
  const res = await opencodeClientFetch("GET", "/provider", { timeoutMs: 60_000 });
  if (res.status !== 200) throw new Error(`opencode /provider HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  const payload = JSON.parse(res.body) as { all?: Array<{ id?: string; models?: Record<string, ProviderModel> }> };
  const provider = (payload.all ?? []).find((p) => p.id === "opencode");
  const models: CatalogModel[] = Object.values(provider?.models ?? {}).flatMap((m) => {
    const id = m.id ?? "";
    if (!id) return [];
    const input = m.cost?.input ?? null;
    const output = m.cost?.output ?? null;
    return [{
      id,
      name: m.name ?? id,
      contextTokens: typeof m.limit?.context === "number" ? m.limit.context : null,
      outputLimit: typeof m.limit?.output === "number" ? m.limit.output : null,
      zeroPrice: input === 0 && output === 0,
      status: m.status ?? null,
    }];
  });
  const freeIds = models.filter((m) => isFreeOpencodeModel(m.id) && m.zeroPrice).map((m) => m.id);
  return { version: probeBody.version ?? null, models, freeIds };
}

export interface OpencodeScanSummary {
  at: string;
  ok: boolean;
  error: string | null;
  version: string | null;
  versionChanged: boolean;
  freeTotal: number;
  onboarded: number;
  ended: number;
  suspicious: boolean;
}

/** 单轮同步（zhipu.watch 同款挂班次）。失败只记 scan_error 事件与摘要，异常向上抛由 job_runs 兜底。 */
export async function scanOpencodeWatch(): Promise<OpencodeScanSummary> {
  const at = new Date().toISOString();
  const summary: OpencodeScanSummary = { at, ok: false, error: null, version: null, versionChanged: false, freeTotal: 0, onboarded: 0, ended: 0, suspicious: false };
  if (!opencodeConfigured()) {
    summary.error = "OPENCODE_SERVE_URL / OPENCODE_SERVER_PASSWORD 未配置（models.env）";
    return summary;
  }
  try {
    const catalog = await fetchOpencodeCatalog();
    summary.version = catalog.version;
    summary.freeTotal = catalog.freeIds.length;
    const pool = await getOpencodePool();
    if (catalog.freeIds.length === 0 && pool.models.length > 0) {
      // 坏/空目录保护：平台抖动（或客户端异常返回空）不能集体误判 ended。
      summary.suspicious = true;
      summary.error = "免费集合为空且池内有成员：疑似坏/空目录，跳过本轮差分（不集体判 ended）";
      await addEvent("opencode_catalog_suspicious", "", { reason: summary.error, watching: pool.models.length });
      return summary;
    }
    const byId = new Map(catalog.models.map((m) => [m.id, m]));
    const plan = planOpencodeSync(pool.models, catalog.freeIds);
    for (const id of plan.onboard) {
      const m = byId.get(id);
      await onboardOpencodeModel({
        model: id,
        name: m?.name ?? id,
        contextTokens: m?.contextTokens ?? null,
        sourceUrl: "client:/provider",
        note: `ym467 目录同步自动接入（免费双信号：后缀/白名单 + 客户端零价）`,
      });
      summary.onboarded++;
    }
    for (const id of plan.gone) {
      if (await markOpencodeModelEnded(id, "ym467 目录同步：客户端目录不再提供该模型（行保留可回）")) summary.ended++;
    }
    const helloRows = await sql<{ value: { version?: string; freeIds?: string[] } | null }[]>`SELECT value FROM settings WHERE key = ${OPENCODE_HELLO_KEY}`;
    const prev = helloRows[0]?.value ?? null;
    const prevFree = (prev?.freeIds ?? []).slice().sort().join(",");
    const curFree = catalog.freeIds.slice().sort().join(",");
    summary.versionChanged = !!prev?.version && !!catalog.version && prev.version !== catalog.version;
    if (summary.versionChanged) {
      await addEvent("opencode_version_changed", "", { from: prev?.version ?? null, to: catalog.version, note: "客户端版本漂移：接入 pin=1.18.35，升级可能断链（守护/熔断兜底）" });
    }
    if (prev && prevFree !== curFree) {
      await addEvent("opencode_free_set_changed", "", { from: prev.freeIds ?? [], to: catalog.freeIds, note: "免费集合变化（增/减员）——与 HUB 盯守轴 opencode-watch 双通道同源可对照" });
    }
    await sql`INSERT INTO settings (key, value, updated_by) VALUES (${OPENCODE_HELLO_KEY}, ${sql.json({ version: catalog.version, freeIds: catalog.freeIds, freeTotal: catalog.freeIds.length, updatedAt: at } as never)}, 'system: opencode-watch')
              ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
    summary.ok = true;
    return summary;
  } catch (error) {
    summary.error = String(error).slice(0, 300);
    await addEvent("opencode_scan_error", "", { error: summary.error });
    return summary;
  }
}
