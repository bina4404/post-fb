// shortcut: Asia/Bangkok is fixed UTC+7 with no DST; switch to Intl-based conversion if the zone becomes configurable.
export const TZ_OFFSET_MS = 7 * 3_600_000;
export const DAY_MS = 86_400_000;

const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/;
const HAS_OFFSET = /(Z|[+-]\d{2}:\d{2})$/;

/** ISO 8601 → epoch ms UTC. Không có offset thì hiểu là giờ Asia/Bangkok. */
export function parseScheduleTime(input: string): number | null {
  const value = input.trim().replace(" ", "T");
  if (!ISO.test(value)) return null;
  const ms = Date.parse(HAS_OFFSET.test(value) ? value : `${value}+07:00`);
  return Number.isNaN(ms) ? null : ms;
}
