export type ForwardEmailDnsRecord = { name: string; value: string };

export type ForwardEmailDomain = {
	id: string;
	name: string;
	plan: "free" | "enhanced_protection" | "team";
	verification_record?: string;
	has_txt_record?: boolean;
	has_mx_record?: boolean;
	has_dkim_record?: boolean;
	has_return_path_record?: boolean;
	has_dmarc_record?: boolean;
	/** Outbound SMTP approved by ForwardEmail for this domain. */
	has_smtp?: boolean;
	is_smtp_suspended?: boolean;
	smtp_dns_records?: { dkim: ForwardEmailDnsRecord; return_path: ForwardEmailDnsRecord; dmarc: ForwardEmailDnsRecord };
};

export type ForwardEmailAlias = {
	id: string;
	name: string;
	recipients: string[];
	is_enabled: boolean;
};

/** The parts of an inbound webhook body Mailflare reads (see ForwardEmail's "Do you support webhooks?"). */
export type ForwardEmailWebhookPayload = {
	raw?: string;
	recipients?: unknown[];
	session?: { recipient?: string; sender?: string };
	from?: { value?: { address?: string }[]; text?: string };
};
