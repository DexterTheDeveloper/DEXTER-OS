import { ensureSchema, getConfig, setConfig, type ReminderRow } from "./db";
import { formatLocal } from "./time";
import { randomHex } from "./util";

const MAX_ATTEMPTS = 3;
const STUCK_AFTER_MS = 10 * 60 * 1000;

/** The ntfy topic reminders go to. Generated once and kept private when NTFY_TOPIC isn't set. */
export async function pushTopic(env: Env): Promise<string> {
	if (env.NTFY_TOPIC) return env.NTFY_TOPIC;
	let topic = await getConfig(env.DB, "ntfy_topic");
	if (!topic) {
		topic = `dexter-${randomHex(16)}`;
		await setConfig(env.DB, "ntfy_topic", topic);
	}
	return topic;
}

export async function sendPush(env: Env, title: string, message: string): Promise<boolean> {
	const topic = await pushTopic(env);
	const server = (env.NTFY_SERVER || "https://ntfy.sh").replace(/\/+$/, "");
	const headers: Record<string, string> = {
		Title: title,
		Priority: "high",
		Tags: "alarm_clock",
	};
	if (env.NTFY_TOKEN) headers.Authorization = `Bearer ${env.NTFY_TOKEN}`;
	const response = await fetch(`${server}/${encodeURIComponent(topic)}`, {
		method: "POST",
		headers,
		body: message,
	});
	return response.ok;
}

/**
 * Runs every minute from the Cron Trigger. Each due reminder is claimed with a
 * conditional UPDATE before sending, so overlapping runs can't send it twice.
 */
export async function deliverDueReminders(env: Env, now: Date = new Date()): Promise<{ sent: number; failed: number }> {
	const db = env.DB;
	await ensureSchema(db);
	const nowIso = now.toISOString();

	// A run that died mid-send leaves a row in 'sending'; put it back in line once its claim is
	// old. Keyed on when it was claimed, not on due_at: an overdue reminder that another run is
	// sending right now must not be handed out a second time. (Rows claimed before claimed_at
	// existed have NULL there and count as stuck.)
	await db
		.prepare(
			`UPDATE reminders SET status = CASE WHEN attempts >= ? THEN 'failed' ELSE 'pending' END
			 WHERE status = 'sending' AND (claimed_at IS NULL OR claimed_at <= ?)`,
		)
		.bind(MAX_ATTEMPTS, new Date(now.getTime() - STUCK_AFTER_MS).toISOString())
		.run();

	const { results } = await db
		.prepare(`SELECT * FROM reminders WHERE status = 'pending' AND due_at <= ? ORDER BY due_at LIMIT 20`)
		.bind(nowIso)
		.all<ReminderRow>();

	let sent = 0;
	let failed = 0;
	for (const reminder of results) {
		const claim = await db
			.prepare(
				`UPDATE reminders SET status = 'sending', attempts = attempts + 1, claimed_at = ? WHERE id = ? AND status = 'pending'`,
			)
			.bind(nowIso, reminder.id)
			.run();
		if (claim.meta.changes !== 1) continue;

		let ok = false;
		try {
			ok = await sendPush(env, "DEXTER", `${reminder.text}\n${formatLocal(reminder.due_at, env.DEXTER_TZ)}`);
		} catch {
			ok = false;
		}

		if (ok) {
			await db
				.prepare(`UPDATE reminders SET status = 'sent', sent_at = ? WHERE id = ?`)
				.bind(nowIso, reminder.id)
				.run();
			await setConfig(db, "push_confirmed", nowIso);
			sent++;
		} else {
			const attempts = reminder.attempts + 1;
			await db
				.prepare(`UPDATE reminders SET status = ? WHERE id = ?`)
				.bind(attempts >= MAX_ATTEMPTS ? "failed" : "pending", reminder.id)
				.run();
			failed++;
		}
	}
	return { sent, failed };
}
