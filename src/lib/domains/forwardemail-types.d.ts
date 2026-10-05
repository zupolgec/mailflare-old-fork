import type { ReceivingStep } from "@/lib/aws/ses-receiving-types";

export type ForwardEmailKind = "receiving" | "sending";

export type ForwardEmailView = {
	keyConfigured: boolean;
	steps: ReceivingStep[];
	ready: boolean;
	/** What the domain's DNS needs; shown when Mailflare cannot write the zone itself. */
	records: { type: string; name: string; value: string }[];
	dnsManaged: boolean;
};
