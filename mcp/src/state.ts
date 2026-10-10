export const STATE_PATH = "/state/STATE.md";

export interface StateSummary {
	lastUpdated?: string;
	handoff?: string;
}

/** Pulls the "Last updated" line and the first line under "Handoff note" out of STATE.md. */
export function summarizeState(markdown: string): StateSummary {
	const lines = markdown.split(/\r?\n/);
	const lastUpdated = lines
		.find((line) => /^\s*Last updated:/i.test(line))
		?.replace(/^\s*Last updated:\s*/i, "")
		.trim();

	const handoffIndex = lines.findIndex((line) => /^\s*#*\s*Handoff note/i.test(line));
	const handoff =
		handoffIndex >= 0
			? lines
					.slice(handoffIndex + 1)
					.map((line) => line.trim())
					.find((line) => line.length > 0)
			: undefined;

	return { lastUpdated: lastUpdated || undefined, handoff };
}
