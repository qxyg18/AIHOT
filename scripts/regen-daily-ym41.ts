// ym41 one-off: regenerate the 2026-10-01 daily issue through the new sourcing/quota pipeline.
import { composeDaily } from "@aihot/backend/reports/compose";
const r = await composeDaily("2026-10-01", "manual-ym41");
console.log(JSON.stringify(r));
