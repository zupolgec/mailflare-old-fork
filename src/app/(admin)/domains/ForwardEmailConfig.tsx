"use client";

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/auth/client";
import type { ForwardEmailKind, ForwardEmailReceivingMode, ForwardEmailView } from "@/lib/domains/forwardemail-types";
import { StatusRow } from "./status-row";

type ApiResponse = { view?: ForwardEmailView; error?: string; code?: string; records?: { content: string; priority: number }[]; to?: string };

type Props = {
	domainId: string;
	kind: ForwardEmailKind;
	/** Reports whether this direction is fully set up (null while unknown). */
	onReady?: (ready: boolean | null) => void;
};

async function call(domainId: string, method: "GET" | "POST", kind: ForwardEmailKind, body?: Record<string, unknown>) {
	const response = await authFetch(
		method === "GET" ? `/api/domains/${domainId}/forwardemail?kind=${kind}` : `/api/domains/${domainId}/forwardemail`,
		{ method, cache: "no-store", ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, ...body }) } : {}) },
	);
	return { response, data: (await response.json()) as ApiResponse };
}

/** Checklist and setup for receiving or sending through ForwardEmail. */
export default function ForwardEmailConfig({ domainId, kind, onReady }: Props) {
	const [view, setView] = useState<ForwardEmailView | null>(null);
	const [loading, setLoading] = useState(true);
	const [reload, setReload] = useState(0);
	const [busy, setBusy] = useState<"setup" | "test" | null>(null);
	const [mxChoice, setMxChoice] = useState<string[] | null>(null);
	const [mode, setMode] = useState<ForwardEmailReceivingMode>("aliases");
	const [error, setError] = useState("");
	const [notice, setNotice] = useState("");

	useEffect(() => {
		let active = true;
		call(domainId, "GET", kind)
			.then(({ data }) => {
				if (!active) return;
				setView(data.view ?? null);
				if (data.view?.mode) setMode(data.view.mode);
				setError(data.error ?? "");
			})
			.catch((err) => { if (active) setError(err instanceof Error ? err.message : "Could not reach ForwardEmail"); })
			.finally(() => { if (active) setLoading(false); });
		return () => { active = false; };
	}, [domainId, kind, reload]);

	useEffect(() => { if (!loading) onReady?.(view ? view.ready : null); }, [loading, view, onReady]);

	const refresh = useCallback(() => { setLoading(true); setReload((value) => value + 1); }, []);

	async function run(kindOfWork: "setup" | "test", body: Record<string, unknown>) {
		setBusy(kindOfWork);
		setError("");
		setNotice("");
		try {
			const { response, data } = await call(domainId, "POST", kind, kind === "receiving" ? { mode, ...body } : body);
			if (response.status === 409 && data.code === "MX_CONFLICT") {
				setMxChoice((data.records ?? []).map((record) => record.content));
				return;
			}
			if (!response.ok) throw new Error(data.error ?? "Request failed");
			setMxChoice(null);
			if (kindOfWork === "test") setNotice(`Test email sent to ${data.to}`);
			else {
				setView(data.view ?? null);
				setNotice("Setup finished. DNS changes can take a few minutes; use Check again to refresh.");
			}
		} catch (err) {
			setError(err instanceof Error ? err.message : "Request failed");
		} finally { setBusy(null); }
	}

	const modeChanged = kind === "receiving" && !!view?.mode && view.mode !== mode;
	const showRecords = !!view && view.records.length > 0 && (!view.dnsManaged || !view.ready);
	return (
		<div className="space-y-2">
			<ul className="space-y-2">
				{loading && !view && <li className="list-none text-sm text-neutral-500">Checking…</li>}
				{view?.steps.map((step) => (
					<StatusRow key={step.key} ok={step.ok} title={step.label} hint="">{step.detail ?? (step.ok ? "OK" : "Not set up")}</StatusRow>
				))}
			</ul>
			{view && !view.keyConfigured && <p className="text-xs text-neutral-500">Create an API token in your ForwardEmail account (My Account → Security) and save it as the <code>FORWARDEMAIL_API_KEY</code> secret of this app.</p>}

			{kind === "receiving" && view?.keyConfigured && (
				<fieldset className="space-y-1 rounded-lg bg-white px-3 py-2 text-xs text-neutral-700">
					<legend className="sr-only">Which mail reaches this app</legend>
					<label className="flex items-start gap-2">
						<input type="radio" name={`forwardemail-mode-${domainId}`} className="mt-0.5" checked={mode === "aliases"} disabled={busy !== null} onChange={() => setMode("aliases")} />
						<span><span className="font-medium text-neutral-900">Only this app&apos;s mailboxes</span> (recommended). Other addresses of the domain keep working as they do in ForwardEmail.</span>
					</label>
					<label className="flex items-start gap-2">
						<input type="radio" name={`forwardemail-mode-${domainId}`} className="mt-0.5" checked={mode === "catchall"} disabled={busy !== null} onChange={() => setMode("catchall")} />
						<span><span className="font-medium text-neutral-900">All mail for the domain</span>, including addresses without a mailbox.</span>
					</label>
				</fieldset>
			)}

			{mxChoice && (
				<div role="alertdialog" aria-label="Choose how mail reaches ForwardEmail" className="space-y-2 rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
					<p>This domain&apos;s mail currently goes to <strong>{mxChoice.join(", ")}</strong>.</p>
					<p>Keep it there if that service (for example Google Workspace) should forward only some addresses to ForwardEmail. Or move the whole domain to ForwardEmail.</p>
					<span className="flex flex-wrap gap-2">
						<Button size="sm" disabled={busy !== null} onClick={() => void run("setup", { action: "setup", keepMx: true })}>Keep current mail server</Button>
						<Button size="sm" variant="outline" className="bg-white" disabled={busy !== null} onClick={() => void run("setup", { action: "setup", replaceMx: true })}>Move MX to ForwardEmail</Button>
						<Button size="sm" variant="ghost" disabled={busy !== null} onClick={() => setMxChoice(null)}>Cancel</Button>
					</span>
				</div>
			)}

			{showRecords && (
				<>
					{!view.dnsManaged && <p className="text-xs text-neutral-500">Add these records where this domain&apos;s DNS is hosted:</p>}
					<ul className="space-y-1 text-xs text-neutral-600">
						{view.records.map((record) => (
							<li key={`${record.type}-${record.name}`} className="grid gap-1 rounded-lg bg-white px-3 py-2 sm:grid-cols-[4rem_minmax(8rem,14rem)_minmax(0,1fr)]">
								<span className="font-medium">{record.type}</span>
								<span className="break-all">{record.name}</span>
								<span className="break-all">{record.value}</span>
							</li>
						))}
					</ul>
				</>
			)}

			{view?.keyConfigured && (
				<div className="flex flex-wrap items-center justify-between gap-2">
					<p className="text-xs text-neutral-500">
						{kind === "receiving"
							? mode === "aliases" ? "Adds the domain to ForwardEmail and delivers each mailbox address to this app." : "Adds the domain to ForwardEmail and delivers all its mail to this app."
							: "Adds the signing and bounce records ForwardEmail needs to send as this domain."}
					</p>
					<span className="flex gap-2">
						<Button size="sm" variant="outline" className="bg-white" disabled={busy !== null || loading} onClick={refresh}>{loading ? "Checking…" : "Check again"}</Button>
						{kind === "sending" && view.ready && <Button size="sm" variant="outline" className="bg-white" disabled={busy !== null} onClick={() => void run("test", { action: "test" })}>{busy === "test" ? "Sending…" : "Send test email"}</Button>}
						{(!view.ready || modeChanged) && !mxChoice && <Button size="sm" disabled={busy !== null || loading} onClick={() => void run("setup", { action: "setup" })}>{busy === "setup" ? "Working…" : modeChanged ? "Apply" : kind === "receiving" ? "Setup receiving" : "Setup sending"}</Button>}
					</span>
				</div>
			)}
			{notice && <p role="status" className="text-xs text-green-700">{notice}</p>}
			{error && <p role="alert" className="text-xs text-red-600">{error}</p>}
		</div>
	);
}
