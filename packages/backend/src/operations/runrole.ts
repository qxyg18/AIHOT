// Run-role master gate (ym671, cloud plan C1-04): AIHOT_RUN_ROLE is the one switch that decides
// whether this deployment may have external side effects — startup writes, cron registration,
// catch-up rounds, heartbeat/settings writes, alerts. Only an explicit "active" allows them;
// "shadow" runs the same processes side-effect-free (deployment rehearsal, read-only browsing)
// and "off" blocks them the same way. A missing or invalid value fails closed to "off": an unset
// switch must never wake the site by accident. COLLECT_ENABLED stays what it always was — a
// collection-only valve (it never was a master switch and does not become one here).
export type RunRole = "active" | "shadow" | "off";

export interface RunRoleResolution {
  role: RunRole;
  /** The configured value as read ("" when unset), for the fail-closed warning line. */
  raw: string;
  /** True when the value was missing or not one of the three roles. */
  failed: boolean;
}

const ROLES: readonly string[] = ["active", "shadow", "off"];

export function resolveRunRole(value: string | undefined): RunRoleResolution {
  const raw = (value ?? "").trim();
  return ROLES.includes(raw)
    ? { role: raw as RunRole, raw, failed: false }
    : { role: "off", raw, failed: true };
}

/** External side effects (writes, cron registration, paid calls, notifications) run only in active. */
export function sideEffectsEnabled(role: RunRole): boolean {
  return role === "active";
}

/** One structured warning line for a missing/invalid AIHOT_RUN_ROLE (fail-closed reminder). */
export function runRoleWarning(resolution: RunRoleResolution): string {
  return JSON.stringify({
    level: "warn",
    msg: "AIHOT_RUN_ROLE missing or invalid — side effects stay off (fail closed)",
    raw: resolution.raw === "" ? null : resolution.raw,
    effective: resolution.role,
  });
}
