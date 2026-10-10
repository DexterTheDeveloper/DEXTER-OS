import { describe, expect, it } from "vitest";
import { summarizeState } from "../src/state";
import { formatLocal, localDate, parseDueAt } from "../src/time";
import { slugify } from "../src/util";

describe("parseDueAt", () => {
	const now = new Date("2026-10-10T19:00:00Z");

	it("accepts ISO 8601 with an offset", () => {
		const result = parseDueAt("2026-10-15T17:00:00-04:00", now);
		expect(result.ok && result.date.toISOString()).toBe("2026-10-15T21:00:00.000Z");
	});

	it("rejects times without an offset", () => {
		expect(parseDueAt("2026-10-15T17:00:00", now).ok).toBe(false);
		expect(parseDueAt("Thursday at 5", now).ok).toBe(false);
	});

	it("rejects the past and the far future", () => {
		expect(parseDueAt("2026-10-09T17:00:00-04:00", now).ok).toBe(false);
		expect(parseDueAt("2029-01-01T00:00:00Z", now).ok).toBe(false);
	});
});

describe("time formatting", () => {
	it("formats in the operator's timezone", () => {
		expect(formatLocal("2026-10-15T21:00:00.000Z", "America/New_York")).toBe("Thu, Oct 15, 5:00 PM");
	});

	it("uses the local calendar date", () => {
		expect(localDate(new Date("2026-10-11T02:30:00Z"), "America/New_York")).toBe("2026-10-10");
	});
});

describe("summarizeState", () => {
	it("pulls last updated and the handoff line", () => {
		const md = [
			"DEXTER — STATE",
			"",
			"Last updated: 2026-10-10 · Updated by: Claude (chat)",
			"",
			"Handoff note (where I left off)",
			"",
			"Architecture locked 2026-10-10. Next action: run the Cloudflare fix-first setup.",
		].join("\n");
		expect(summarizeState(md)).toEqual({
			lastUpdated: "2026-10-10 · Updated by: Claude (chat)",
			handoff: "Architecture locked 2026-10-10. Next action: run the Cloudflare fix-first setup.",
		});
	});

	it("copes with a file that has neither", () => {
		expect(summarizeState("just text")).toEqual({ lastUpdated: undefined, handoff: undefined });
	});
});

describe("slugify", () => {
	it("makes safe file names", () => {
		expect(slugify("Wake Up: Scene 6 ideas!")).toBe("wake-up-scene-6-ideas");
		expect(slugify("***")).toBe("note");
		expect(slugify("Claude", 24)).toBe("claude");
	});
});
