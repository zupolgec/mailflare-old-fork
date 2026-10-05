"use client";

import { useEffect, useState, type ReactNode } from "react";
import { requestJson } from "./api";
import ForwardEmailConfig from "./ForwardEmailConfig";
import ProviderCard from "./ProviderCard";
import ResendDomainSection from "./ResendDomainSection";
import SesSendingConfig from "./SesSendingConfig";
import type { Domain, SendingProvider } from "./types";

type Option = Exclude<SendingProvider, "none">;
type Present = Record<Option, boolean | null>;

const OPTIONS: { id: Option; title: string; description: string }[] = [
	{ id: "cloudflare", title: "Cloudflare Email", description: "Cloudflare Email Sending. Configured on this domain's zone." },
	{ id: "resend", title: "Resend", description: "Send through your Resend account." },
	{ id: "ses", title: "Amazon SES", description: "Send through your AWS account with SES." },
	{ id: "forwardemail", title: "ForwardEmail", description: "Send through your ForwardEmail account." },
];

type Props = {
	domain: Domain;
	onChange?: (provider: SendingProvider) => void;
	busy?: boolean;
	message?: string | null;
	/** Config UI for Cloudflare sending, rendered by the parent which owns the DNS audit. */
	cloudflareConfig: ReactNode;
	/** Whether Cloudflare sending is fully set up (subdomain enabled, DKIM present). */
	cloudflareOk: boolean;
};

type PresenceResponse = Partial<Present> & { resendStatus?: string | null; sesVerified?: boolean | null };

export default function SendingSetupSection({ domain, onChange, busy, message, cloudflareConfig, cloudflareOk }: Props) {
	const [present, setPresent] = useState<Present>({ cloudflare: null, resend: null, ses: null, forwardemail: null });
	const [resendStatus, setResendStatus] = useState<string | null>(null);
	const [sesStatus, setSesStatus] = useState<string | null>(null);
	const [forwardEmailReady, setForwardEmailReady] = useState<boolean | null>(null);
	const [reload, setReload] = useState(0);
	const [removing, setRemoving] = useState<Option | null>(null);
	const [error, setError] = useState("");

	useEffect(() => {
		let active = true;
		requestJson<PresenceResponse>(`/api/domains/${domain.id}/sending`, "GET")
			.then((data) => {
				if (!active) return;
				setPresent({ cloudflare: data.cloudflare ?? null, resend: data.resend ?? null, ses: data.ses ?? null, forwardemail: data.forwardemail ?? null });
				setResendStatus(data.resendStatus ?? null);
				setSesStatus(data.sesVerified === null || data.sesVerified === undefined ? null : data.sesVerified ? "verified" : "pending");
			})
			.catch(() => { if (active) setPresent({ cloudflare: null, resend: null, ses: null, forwardemail: null }); });
		return () => { active = false; };
	}, [domain.id, domain.sendingProvider, reload]);

	async function cleanUp(option: Option, title: string) {
		if (!window.confirm(`Remove the ${title} setup for ${domain.hostname}? This deletes its DNS records.`)) return;
		setRemoving(option);
		setError("");
		try {
			await requestJson(`/api/domains/${domain.id}/sending`, "DELETE", { target: option });
			setReload((value) => value + 1);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not remove configuration");
		} finally { setRemoving(null); }
	}

	// true/false when we know whether the option is set up, null when we cannot tell.
	const okFor = (option: Option): boolean | null =>
		option === "cloudflare" ? cloudflareOk
		: option === "resend" ? (resendStatus === null ? null : resendStatus === "verified")
		: option === "forwardemail" ? forwardEmailReady
		: (sesStatus === null ? null : sesStatus === "verified");

	return (
		<section className="mt-6">
			<h2 className="text-base font-semibold text-neutral-900">Setup sending email</h2>
			<p className="mt-0.5 text-sm text-neutral-500">
				{domain.sendingProvider === "none" ? "This domain only receives mail. Turn on one option to send from it." : "Choose what sends outgoing mail from this domain. Receiving is not affected."}
			</p>
			<ul className="mt-3 space-y-2">
				{OPTIONS.map((option) => {
					const selected = domain.sendingProvider === option.id;
					return (
						<ProviderCard
							key={option.id}
							title={option.title}
							description={option.description}
							ok={selected || present[option.id] ? okFor(option.id) : null}
							selected={selected}
							disabled={busy}
							onToggle={(on) => onChange?.(on ? option.id : "none")}
							cleanup={{ present: !!present[option.id], busy: removing === option.id, disabled: removing !== null, onClick: () => void cleanUp(option.id, option.title) }}
						>
							{option.id === "cloudflare" ? cloudflareConfig
								: option.id === "resend" ? <ResendDomainSection domainId={domain.id} onStatus={setResendStatus} />
								: option.id === "forwardemail" ? <ForwardEmailConfig domainId={domain.id} kind="sending" onReady={setForwardEmailReady} />
								: <SesSendingConfig domainId={domain.id} onStatus={setSesStatus} />}
						</ProviderCard>
					);
				})}
			</ul>
			{message && <p className="mt-2 text-xs text-red-600">{message}</p>}
			{error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
		</section>
	);
}
