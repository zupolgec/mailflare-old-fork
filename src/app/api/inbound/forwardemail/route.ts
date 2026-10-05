import { NextResponse } from "next/server";
import { getEnv } from "@/lib/cloudflare";
import { getForwardEmailApiKey } from "@/lib/email/forwardemail-api";
import { forwardEmailWebhookToken, parseForwardEmailWebhook, tokensMatch } from "@/lib/email/forwardemail-webhook";
import { intakeProviderMail } from "@/lib/email/provider-intake";

export const dynamic = "force-dynamic";

/**
 * ForwardEmail's webhook for a domain's catch-all alias. The body carries the
 * raw MIME, so the message goes straight to the normal intake. Authenticated by
 * the token in the URL, derived from the API key. ForwardEmail waits only a few
 * seconds, which is enough: intake stores the message and queues the rest.
 */
export async function POST(request: Request) {
	const env = getEnv();
	const apiKey = getForwardEmailApiKey(env);
	if (!apiKey) return NextResponse.json({ error: "ForwardEmail receiving is not set up" }, { status: 503 });
	if (!tokensMatch(await forwardEmailWebhookToken(apiKey), new URL(request.url).searchParams.get("token"))) {
		return NextResponse.json({ error: "Invalid token" }, { status: 401 });
	}
	const message = parseForwardEmailWebhook(await request.text());
	if (!message) return NextResponse.json({ error: "Invalid body" }, { status: 400 });
	return NextResponse.json(await intakeProviderMail(env, message));
}
