/**
 * Time-bucket and period arithmetic.
 *
 * Kept in one module because two different things depend on agreement here:
 *   * the traffic aggregator writes `bucketStart` values (UTC-aligned),
 *   * the billing/receipt code reads aggregates for a period.
 *
 * If those two ever disagreed by a timezone, an invoice would silently bill the
 * wrong window. Everything is therefore UTC and integer-millisecond based.
 *
 * `AggregateGranularity` values map onto the same union used by the schema so a
 * caller cannot invent a granularity the writer does not produce.
 */

export type GranularityKey = "MINUTE" | "HOUR" | "DAY" | "MONTH";

/** Aligns a timestamp down to the start of its bucket, in UTC. */
export function bucketStart(input: Date | number, granularity: GranularityKey): Date {
  const date = new Date(input);
  date.setUTCSeconds(0, 0);
  if (granularity === "MINUTE") return date;
  date.setUTCMinutes(0, 0, 0);
  if (granularity === "HOUR") return date;
  date.setUTCHours(0, 0, 0, 0);
  if (granularity === "DAY") return date;
  date.setUTCDate(1);
  return date;
}

/** Exclusive end of the bucket that starts at `start`. */
export function bucketEnd(start: Date, granularity: GranularityKey): Date {
  const date = new Date(start);
  if (granularity === "MINUTE") date.setUTCMinutes(date.getUTCMinutes() + 1);
  else if (granularity === "HOUR") date.setUTCHours(date.getUTCHours() + 1);
  else if (granularity === "DAY") date.setUTCDate(date.getUTCDate() + 1);
  else date.setUTCMonth(date.getUTCMonth() + 1);
  return date;
}

export interface DateRange {
  start: Date;
  end: Date;
}

/** Named presets used by the traffic, data and billing pages. */
export type RangePreset = "today" | "7d" | "30d" | "month" | "custom";

/**
 * Resolves a preset (or an explicit `from`/`to` pair) into a concrete range.
 *
 * `end` is exclusive so a range can never double-count a boundary bucket. An
 * unrecognised or inverted custom range is rejected by returning `null` rather
 * than silently substituting a default, because a filter that quietly does
 * something other than what it says is how wrong numbers reach a dashboard.
 */
export function resolveRange(input: {
  preset?: string | null;
  from?: string | null;
  to?: string | null;
  now?: Date;
}): DateRange | null {
  const now = input.now ?? new Date();
  const preset = (input.preset ?? "today") as RangePreset;

  if (preset === "custom") {
    if (!input.from) return null;
    const start = new Date(input.from);
    const end = input.to ? new Date(input.to) : now;
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
    if (end.getTime() <= start.getTime()) return null;
    return { start, end };
  }

  if (preset === "today") {
    const start = new Date(now);
    start.setUTCHours(0, 0, 0, 0);
    return { start, end: now };
  }

  if (preset === "7d" || preset === "30d") {
    const days = preset === "7d" ? 7 : 30;
    const start = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    return { start, end: now };
  }

  if (preset === "month") {
    const start = new Date(now);
    start.setUTCDate(1);
    start.setUTCHours(0, 0, 0, 0);
    return { start, end: now };
  }

  return null;
}

/**
 * Billing period window for a configuration.
 *
 * `periodStartDay` is clamped to 1..28 by the settings registry so a monthly period
 * always has a valid start in February. `WEEKLY` starts on the most recent Monday.
 */
export function billingPeriod(input: {
  period: "MONTHLY" | "WEEKLY" | "CUSTOM";
  periodStartDay: number;
  now?: Date;
}): DateRange {
  const now = input.now ?? new Date();
  const start = new Date(now);
  start.setUTCHours(0, 0, 0, 0);

  if (input.period === "WEEKLY") {
    // getUTCDay: 0 = Sunday. Shift so Monday is day 0.
    const weekday = (start.getUTCDay() + 6) % 7;
    start.setUTCDate(start.getUTCDate() - weekday);
    const end = new Date(start);
    end.setUTCDate(end.getUTCDate() + 7);
    return { start, end };
  }

  const day = Math.min(28, Math.max(1, input.periodStartDay));
  start.setUTCDate(day);
  // If this month's start is still in the future, the current period began last month.
  if (start.getTime() > now.getTime()) start.setUTCMonth(start.getUTCMonth() - 1);
  const end = new Date(start);
  end.setUTCMonth(end.getUTCMonth() + 1);
  return { start, end };
}

/** Whole days elapsed in a range, minimum 0. Used to gate projections. */
export function elapsedDays(range: DateRange, now: Date = new Date()): number {
  const end = Math.min(range.end.getTime(), now.getTime());
  const ms = end - range.start.getTime();
  if (ms <= 0) return 0;
  return ms / (24 * 60 * 60 * 1000);
}

/** Total length of a range in days. */
export function rangeDays(range: DateRange): number {
  return Math.max(0, (range.end.getTime() - range.start.getTime()) / (24 * 60 * 60 * 1000));
}

/** ISO date (UTC) without the time component, for CSV exports and audit filters. */
export function toIsoDay(input: Date | number): string {
  return new Date(input).toISOString().slice(0, 10);
}
