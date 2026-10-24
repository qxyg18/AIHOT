// ym467 S04：opencode 免费档逐位能力证书（容器内执行：
//   docker compose exec -T worker node scripts/opencode-certify.ts <modelId> <capability...>
// 复用 modelwatch.monitor.certifyCapability（真实提示词+schema，默认 10 样本，≥90% 合格线），
// 证书落 model_free_capabilities 并 invalidateFreeRouting（路由快照下一拍生效）。
// modelId 形态=opencode:<客户端模型 id>（前缀分流走 opencode 免费预设，见 monitor.ts）。
import { closeDb } from "@aihot/backend/db";
import { certifyCapability } from "@aihot/backend/modelwatch/monitor";

async function main(): Promise<number> {
  const [modelId, ...caps] = process.argv.slice(2);
  if (!modelId || caps.length === 0) {
    console.error("usage: node scripts/opencode-certify.ts <modelId> <capability...>");
    return 2;
  }
  const out: Array<Record<string, unknown>> = [];
  for (const capability of caps) {
    try {
      const r = await certifyCapability({ modelId, capability });
      out.push({ capability, verdict: r.verdict, passCount: r.passCount, total: r.total, variants: r.variants });
      console.log(`[certify] ${modelId} × ${capability}: ${r.verdict} ${r.passCount}/${r.total}`);
    } catch (error) {
      out.push({ capability, error: String(error).slice(0, 300) });
      console.error(`[certify] ${modelId} × ${capability}: ERROR ${String(error).slice(0, 300)}`);
    }
  }
  console.log(JSON.stringify({ modelId, results: out }, null, 2));
  return 0;
}

main()
  .then(async (code) => {
    await closeDb();
    process.exit(code);
  })
  .catch(async (error) => {
    console.error(String(error));
    await closeDb();
    process.exit(1);
  });
