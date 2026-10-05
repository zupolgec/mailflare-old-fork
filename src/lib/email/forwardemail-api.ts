import { getEmailAddress } from "@/lib/email/address";
import type { ForwardEmailAlias, ForwardEmailDomain } from "@/lib/email/forwardemail-api-types";
import type { OutboundProviderMessage } from "@/lib/email/outbound-provider-types";

const API = "https://api.forwardemail.net/v1";

class ForwardEmailNotFound extends Error {}

/** The key comes only from the FORWARDEMAIL_API_KEY secret. */
export function getForwardEmailApiKey(env: CloudflareEnv): string | null {
	return env.FORWARDEMAIL_API_KEY?.trim() || null;
}

export function requireForwardEmailApiKey(env: CloudflareEnv): string {
	const apiKey = getForwardEmailApiKey(env);
	if (!apiKey) throw new Error("ForwardEmail is selected but the FORWARDEMAIL_API_KEY secret is not set");
	return apiKey;
}

/** Basic auth with the API token as the username and an empty password. */
async function request<T>(apiKey: string, path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
	const response = await fetch(`${API}${path}`, {
		method: init.method ?? "GET",
		headers: {
			Authorization: `Basic ${btoa(`${apiKey}:`)}`,
			Accept: "application/json",
			...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
		},
		body: init.body === undefined ? undefined : JSON.stringify(init.body),
	});
	const data = (await response.json().catch(() => null)) as (T & { message?: string }) | null;
	if (response.status === 404) throw new ForwardEmailNotFound(data?.message ?? "Not found");
	if (!response.ok) throw new Error(`ForwardEmail: ${data?.message ?? `request failed (${response.status})`}`);
	return data as T;
}

async function orNull<T>(promise: Promise<T>): Promise<T | null> {
	try { return await promise; } catch (error) { if (error instanceof ForwardEmailNotFound) return null; throw error; }
}

export const getForwardEmailAccount = (apiKey: string) => request<{ email: string; plan: string }>(apiKey, "/account");

export const getForwardEmailDomain = (apiKey: string, hostname: string) =>
	orNull(request<ForwardEmailDomain>(apiKey, `/domains/${encodeURIComponent(hostname)}`));

/** Without `catchall: false` ForwardEmail adds a catch-all to the account owner's address. */
export const createForwardEmailDomain = (apiKey: string, hostname: string) =>
	request<ForwardEmailDomain>(apiKey, "/domains", { method: "POST", body: { domain: hostname, catchall: false } });

/** Asks ForwardEmail to re-check the domain's DNS; it answers with an error until everything is in place. */
export const verifyForwardEmailRecords = (apiKey: string, hostname: string, kind: "records" | "smtp") =>
	request<unknown>(apiKey, `/domains/${encodeURIComponent(hostname)}/verify-${kind}`);

export const getForwardEmailAlias = (apiKey: string, hostname: string, name: string) =>
	orNull(request<ForwardEmailAlias>(apiKey, `/domains/${encodeURIComponent(hostname)}/aliases/${encodeURIComponent(name)}`));

/** A new alias is Mailflare's own; on an existing one only the recipients change, so its other settings stay as they were. */
export function saveForwardEmailAlias(apiKey: string, hostname: string, existing: ForwardEmailAlias | null, name: string, recipients: string[]) {
	const base = `/domains/${encodeURIComponent(hostname)}/aliases`;
	return existing
		? request<ForwardEmailAlias>(apiKey, `${base}/${existing.id}`, { method: "PUT", body: { recipients } })
		: request<ForwardEmailAlias>(apiKey, base, {
			method: "POST",
			body: { name, recipients, is_enabled: true, has_imap: false, has_recipient_verification: false, description: "Delivers to Mailflare" },
		});
}

export const deleteForwardEmailAlias = (apiKey: string, hostname: string, id: string) =>
	request<unknown>(apiKey, `/domains/${encodeURIComponent(hostname)}/aliases/${id}`, { method: "DELETE" });

function toBase64(buffer: ArrayBuffer): string {
	const bytes = new Uint8Array(buffer);
	let binary = "";
	for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
	return btoa(binary);
}

/** Our own Message-ID goes out unchanged, so replies thread against what we store. */
export async function sendForwardEmail(apiKey: string, message: OutboundProviderMessage): Promise<{ messageId: string }> {
	const { "Message-ID": providedId, ...headers } = message.headers ?? {};
	const messageId = providedId ?? `<${crypto.randomUUID()}@${getEmailAddress(message.from).split("@")[1] || "mailflare.local"}>`;
	await request<unknown>(apiKey, "/emails", {
		method: "POST",
		body: {
			from: message.from,
			to: message.to,
			...(message.cc?.length ? { cc: message.cc } : {}),
			...(message.bcc?.length ? { bcc: message.bcc } : {}),
			subject: message.subject,
			html: message.html,
			text: message.text,
			headers,
			messageId,
			attachments: message.attachments?.map((attachment) => ({
				filename: attachment.filename,
				content: toBase64(attachment.content),
				encoding: "base64",
				contentType: attachment.type,
				contentDisposition: attachment.disposition,
				...(attachment.disposition === "inline" && attachment.contentId ? { cid: attachment.contentId } : {}),
			})),
		},
	});
	return { messageId };
}
