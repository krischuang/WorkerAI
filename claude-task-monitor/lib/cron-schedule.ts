/**
 * Minimal 5-field cron parser.
 * Format: "minute hour dayOfMonth month dayOfWeek"
 * Supports: * (wildcard), /step (step), ranges (1-5), lists (1,2,3)
 * dayOfWeek: 0=Sunday … 6=Saturday (7 is also accepted as Sunday)
 */

type Field = number[];

function parseField(expr: string, min: number, max: number): Field {
  if (expr === "*") {
    const all: number[] = [];
    for (let i = min; i <= max; i++) all.push(i);
    return all;
  }

  const parts = expr.split(",");
  const values = new Set<number>();

  for (const part of parts) {
    if (part.includes("/")) {
      const [rangeExpr, stepStr] = part.split("/");
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) throw new Error(`Invalid step in "${part}"`);
      const start = rangeExpr === "*" ? min : parseInt(rangeExpr, 10);
      const end = rangeExpr === "*" ? max : parseInt(rangeExpr.split("-")[1] ?? rangeExpr, 10);
      for (let v = start; v <= max && v <= end; v += step) values.add(v);
    } else if (part.includes("-")) {
      const [fromStr, toStr] = part.split("-");
      const from = parseInt(fromStr, 10);
      const to = parseInt(toStr, 10);
      for (let v = from; v <= to; v++) values.add(v);
    } else {
      values.add(parseInt(part, 10));
    }
  }

  return Array.from(values)
    .filter((v) => v >= min && v <= max)
    .sort((a, b) => a - b);
}

export interface ParsedCron {
  minute: Field;
  hour: Field;
  dayOfMonth: Field;
  month: Field;    // 1-12
  dayOfWeek: Field; // 0-6 (0 = Sunday)
}

export function parseCron(expr: string): ParsedCron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error(`Cron expression must have 5 fields: "${expr}"`);
  const [min, hr, dom, mo, dow] = parts;
  const dowField = parseField(dow, 0, 7).map((v) => (v === 7 ? 0 : v));
  return {
    minute: parseField(min, 0, 59),
    hour: parseField(hr, 0, 23),
    dayOfMonth: parseField(dom, 1, 31),
    month: parseField(mo, 1, 12),
    dayOfWeek: [...new Set(dowField)].sort((a, b) => a - b),
  };
}

/** Returns the next Date at or after `after` that satisfies the cron expression. */
export function nextCronDate(expr: string, after: Date = new Date()): Date {
  const cron = parseCron(expr);
  // Start from the next minute
  const start = new Date(after.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1);

  // Search up to 4 years ahead to avoid infinite loops
  const limit = new Date(after.getTime() + 4 * 365 * 24 * 60 * 60 * 1000);
  const d = new Date(start);

  while (d < limit) {
    const month = d.getMonth() + 1; // 1-12
    if (!cron.month.includes(month)) {
      // Advance to first day of next matching month
      d.setDate(1);
      d.setHours(0, 0, 0, 0);
      d.setMonth(d.getMonth() + 1);
      continue;
    }

    const dayOfMonth = d.getDate();
    const dayOfWeek = d.getDay(); // 0=Sunday

    if (!cron.dayOfMonth.includes(dayOfMonth) || !cron.dayOfWeek.includes(dayOfWeek)) {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
      continue;
    }

    const hour = d.getHours();
    if (!cron.hour.includes(hour)) {
      const nextHour = cron.hour.find((h) => h > hour);
      if (nextHour !== undefined) {
        d.setHours(nextHour, 0, 0, 0);
      } else {
        d.setDate(d.getDate() + 1);
        d.setHours(0, 0, 0, 0);
      }
      continue;
    }

    const minute = d.getMinutes();
    const nextMin = cron.minute.find((m) => m >= minute);
    if (nextMin !== undefined) {
      d.setMinutes(nextMin, 0, 0);
      return new Date(d);
    }
    // No matching minute this hour — try the next matching hour
    const nextHour = cron.hour.find((h) => h > hour);
    if (nextHour !== undefined) {
      d.setHours(nextHour, 0, 0, 0);
    } else {
      d.setDate(d.getDate() + 1);
      d.setHours(0, 0, 0, 0);
    }
  }

  throw new Error(`No next date found for cron "${expr}" within 4 years`);
}

const DOW_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** Returns a human-readable description for common cron expressions. */
export function describeCron(expr: string): string {
  try {
    const cron = parseCron(expr);
    const { minute, hour, dayOfMonth, month, dayOfWeek } = cron;

    const allMins = minute.length === 60;
    const allHours = hour.length === 24;
    const allDoms = dayOfMonth.length === 31;
    const allMonths = month.length === 12;
    const allDows = dayOfWeek.length === 7;

    // Every minute
    if (allMins && allHours && allDoms && allMonths && allDows) return "Every minute";

    // Every N minutes
    if (allHours && allDoms && allMonths && allDows) {
      if (minute.length === 1) return `At ${minute[0]} minutes past every hour`;
      const gaps = minute.slice(1).map((m, i) => m - minute[i]);
      if (gaps.every((g) => g === gaps[0]))
        return `Every ${gaps[0]} minute${gaps[0] !== 1 ? "s" : ""}`;
    }

    // Every hour at :MM
    if (minute.length === 1 && allHours && allDoms && allMonths && allDows)
      return `Every hour at :${String(minute[0]).padStart(2, "0")}`;

    const timeStr =
      minute.length === 1 && hour.length === 1
        ? `${String(hour[0]).padStart(2, "0")}:${String(minute[0]).padStart(2, "0")}`
        : null;

    // Daily at time
    if (timeStr && allDoms && allMonths && allDows) return `Every day at ${timeStr}`;

    // Weekdays at time
    if (
      timeStr &&
      allDoms &&
      allMonths &&
      dayOfWeek.length === 5 &&
      dayOfWeek.every((d) => d >= 1 && d <= 5)
    )
      return `Weekdays at ${timeStr}`;

    // Weekends at time
    if (
      timeStr &&
      allDoms &&
      allMonths &&
      dayOfWeek.length === 2 &&
      dayOfWeek.includes(0) &&
      dayOfWeek.includes(6)
    )
      return `Weekends at ${timeStr}`;

    // Specific day of week at time
    if (timeStr && allDoms && allMonths && dayOfWeek.length === 1)
      return `Every ${DOW_NAMES[dayOfWeek[0]]} at ${timeStr}`;

    // Weekly on specific days
    if (timeStr && allDoms && allMonths && dayOfWeek.length < 7)
      return `Every ${dayOfWeek.map((d) => DOW_NAMES[d]).join(", ")} at ${timeStr}`;

    // Monthly on a day
    if (timeStr && dayOfMonth.length === 1 && allMonths && allDows)
      return `Monthly on day ${dayOfMonth[0]} at ${timeStr}`;

    // Specific months
    if (timeStr && dayOfMonth.length === 1 && month.length < 12 && allDows)
      return `On day ${dayOfMonth[0]} of ${month.map((m) => MONTH_NAMES[m - 1]).join(", ")} at ${timeStr}`;

    // Fallback — show next run time
    const next = nextCronDate(expr);
    return `Next: ${next.toLocaleString()}`;
  } catch {
    return "Invalid cron expression";
  }
}

/** Validates a cron expression, returning an error string or null. */
export function validateCron(expr: string): string | null {
  try {
    parseCron(expr);
    nextCronDate(expr); // ensure a next run can be computed
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : "Invalid cron expression";
  }
}
