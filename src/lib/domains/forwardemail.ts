import { createDnsRecord, deleteDnsRecord, listDnsRecords } from "@/lib/cloudflare-dns";
import { isManualZone } from "@/lib/domains/provision";
import { listDomainMx, MxConflictError, removeMx } from "@/lib/domains/receiving-dns";
import { isPublicHttps } from "@/lib/domains/resend-receiving";
import { FORWARD_EMAIL_MX, forwardEmailSendingRecords, forwardEmailVerificationRecord, isForwardEmailMx } from "@/lib/domains/forwardemail-utils";
import {
	createForwardEmailDomain, deleteForwardEmailAlias, getForwardEmailAlias, getForwardEmailApiKey, getForwardEmailDomain,
	requireForwardEmailApiKey, saveForwardEmailAlias, verifyForwardEmailRecords,
} from "@/lib/email/forwardemail-api";
import { forwardEmailWebhookToken, forwardEmailWebhookUrl } from "@/lib/email/forwardemail-webhook";
import type { ReceivingStep } from "@/lib/aws/ses-receiving-types";
import type { ForwardEmailDomain } from "@/lib/email/forwardemail-api-types";
import type { DomainRow } from "@/lib/domains/types";
import type { ForwardEmailKind, ForwardEmailView } from "@/lib/domains/forwardemail-types";

const CATCH_ALL = "*";
const clean = (value: string) => value.replace(/^"|"$/g, "").replace(/"\s*"/g, "").trim().toLowerCase().replace(/\.$/, "");

async function zoneHas(env: CloudflareEnv, domain: DomainRow, record: { type: string; name: string; value: string }): Promise<boolean | null> {
	if (isManualZone(domain.zoneId)) return null;
	const existing = await listDnsRecords(env, domain.zoneId, { type: record.type, name: record.name });
	return existing.some((item) => clean(item.content ?? "") === clean(record.value));
}

async function publish(env: CloudflareEnv, domain: DomainRow, record: { type: "TXT" | "CNAME"; name: string; value: string }): Promise<void> {
	if (isManualZone(domain.zoneId) || await zoneHas(env, domain, record)) return;
	await createDnsRecord(env, domain.zoneId, { type: record.type, name: record.name, content: record.value, ttl: 3600, ...(record.type === "CNAME" ? { proxied: false } : {}) });
}

async function unpublish(env: CloudflareEnv, domain: DomainRow, record: { type: string; name: string; value: string }): Promise<void> {
	if (isManualZone(domain.zoneId)) return;
	for (const item of await listDnsRecords(env, domain.zoneId, { type: record.type, name: record.name })) {
		if (item.id && clean(item.content ?? "") === clean(record.value)) await deleteDnsRecord(env, domain.zoneId, item.id);
	}
}

/** The domain in ForwardEmail, added (and its verification record published) when missing. */
async function ensureDomain(env: CloudflareEnv, apiKey: string, domain: DomainRow): Promise<ForwardEmailDomain> {
	const existing = await getForwardEmailDomain(apiKey, domain.hostname);
	const forward = existing ?? (await createForwardEmailDomain(apiKey, domain.hostname), await getForwardEmailDomain(apiKey, domain.hostname));
	if (!forward) throw new Error("ForwardEmail did not return the domain it just created");
	if (forward.plan === "free") throw new Error("This domain is on ForwardEmail's free plan, which cannot deliver to Mailflare or send mail. Upgrade it in ForwardEmail first.");
	await publish(env, domain, forwardEmailVerificationRecord(domain.hostname, forward));
	return forward;
}

async function webhookUrl(apiKey: string, origin: string): Promise<string> {
	return forwardEmailWebhookUrl(origin, await forwardEmailWebhookToken(apiKey));
}

/**
 * Receiving: the domain's catch-all alias delivers to Mailflare's webhook. The MX
 * can point at ForwardEmail, or stay with the current mail server (Google
 * Workspace, Microsoft 365) when that server relays chosen addresses to ForwardEmail.
 */
