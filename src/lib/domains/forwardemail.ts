import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { domains, mailboxes } from "@/db/schema";
import { createDnsRecord, deleteDnsRecord, listDnsRecords } from "@/lib/cloudflare-dns";
import { isManualZone } from "@/lib/domains/provision";
import { listDomainMx, MxConflictError, removeMx } from "@/lib/domains/receiving-dns";
import { isPublicHttps } from "@/lib/domains/resend-receiving";
import { CATCH_ALL, claimForwardEmailAlias, mailflareWebhookUrl, releaseForwardEmailAlias } from "@/lib/domains/forwardemail-aliases";
import { aliasNameFor, aliasOwnership, FORWARD_EMAIL_MX, forwardEmailSendingRecords, forwardEmailVerificationRecord, isForwardEmailMx, isMailflareWebhook } from "@/lib/domains/forwardemail-utils";
import {
	createForwardEmailDomain, getForwardEmailAlias, getForwardEmailApiKey, getForwardEmailDomain, requireForwardEmailApiKey, verifyForwardEmailRecords,
} from "@/lib/email/forwardemail-api";
import { getMailboxDomainAddresses } from "@/lib/mailboxes/domain-addresses";
import type { ReceivingStep } from "@/lib/aws/ses-receiving-types";
import type { ForwardEmailDomain } from "@/lib/email/forwardemail-api-types";
import type { DomainRow } from "@/lib/domains/types";
import type { ForwardEmailKind, ForwardEmailReceivingMode, ForwardEmailView } from "@/lib/domains/forwardemail-types";

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

/** Every address on this domain that a Mailflare mailbox receives (primary, all-domains and aliases). */
async function domainAddresses(env: CloudflareEnv, domain: DomainRow): Promise<string[]> {
	const db = getDb(env);
	const rows = await db
		.select({ id: mailboxes.id, domainId: mailboxes.domainId, localPart: mailboxes.localPart, useAllDomains: mailboxes.useAllDomains })
		.from(mailboxes)
		.innerJoin(domains, eq(mailboxes.domainId, domains.id))
		.where(eq(domains.userId, domain.userId));
	const suffix = `@${domain.hostname.toLowerCase()}`;
	const all = await Promise.all(rows.map((row) => getMailboxDomainAddresses(db, row)));
	return [...new Set(all.flat().filter((address) => address.endsWith(suffix)))].sort();
}

/** Mailflare's catch-all decides the mode; without one, each mailbox address has its own alias. */
const modeOf = (catchAll: { recipients: string[] } | null): ForwardEmailReceivingMode => (aliasOwnership(catchAll) === "mailflare" ? "catchall" : "aliases");

/**
 * Receiving: either one alias per mailbox address, which leaves every other
 * alias of the domain alone, or the domain's catch-all for all of its mail. The
 * MX can point at ForwardEmail, or stay with the current mail server (Google
 * Workspace, Microsoft 365) when that server relays chosen addresses to ForwardEmail.
 */
async function setupReceiving(
	env: CloudflareEnv,
	domain: DomainRow,
	origin: string,
	options: { replaceMx: boolean; keepMx: boolean; mode: ForwardEmailReceivingMode },
) {
	if (!isPublicHttps(origin)) {
		throw new Error("ForwardEmail delivers mail by calling this app over public HTTPS. Set APP_URL to your public address (localhost will not work).");
	}
	const apiKey = requireForwardEmailApiKey(env);
	await ensureDomain(env, apiKey, domain);
	const webhook = await mailflareWebhookUrl(apiKey, origin);
	if (options.mode === "catchall") {
		if (await claimForwardEmailAlias(apiKey, domain.hostname, CATCH_ALL, webhook) === "conflict") {
			const alias = await getForwardEmailAlias(apiKey, domain.hostname, CATCH_ALL);
			throw new Error(`${domain.hostname} already has a catch-all in ForwardEmail that delivers elsewhere (${(alias?.recipients ?? []).filter((recipient) => !isMailflareWebhook(recipient)).join(", ")}). Remove it in ForwardEmail, or deliver only this app's mailboxes.`);
		}
	} else {
		await releaseForwardEmailAlias(apiKey, domain.hostname, CATCH_ALL);
		// Conflicting aliases are reported by the checklist; the others still get set up.
		for (const address of await domainAddresses(env, domain)) await claimForwardEmailAlias(apiKey, domain.hostname, aliasNameFor(address), webhook);
	}
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
	options: { replaceMx: boolean; keepMx: boolean; mode?: ForwardEmailReceivingMode },
): Promise<void> {
	if (kind === "receiving") return setupReceiving(env, domain, origin, { ...options, mode: options.mode ?? "aliases" });
	return setupSending(env, domain);
}

