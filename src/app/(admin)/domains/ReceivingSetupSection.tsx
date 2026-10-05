"use client";

import { useEffect, useState, type ReactNode } from "react";
import { requestJson } from "./api";
import ForwardEmailConfig from "./ForwardEmailConfig";
import ProviderCard from "./ProviderCard";
import ReceivingProviderConfig from "./ReceivingProviderConfig";
import type { Domain, ReceivingProvider } from "./types";

type Option = Exclude<ReceivingProvider, "none">;
type Present = Record<Option, boolean | null>;

const OPTIONS: { id: Option; title: string; description: string }[] = [
	{ id: "cloudflare", title: "Cloudflare Email Routing", description: "Mail arrives through this domain's Cloudflare zone. The default." },
	{ id: "resend", title: "Resend", description: "Resend receives mail and delivers it to Mailflare by webhook." },
	{ id: "ses", title: "Amazon SES", description: "SES receives mail into S3 and notifies Mailflare." },
	{ id: "forwardemail", title: "ForwardEmail", description: "ForwardEmail receives mail and delivers it to Mailflare. Works alongside Google Workspace." },
];

type Props = {
	domain: Domain;
	onChange?: (provider: ReceivingProvider) => void;
	busy?: boolean;
	message?: string | null;
	/** Cloudflare routing status and setup, rendered by the parent that owns the DNS view. */
	cloudflareConfig: ReactNode;
	cloudflareOk: boolean;
};

export default function ReceivingSetupSection({ domain, onChange, busy, message, cloudflareConfig, cloudflareOk }: Props) {
	const [present, setPresent] = useState<Present>({ cloudflare: null, resend: null, ses: null, forwardemail: null });
	const [ready, setReady] = useState<Record<"resend" | "ses" | "forwardemail", boolean | null>>({ resend: null, ses: null, forwardemail: null });
	const [reload, setReload] = useState(0);
	const [removing, setRemoving] = useState<Option | null>(null);
	const [error, setError] = useState("");

	useEffect(() => {
		let active = true;
		requestJson<Present>(`/api/domains/${domain.id}/receiving`, "GET")
			.then((data) => { if (active) setPresent({ cloudflare: data.cloudflare ?? null, resend: data.resend ?? null, ses: data.ses ?? null, forwardemail: data.forwardemail ?? null }); })
			.catch(() => { if (active) setPresent({ cloudflare: null, resend: null, ses: null, forwardemail: null }); });
		return () => { active = false; };
	}, [domain.id, domain.receivingProvider, reload]);

	async function cleanUp(option: Option, title: string) {
		if (!window.confirm(`Remove the ${title} receiving setup for ${domain.hostname}? This deletes its MX record and routing, so mail will not arrive through it.`)) return;
		setRemoving(option);
		setError("");
		try {
			await requestJson(`/api/domains/${domain.id}/receiving`, "DELETE", { target: option });
			setReload((value) => value + 1);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Could not remove configuration");
		} finally { setRemoving(null); }
	}

	return (
		<section className="mt-6">
			<h2 className="text-base font-semibold text-neutral-900">Setup receiving email</h2>
			<p className="mt-0.5 text-sm text-neutral-500">
				Choose what receives mail for this domain. Only one service can own the MX record; setting up another asks before replacing it.
			</p>
			<ul className="mt-3 space-y-2">
				{OPTIONS.map((option) => {
					const selected = domain.receivingProvider === option.id;
					const ok = !selected ? null : option.id === "cloudflare" ? cloudflareOk : ready[option.id];
					return (
						<ProviderCard
							key={option.id}
							title={option.title}
							description={option.description}
							ok={ok}
							selected={selected}
							disabled={busy}
							onToggle={(on) => onChange?.(on ? option.id : "none")}
							cleanup={{ present: !!present[option.id], busy: removing === option.id, disabled: removing !== null, onClick: () => void cleanUp(option.id, option.title) }}
						>
							{option.id === "cloudflare"
								? cloudflareConfig
								: option.id === "forwardemail"
									? <ForwardEmailConfig domainId={domain.id} kind="receiving" onReady={(value) => setReady((current) => current.forwardemail === value ? current : { ...current, forwardemail: value })} />
									: <ReceivingProviderConfig domainId={domain.id} provider={option.id} onReady={(value) => setReady((current) => current[option.id as "resend" | "ses"] === value ? current : { ...current, [option.id]: value })} />}
						</ProviderCard>
					);
				})}
			</ul>
			{domain.receivingProvider === "none" && <p className="mt-2 text-xs text-neutral-500">No receiving service selected: this domain only sends.</p>}
			{message && <p className="mt-2 text-xs text-red-600">{message}</p>}
			{error && <p role="alert" className="mt-2 text-xs text-red-600">{error}</p>}
		</section>
	);
}
