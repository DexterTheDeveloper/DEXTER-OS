const ISO_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const FIVE_MINUTES = 5 * 60 * 1000;
const TWO_YEARS = 2 * 365 * 24 * 60 * 60 * 1000;

export type ParsedDueAt = { ok: true; date: Date } | { ok: false; error: string };

/** Accepts ISO 8601 with an explicit offset only, so a reminder never lands in the wrong timezone. */
export function parseDueAt(input: string, now: Date = new Date()): ParsedDueAt {
	const value = input.trim();
	if (!ISO_WITH_OFFSET.test(value)) {
		return {
			ok: false,
			error: "due_at must be ISO 8601 with a UTC offset, for example 2026-10-15T17:00:00-04:00",
		};
	}
	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return { ok: false, error: "due_at is not a real date" };
	if (date.getTime() < now.getTime() - FIVE_MINUTES) return { ok: false, error: "due_at is in the past" };
	if (date.getTime() > now.getTime() + TWO_YEARS) return { ok: false, error: "due_at is more than 2 years out" };
	return { ok: true, date };
}

/** "Thu, Oct 15, 5:00 PM" in the operator's timezone. */
export function formatLocal(date: Date | string, timeZone: string): string {
	const value = typeof date === "string" ? new Date(date) : date;
	return new Intl.DateTimeFormat("en-US", {
		timeZone,
		weekday: "short",
		month: "short",
		day: "numeric",
		hour: "numeric",
		minute: "2-digit",
	}).format(value);
}

/** YYYY-MM-DD for `date` in `timeZone`. */
export function localDate(date: Date, timeZone: string): string {
	return new Intl.DateTimeFormat("en-CA", {
		timeZone,
		year: "numeric",
		month: "2-digit",
		day: "2-digit",
	}).format(date);
}