export async function getForwardEmailView(env: CloudflareEnv, domain: DomainRow, kind: ForwardEmailKind, origin: string): Promise<ForwardEmailView> {
	const dnsManaged = !isManualZone(domain.zoneId);
	const apiKey = getForwardEmailApiKey(env);
	const steps: ReceivingStep[] = [{ key: "key", label: "ForwardEmail API key", ok: !!apiKey, detail: apiKey ? "Set" : "Set the FORWARDEMAIL_API_KEY secret" }];
	if (!apiKey) return { keyConfigured: false, steps, ready: false, records: [], dnsManaged, mode: null };

	const forward = await getForwardEmailDomain(apiKey, domain.hostname);
	const paid = !!forward && forward.plan !== "free";
	steps.push({ key: "domain", label: "Domain in ForwardEmail", ok: paid, detail: !forward ? "Not added yet" : paid ? undefined : "Needs a paid ForwardEmail plan" });
	steps.push({ key: "verified", label: "Ownership verified", ok: !!forward?.has_txt_record });
	const records: ForwardEmailView["records"] = forward ? [forwardEmailVerificationRecord(domain.hostname, forward)] : [];
	let mode: ForwardEmailReceivingMode | null = null;

	if (kind === "receiving") {
		const expected = await mailflareWebhookUrl(apiKey, origin);
		const catchAll = forward ? await getForwardEmailAlias(apiKey, domain.hostname, CATCH_ALL) : null;
		mode = modeOf(catchAll);
		if (mode === "catchall") {
			steps.push({ key: "alias", label: "All mail delivered to Mailflare", ok: !!catchAll?.is_enabled && catchAll.recipients.includes(expected) });
		} else {
			const addresses = await domainAddresses(env, domain);
			const aliases = forward ? await Promise.all(addresses.map((address) => getForwardEmailAlias(apiKey, domain.hostname, aliasNameFor(address)))) : [];
			const delivered = (index: number) => !!aliases[index]?.is_enabled && aliases[index]!.recipients.includes(expected);
			const taken = addresses.filter((_, index) => aliasOwnership(aliases[index] ?? null) === "other");
			const missing = addresses.filter((address, index) => !delivered(index) && !taken.includes(address));
			steps.push({
				key: "alias",
				label: "Mailbox addresses delivered to Mailflare",
				ok: addresses.length > 0 && taken.length === 0 && missing.length === 0,
				detail: addresses.length === 0 ? "Create a mailbox on this domain first"
					: [
						taken.length ? `Already forwarding elsewhere in ForwardEmail: ${taken.join(", ")}` : "",
						missing.length ? `Not set up yet: ${missing.join(", ")}` : "",
					].filter(Boolean).join(". ") || addresses.join(", "),
			});
		}
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
	return { keyConfigured: true, steps, ready: steps.every((step) => step.ok), records, dnsManaged, mode };
}

/** Whether ForwardEmail still holds Mailflare's configuration for this domain (null = could not tell). */
export async function hasForwardEmailConfig(env: CloudflareEnv, domain: DomainRow, kind: ForwardEmailKind): Promise<boolean | null> {
	const apiKey = getForwardEmailApiKey(env);
	if (!apiKey) return null;
	try {
		const forward = await getForwardEmailDomain(apiKey, domain.hostname);
		if (!forward) return false;
		if (kind === "sending") return !!forward.has_dkim_record;
		if (aliasOwnership(await getForwardEmailAlias(apiKey, domain.hostname, CATCH_ALL)) === "mailflare") return true;
		for (const address of await domainAddresses(env, domain)) {
			const ownership = aliasOwnership(await getForwardEmailAlias(apiKey, domain.hostname, aliasNameFor(address)));
			if (ownership === "mailflare" || ownership === "shared") return true;
		}
		return false;
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
		if (!forward) return;
		for (const name of [CATCH_ALL, ...(await domainAddresses(env, domain)).map(aliasNameFor)]) await releaseForwardEmailAlias(apiKey, domain.hostname, name);
		return;
	}
	if (!forward) return;
	for (const record of forwardEmailSendingRecords(domain.hostname, forward)) {
		if (record.key !== "dmarc") await unpublish(env, domain, record);
	}
}
