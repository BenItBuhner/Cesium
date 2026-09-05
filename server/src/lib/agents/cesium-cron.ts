/**
 * Minimal 5-field cron engine for Cesium agent triggers.
 *
 * Grammar per field (minute hour day-of-month month day-of-week):
 *   "*", "*\/n", "a", "a-b", "a-b/n", and comma lists of those.
 * Day-of-week accepts 0-7 (0 and 7 are Sunday) plus 3-letter names; month
 * accepts 1-12 plus 3-letter names. Matching follows classic cron semantics:
 * when BOTH day-of-month and day-of-week are restricted, a date matches if
 * EITHER matches.
 *
 * Deliberately dependency-free: triggers only need minute resolution and a
 * bounded "next occurrence" search.
 */

export type CronSchedule = {
  minutes: Set<number>;
  hours: Set<number>;
  daysOfMonth: Set<number>;
  months: Set<number>;
  daysOfWeek: Set<number>;
  /** True when the source field was "*" (needed for dom/dow OR semantics). */
  domWildcard: boolean;
  dowWildcard: boolean;
};

const MONTH_NAMES: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

const DOW_NAMES: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
};

function parseToken(token: string, names: Record<string, number> | null): number {
  const lowered = token.toLowerCase();
  if (names && lowered in names) {
    return names[lowered]!;
  }
  if (!/^\d+$/.test(token)) {
    throw new Error(`Invalid cron value "${token}".`);
  }
  return Number.parseInt(token, 10);
}

function parseField(
  field: string,
  min: number,
  max: number,
  names: Record<string, number> | null,
  normalize?: (value: number) => number
): { values: Set<number>; wildcard: boolean } {
  const values = new Set<number>();
  let wildcard = true;
  for (const part of field.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) {
      throw new Error(`Empty cron list entry in "${field}".`);
    }
    const [rangePart, stepPart, ...extra] = trimmed.split("/");
    if (extra.length > 0 || stepPart === "") {
      throw new Error(`Invalid cron step in "${trimmed}".`);
    }
    const step = stepPart == null ? 1 : Number.parseInt(stepPart, 10);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`Invalid cron step in "${trimmed}".`);
    }
    let start: number;
    let end: number;
    if (rangePart === "*" || rangePart === "") {
      start = min;
      end = max;
      if (rangePart !== "*") {
        throw new Error(`Invalid cron range in "${trimmed}".`);
      }
      if (stepPart == null) {
        // Pure "*" keeps the wildcard flag; stepped "*/n" restricts it.
      } else {
        wildcard = false;
      }
    } else {
      wildcard = false;
      const bounds = rangePart.split("-");
      if (bounds.length === 1) {
        start = end = parseToken(bounds[0]!, names);
        if (stepPart != null) {
          // "a/n" means "a-max/n" in classic cron.
          end = max;
        }
      } else if (bounds.length === 2) {
        start = parseToken(bounds[0]!, names);
        end = parseToken(bounds[1]!, names);
      } else {
        throw new Error(`Invalid cron range in "${trimmed}".`);
      }
    }
    start = normalize ? normalize(start) : start;
    end = normalize ? normalize(end) : end;
    if (start < min || end > max || start > end) {
      throw new Error(
        `Cron value out of range in "${trimmed}" (expected ${min}-${max}).`
      );
    }
    for (let value = start; value <= end; value += step) {
      values.add(value);
    }
  }
  if (values.size === 0) {
    throw new Error(`Cron field "${field}" matches nothing.`);
  }
  return { values, wildcard };
}

/** Parse a 5-field cron expression. Throws on invalid syntax. */
export function parseCronExpression(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(
      `Cron expression must have 5 fields (minute hour day month weekday); got ${fields.length}.`
    );
  }
  const [minuteF, hourF, domF, monthF, dowF] = fields as [string, string, string, string, string];
  const minutes = parseField(minuteF, 0, 59, null);
  const hours = parseField(hourF, 0, 23, null);
  const dom = parseField(domF, 1, 31, null);
  const months = parseField(monthF, 1, 12, MONTH_NAMES);
  // 7 normalizes to Sunday (0).
  const dow = parseField(dowF, 0, 7, DOW_NAMES, (value) => (value === 7 ? 0 : value));
  const daysOfWeek = new Set([...dow.values].map((value) => (value === 7 ? 0 : value)));
  return {
    minutes: minutes.values,
    hours: hours.values,
    daysOfMonth: dom.values,
    months: months.values,
    daysOfWeek,
    domWildcard: dom.wildcard,
    dowWildcard: dow.wildcard,
  };
}

function dateMatches(schedule: CronSchedule, date: Date): boolean {
  if (!schedule.months.has(date.getMonth() + 1)) {
    return false;
  }
  const domMatch = schedule.daysOfMonth.has(date.getDate());
  const dowMatch = schedule.daysOfWeek.has(date.getDay());
  if (schedule.domWildcard && schedule.dowWildcard) {
    return true;
  }
  if (schedule.domWildcard) {
    return dowMatch;
  }
  if (schedule.dowWildcard) {
    return domMatch;
  }
  // Both restricted: classic cron ORs them.
  return domMatch || dowMatch;
}

/**
 * Next fire time strictly after `afterMs`, in local server time, or null when
 * no occurrence exists within the search horizon (~5 years).
 */
export function nextCronRunAfter(schedule: CronSchedule, afterMs: number): number | null {
  const cursor = new Date(afterMs);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  // Walk minute-by-minute within matching days; skip whole days that cannot
  // match to keep the walk cheap.
  const horizon = afterMs + 5 * 366 * 24 * 60 * 60 * 1000;
  while (cursor.getTime() <= horizon) {
    if (!dateMatches(schedule, cursor)) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      continue;
    }
    if (!schedule.hours.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      continue;
    }
    if (!schedule.minutes.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
      continue;
    }
    return cursor.getTime();
  }
  return null;
}