async function setupReceiving(env: CloudflareEnv, domain: DomainRow, origin: string, options: { replaceMx: boolean; keepMx: boolean }) {
	if (!isPublicHttps(origin)) {
		throw new Error("ForwardEmail delivers mail by calling this app over public HTTPS. Set APP_URL to your public address (localhost will not work).");
	}
	const apiKey = requireForwardEmailApiKey(env);
	await ensureDomain(env, apiKey, domain);
	const alias = await getForwardEmailAlias(apiKey, domain.hostname, CATCH_ALL);
	await saveForwardEmailAlias(apiKey, domain.hostname, alias, CATCH_ALL, [await webhookUrl(apiKey, origin)]);
	if (!options.keepMx) await publishForwardEmailMx(env, domain, options.replaceMx);
	await verifyForwardEmailRecords(apiKey, domain.hostname, "records").catch(() => undefined);
}

/** Both ForwardEmail exchanges; any other MX is a conflict until the caller agrees to replace it. */
async function publishForwardEmailMx(env: CloudflareEnv, domain: DomainRow, replace: boolean): Promise<void> {
	if (isManualZone(domain.zoneId)) return;
	const existing = await listDomainMx(env, domain);
	const others = existing.filter((record) => !isForwardEmailMx(record.content ?? ""));
	if (others.length > 0 && !replace) throw new MxConflictError(others.map((record) => ({ content: record.content ?? "", priority: record.priority ?? 0 })));
	for (const record of others) if (record.id) await deleteDnsRecord(env, domain.zoneId, record.id);
	for (const exchange of FORWARD_EMAIL_MX) {
		if (existing.some((record) => clean(record.content ?? "") === exchange)) continue;
		await createDnsRecord(env, domain.zoneId, { type: "MX", name: domain.hostname, content: exchange, priority: 0, ttl: 3600 });
	}
}

/** Sending: DKIM, return-path and (when the domain has none) DMARC, then ForwardEmail's own check. */
async function setupSending(env: CloudflareEnv, domain: DomainRow) {
	const apiKey = requireForwardEmailApiKey(env);
	const forward = await ensureDomain(env, apiKey, domain);
	for (const record of forwardEmailSendingRecords(domain.hostname, forward)) {
		if (record.key === "dmarc" && !isManualZone(domain.zoneId) && (await listDnsRecords(env, domain.zoneId, { type: "TXT", name: record.name })).some((item) => clean(item.content ?? "").startsWith("v=dmarc1"))) continue;
		await publish(env, domain, record);
	}
	await verifyForwardEmailRecords(apiKey, domain.hostname, "smtp").catch(() => undefined);
}

export async function setupForwardEmail(
	env: CloudflareEnv,
	domain: DomainRow,
	kind: ForwardEmailKind,
	origin: string,
	options: { replaceMx: boolean; keepMx: boolean },
): Promise<void> {
	if (kind === "receiving") return setupReceiving(env, domain, origin, options);
	return setupSending(env, domain);
}

