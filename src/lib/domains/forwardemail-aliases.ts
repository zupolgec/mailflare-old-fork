import { isPublicHttps } from "@/lib/domains/resend-receiving";
import { aliasNameFor, aliasOwnership, withMailflareWebhook, withoutMailflareWebhook } from "@/lib/domains/forwardemail-utils";
import { deleteForwardEmailAlias, getForwardEmailAlias, getForwardEmailApiKey, saveForwardEmailAlias } from "@/lib/email/forwardemail-api";
import { forwardEmailWebhookToken, forwardEmailWebhookUrl } from "@/lib/email/forwardemail-webhook";

export const CATCH_ALL = "*";

export async function mailflareWebhookUrl(apiKey: string, origin: string): Promise<string> {
	return forwardEmailWebhookUrl(origin, await forwardEmailWebhookToken(apiKey));
}

/**
 * Points one alias (a local part, or `*`) at Mailflare. An alias that delivers
 * only elsewhere belongs to the user and is left alone: that is a conflict.
 */
export async function claimForwardEmailAlias(apiKey: string, hostname: string, name: string, webhook: string): Promise<"ok" | "conflict"> {
	const alias = await getForwardEmailAlias(apiKey, hostname, name);
	const ownership = aliasOwnership(alias);
	if (ownership === "other") return "conflict";
	if (alias?.is_enabled && alias.recipients.includes(webhook)) return "ok";
	await saveForwardEmailAlias(apiKey, hostname, alias, name, withMailflareWebhook(alias?.recipients ?? [], webhook));
	return "ok";
}

/** Takes Mailflare off an alias: deletes it when it was Mailflare's alone, otherwise keeps the other recipients. */
export async function releaseForwardEmailAlias(apiKey: string, hostname: string, name: string): Promise<void> {
	const alias = await getForwardEmailAlias(apiKey, hostname, name);
	const ownership = aliasOwnership(alias);
	if (!alias || ownership === "none" || ownership === "other") return;
	if (ownership === "mailflare") await deleteForwardEmailAlias(apiKey, hostname, alias.id);
	else await saveForwardEmailAlias(apiKey, hostname, alias, name, withoutMailflareWebhook(alias.recipients));
}

/**
 * For mailbox changes outside the domain page: the webhook needs this app's
 * public address, so without a usable APP_URL nothing happens and the domain's
 * checklist shows the address as missing until Setup runs again.
 */
export async function forwardEmailOrigin(env: CloudflareEnv): Promise<{ apiKey: string; webhook: string } | null> {
	const apiKey = getForwardEmailApiKey(env);
	const origin = env.APP_URL?.trim();
	if (!apiKey || !origin || !isPublicHttps(origin)) return null;
	return { apiKey, webhook: await mailflareWebhookUrl(apiKey, origin) };
}

export async function claimForwardEmailAddress(env: CloudflareEnv, address: string): Promise<void> {
	const target = await forwardEmailOrigin(env);
	if (!target) return;
	const hostname = address.slice(address.lastIndexOf("@") + 1);
	// The mailbox still works locally; the domain's checklist shows what ForwardEmail is missing.
	try {
		// A catch-all owned by Mailflare already covers every address.
		if (aliasOwnership(await getForwardEmailAlias(target.apiKey, hostname, CATCH_ALL)) === "mailflare") return;
		await claimForwardEmailAlias(target.apiKey, hostname, aliasNameFor(address), target.webhook);
	} catch (error) {
		console.warn(`ForwardEmail: could not set up ${address}`, error);
	}
}

export async function releaseForwardEmailAddress(env: CloudflareEnv, address: string): Promise<void> {
	const apiKey = getForwardEmailApiKey(env);
	if (!apiKey) return;
	try { await releaseForwardEmailAlias(apiKey, address.slice(address.lastIndexOf("@") + 1), aliasNameFor(address)); }
	catch (error) { console.warn(`ForwardEmail: could not remove ${address}`, error); }
}
