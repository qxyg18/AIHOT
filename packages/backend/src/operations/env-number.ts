/** A positive number from the environment, or the documented fallback.
 *
 * A typo in an alert threshold (`ALERT_QUIET_MINUTES=1o`) used to yield NaN; every comparison
 * against NaN is false, so the alert quietly never fired and nothing said why. Missing, blank,
 * non-numeric and non-positive values all take the fallback instead.
 */
export function envPositiveNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  const n = raw === undefined || raw.trim() === "" ? NaN : Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
