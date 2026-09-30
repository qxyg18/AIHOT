// zw20/ka3 off-peak windows, shared by the schedule gates and the model router. All Beijing
// wall-clock (fixed UTC+8 offset, no DST); weekday 0 = Sunday. Before OFFPEAK_EFFECTIVE_FROM every
// window check is bypassed and the deployment behaves exactly as it did before the plan.
export const OFFPEAK_EFFECTIVE_FROM = Date.UTC(2026, 9, 7, 16, 0); // = 2026-10-08 00:00 Asia/Shanghai
// ka3 early go (owner directive 2026-09-30 "mimo顶上"): the model router switches to MIMO during
// the daytime shift as soon as its key is configured — the schedule gates (quiet/off-peak) still
// wait for OFFPEAK_EFFECTIVE_FROM. The timestamp is already in the past, so routing is live now.
export const MIMO_EARLY_FROM = Date.UTC(2026, 8, 30, 6, 0); // = 2026-09-30 14:00 Asia/Shanghai (month is 0-based)

export const bjClock = (now = Date.now()) => {
  const d = new Date(now + 8 * 3600_000);
  return { weekday: d.getUTCDay(), minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
};

/** Weekdays 12:00-18:00 Beijing: no site updates at all (Coding Plan peak hours). */
export const quietActive = (now = Date.now()) => {
  const { weekday, minutes } = bjClock(now);
  return weekday >= 1 && weekday <= 5 && minutes >= 12 * 60 && minutes < 18 * 60;
};

/** Daily 23:00-07:30 Beijing: discounted window for model-heavy jobs (the Zhipu plan runs here). */
export const offpeakActive = (now = Date.now()) => {
  const { minutes } = bjClock(now);
  return minutes >= 23 * 60 || minutes < 7 * 60 + 30;
};

/** Daily 9:00-22:59 Beijing: the MIMO pay-as-you-go shift; overlaps the quiet window, callers must
 * check quietActive separately when they also stand for site updates. */
export const mimoShiftActive = (now = Date.now()) => {
  const { minutes } = bjClock(now);
  return minutes >= 9 * 60 && minutes < 23 * 60;
};

/** Off-peak plan is live (from the effective date on). */
export const offpeakPlanLive = (now = Date.now()) => now >= OFFPEAK_EFFECTIVE_FROM;

/** MIMO daytime routing is live early (2026-09-30, "mimo顶上"); routing still requires the key. */
export const mimoEarlyLive = (now = Date.now()) => now >= MIMO_EARLY_FROM;