export async function getForwardEmailView(env: CloudflareEnv, domain: DomainRow, kind: ForwardEmailKind, origin: string): Promise<ForwardEmailView> {
	const dnsManaged = !isManualZone(domain.zoneId);
	const apiKey = getForwardEmailApiKey(env);
	const steps: ReceivingStep[] = [{ key: "key", label: "ForwardEmail API key", ok: !!apiKey, detail: apiKey ? "Set" : "Set the FORWARDEMAIL_API_KEY secret" }];
	if (!apiKey) return { keyConfigured: false, steps, ready: false, records: [], dnsManaged };

	const forward = await getForwardEmailDomain(apiKey, domain.hostname);
	const paid = !!forward && forward.plan !== "free";
	steps.push({ key: "domain", label: "Domain in ForwardEmail", ok: paid, detail: !forward ? "Not added yet" : paid ? undefined : "Needs a paid ForwardEmail plan" });
	steps.push({ key: "verified", label: "Ownership verified", ok: !!forward?.has_txt_record });
	const records: ForwardEmailView["records"] = forward ? [forwardEmailVerificationRecord(domain.hostname, forward)] : [];

	if (kind === "receiving") {
		const alias = forward ? await getForwardEmailAlias(apiKey, domain.hostname, CATCH_ALL) : null;
		const expected = await webhookUrl(apiKey, origin);
		steps.push({ key: "alias", label: "Mail delivered to Mailflare", ok: !!alias?.is_enabled && alias.recipients.includes(expected) });
		const mx = await listDomainMx(env, domain);
		const toForwardEmail = mx.some((record) => isForwardEmailMx(record.content ?? ""));
		const other = mx.find((record) => !isForwardEmailMx(record.content ?? ""));
		steps.push({
			key: "mx",
			label: toForwardEmail ? "MX points to ForwardEmail" : "Mail reaches ForwardEmail",
			ok: toForwardEmail || !!other || !dnsManaged,
			detail: toForwardEmail ? undefined
				: other ? `Your current mail server (${other.content}) must forward the addresses you want here to mx1.forwardemail.net`
				: dnsManaged ? "No MX record" : "Point MX at mx1/mx2.forwardemail.net, or forward chosen addresses there from your mail server",
		});
	} else {
		const sending = forward ? forwardEmailSendingRecords(domain.hostname, forward) : [];
		records.push(...sending);
		steps.push({ key: "dkim", label: "DKIM record", ok: !!forward?.has_dkim_record });
		steps.push({ key: "return_path", label: "Return-path record", ok: !!forward?.has_return_path_record });
		steps.push({ key: "dmarc", label: "DMARC record", ok: !!forward?.has_dmarc_record });
		steps.push({
			key: "smtp",
			label: "Sending approved by ForwardEmail",
			ok: !!forward?.has_smtp && !forward.is_smtp_suspended,
			detail: forward?.is_smtp_suspended ? "Suspended by ForwardEmail" : forward?.has_smtp ? undefined : "Request outbound SMTP for this domain in your ForwardEmail account",
		});
	}
	return { keyConfigured: true, steps, ready: steps.every((step) => step.ok), records, dnsManaged };
}

/** Whether ForwardEmail still holds Mailflare's configuration for this domain (null = could not tell). */
export async function hasForwardEmailConfig(env: CloudflareEnv, domain: DomainRow, kind: ForwardEmailKind): Promise<boolean | null> {
	const apiKey = getForwardEmailApiKey(env);
	if (!apiKey) return null;
	try {
		const forward = await getForwardEmailDomain(apiKey, domain.hostname);
		if (!forward) return false;
		if (kind === "sending") return !!forward.has_dkim_record;
		return !!(await getForwardEmailAlias(apiKey, domain.hostname, CATCH_ALL));
	} catch { return null; }
}

/**
 * Removes what Mailflare set up for one direction. The domain itself stays in
 * ForwardEmail, since the account may use it for other aliases.
 */
export async function removeForwardEmail(env: CloudflareEnv, domain: DomainRow, kind: ForwardEmailKind): Promise<void> {
	const apiKey = requireForwardEmailApiKey(env);
	const forward = await getForwardEmailDomain(apiKey, domain.hostname);
	if (kind === "receiving") {
		await removeMx(env, domain, isForwardEmailMx);
		const alias = forward ? await getForwardEmailAlias(apiKey, domain.hostname, CATCH_ALL) : null;
		if (alias) await deleteForwardEmailAlias(apiKey, domain.hostname, alias.id);
		return;
	}
	if (!forward) return;
	for (const record of forwardEmailSendingRecords(domain.hostname, forward)) {
		if (record.key !== "dmarc") await unpublish(env, domain, record);
	}
}
