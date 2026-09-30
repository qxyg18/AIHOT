// ka3: the MIMO pay-as-you-go daytime shift. `mimoUsable` gates both the schedule window and the
// model router; a balance-type provider failure opens the circuit in settings for two hours, after
// which the next real call acts as the probe (half-open). The key never appears in the repo: it is
// read from the credentials file (AIHOT_CREDENTIALS_DIR/models.env, XIAOMI_MIMO_API_KEY).
import { credential } from "../config.ts";
import { sql } from "../db.ts";

export const MIMO_CIRCUIT_KEY = "llm.mimo_circuit";
export const MIMO_CIRCUIT_COOLDOWN_MS = 2 * 3600_000;

/** Balance-type failures: HTTP 402 outright, or 429 with a balance/quota wording. */
export function isMimoBalanceError(status: number | null, message: string): boolean {
  if (status === 402) return true;
  return status === 429 && /balance|quota|insufficient|arrears|余额|欠费/i.test(message);
}

export async function mimoCircuitOpen(): Promise<boolean> {
  const rows = await sql<{ value: { openUntil?: string } | null }[]>`SELECT value FROM settings WHERE key = ${MIMO_CIRCUIT_KEY}`;
  const until = rows[0]?.value?.openUntil ? Date.parse(rows[0].value.openUntil) : NaN;
  return Number.isFinite(until) && until > Date.now();
}

/** Key present (credentials file or env) and circuit closed. No key configured -> never usable,
 *  which keeps an unconfigured deployment byte-for-byte on the old behavior. */
export async function mimoUsable(): Promise<boolean> {
  return !!credential("models", "XIAOMI_MIMO_API_KEY") && !(await mimoCircuitOpen());
}

export async function openMimoCircuit(reason: string): Promise<void> {
  const value = { openUntil: new Date(Date.now() + MIMO_CIRCUIT_COOLDOWN_MS).toISOString(), reason: reason.slice(0, 200) };
  await sql`INSERT INTO settings (key, value, updated_by) VALUES (${MIMO_CIRCUIT_KEY}, ${sql.json(value as never)}, 'system')
            ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`;
}
