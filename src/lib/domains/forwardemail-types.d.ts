import type { ReceivingStep } from "@/lib/aws/ses-receiving-types";

export type ForwardEmailKind = "receiving" | "sending";

/** One alias per mailbox address, or the domain's catch-all. */
export type ForwardEmailReceivingMode = "aliases" | "catchall";

export type ForwardEmailView = {
	keyConfigured: boolean;
	steps: ReceivingStep[];
	ready: boolean;
	/** What the domain's DNS needs; shown when Mailflare cannot write the zone itself. */
	records: { type: string; name: string; value: string }[];
	dnsManaged: boolean;
	/** Receiving only: how mail is delivered now (null for sending, or before the domain can be read). */
	mode: ForwardEmailReceivingMode | null;
};
