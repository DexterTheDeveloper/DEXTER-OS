const encoder = new TextEncoder();

function toHex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomHex(byteCount: number): string {
	return toHex(crypto.getRandomValues(new Uint8Array(byteCount)));
}

/** Short, speakable IDs such as `rem_1a2b3c4d`. */
export function shortId(prefix: string): string {
	return `${prefix}_${randomHex(4)}`;
}

export function base64UrlEncode(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(value: string): Uint8Array {
	const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
	const binary = atob(padded);
	const bytes = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
	return bytes;
}

export async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
	return toHex(new Uint8Array(digest));
}

export async function sha256Base64Url(text: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
	return base64UrlEncode(new Uint8Array(digest));
}

export async function hmacHex(key: string, data: string): Promise<string> {
	const cryptoKey = await crypto.subtle.importKey(
		"raw",
		encoder.encode(key),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign("HMAC", cryptoKey, encoder.encode(data));
	return toHex(new Uint8Array(signature));
}

export function slugify(value: string, maxLength = 48): string {
	const slug = value
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[̀-ͯ]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, maxLength)
		.replace(/-+$/g, "");
	return slug || "note";
}

export function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export function sameEmail(a: string | undefined, b: string | undefined): boolean {
	if (!a || !b) return false;
	return a.trim().toLowerCase() === b.trim().toLowerCase();
}
