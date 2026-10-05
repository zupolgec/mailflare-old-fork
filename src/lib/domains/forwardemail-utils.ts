import type { ForwardEmailDomain } from "@/lib/email/forwardemail-api-types";

export type ForwardEmailRecord = { key: string; type: "TXT" | "CNAME"; name: string; value: string };

export const FORWARD_EMAIL_MX = ["mx1.forwardemail.net", "mx2.forwardemail.net"];

export const isForwardEmailMx = (content: string) => /^mx[12]\.forwardemail\.net\.?$/i.test(content.trim());

/** ForwardEmail gives names relative to the domain; Cloudflare needs them absolute. */
const absolute = (name: string, hostname: string) => (!name || name === "@" ? hostname : `${name}.${hostname}`);

/** Proves the domain is ours to ForwardEmail; it accepts mail for the domain only once this is found. */
export function forwardEmailVerificationRecord(hostname: string, domain: Pick<ForwardEmailDomain, "verification_record">) {
	return { type: "TXT" as const, name: hostname, value: `forward-email-site-verification=${domain.verification_record ?? ""}` };
}

export function forwardEmailSendingRecords(hostname: string, domain: Pick<ForwardEmailDomain, "smtp_dns_records">): ForwardEmailRecord[] {
	const records = domain.smtp_dns_records;
	if (!records) return [];
	return [
		{ key: "dkim", type: "TXT", name: absolute(records.dkim.name, hostname), value: records.dkim.value },
		{ key: "return_path", type: "CNAME", name: absolute(records.return_path.name, hostname), value: records.return_path.value },
		{ key: "dmarc", type: "TXT", name: absolute(records.dmarc.name, hostname), value: records.dmarc.value },
	];
}

export const isMailflareWebhook = (recipient: string) => /^https?:\/\/[^/]+\/api\/inbound\/forwardemail(\?|$)/.test(recipient.trim());

/** Who the domain's catch-all belongs to; Mailflare only ever changes or removes its own. */
export function catchAllOwnership(alias: { recipients: string[] } | null): "none" | "mailflare" | "other" | "shared" {
	if (!alias) return "none";
	const ours = alias.recipients.filter(isMailflareWebhook).length;
	if (ours === 0) return "other";
	return ours === alias.recipients.length ? "mailflare" : "shared";
}
