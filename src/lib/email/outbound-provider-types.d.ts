import type { AwsConfig } from "@/lib/aws/aws-types";

export type SendingProvider = "none" | "cloudflare" | "resend" | "ses" | "forwardemail";

export type OutboundProviderConfig =
	| { provider: "cloudflare" }
	| { provider: "resend"; apiKey: string }
	| { provider: "ses"; config: AwsConfig }
	| { provider: "forwardemail"; apiKey: string };

export type OutboundProviderAttachment = {
	filename: string;
	type: string;
	content: ArrayBuffer;
	disposition: "attachment" | "inline";
	contentId?: string | null;
};

export type OutboundProviderMessage = {
	from: string;
	to: string[];
	cc?: string[];
	bcc?: string[];
	subject: string;
	html?: string;
	text?: string;
	headers?: Record<string, string>;
	attachments?: OutboundProviderAttachment[];
};

export type ResendKeyStatus = {
	configured: boolean;
	/** Where the key in use comes from; the key itself never leaves the server. */
	source: "settings" | "environment" | null;
};
