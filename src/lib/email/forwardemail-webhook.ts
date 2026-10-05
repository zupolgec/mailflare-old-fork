import { getEmailAddress } from "@/lib/email/address";
import type { ForwardEmailWebhookPayload } from "@/lib/email/forwardemail-api-types";

/**
 * ForwardEmail does not hand out the per-domain key it signs webhooks with, so
 * the endpoint is guarded by a secret in its URL instead (as SES is). Deriving
 * it from the API key keeps it out of the database and rotates it with the key.
 */
export async function forwardEmailWebhookToken(apiKey: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey("raw", encoder.encode(apiKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
	const signature = await crypto.subtle.sign("HMAC", key, encoder.encode("mailflare:forwardemail-webhook"));
	return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** `attachments=false` drops ForwardEmail's parsed copies; the raw MIME already carries them. */
export function forwardEmailWebhookUrl(origin: string, token: string): string {
	return `${origin.replace(/\/$/, "")}/api/inbound/forwardemail?token=${token}&attachments=false`;
}

export function tokensMatch(expected: string, actual: string | null): boolean {
	if (!actual || actual.length !== expected.length) return false;
	let diff = 0;
	for (let index = 0; index < expected.length; index += 1) diff |= expected.charCodeAt(index) ^ actual.charCodeAt(index);
	return diff === 0;
}

/** The envelope and raw message from a webhook body, or null when it is not one. */
export function parseForwardEmailWebhook(body: string): { from: string; recipients: string[]; raw: ArrayBuffer } | null {
	let payload: ForwardEmailWebhookPayload;
	try { payload = JSON.parse(body) as ForwardEmailWebhookPayload; } catch { return null; }
	const recipients = (payload.recipients ?? []).filter((value): value is string => typeof value === "string" && value.includes("@"));
	if (typeof payload.raw !== "string" || recipients.length === 0) return null;
	const from = payload.session?.sender?.trim() || payload.from?.value?.[0]?.address || getEmailAddress(payload.from?.text ?? "");
	return { from, recipients, raw: new TextEncoder().encode(payload.raw).buffer as ArrayBuffer };
}
