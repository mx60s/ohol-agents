// Quiet hours for the overhead writers (narrator, field notes).

/** Is `now` inside "start-end" (whole hours, local to `tz`; wraps midnight, "23-10" = 23:00-09:59)? Empty or malformed: never quiet. */
export function inQuietHours(spec: string, tz: string, now = new Date()): boolean {
  const m = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/.exec(spec ?? "");
  if (!m) return false;
  const start = Number(m[1]), end = Number(m[2]);
  if (start === end || start > 23 || end > 24) return false;
  const h = Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone: tz }).format(now));
  return start < end ? h >= start && h < end : h >= start || h < end;
}
