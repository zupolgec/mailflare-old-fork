import { NextResponse } from "next/server";
import { z } from "zod";
import { getEnv } from "@/lib/cloudflare";
import { requireUser } from "@/lib/auth/cookies";
import { canManageDomains } from "@/lib/auth/admin";
import { hasValidSessionMutationOrigin } from "@/lib/auth/origin";
import { getDomainForUser } from "@/lib/domains/service";
import { getForwardEmailView, setupForwardEmail } from "@/lib/domains/forwardemail";
import { MxConflictError } from "@/lib/domains/receiving-dns";
import { sendSystemEmail } from "@/lib/email/system-mail";

type Params = { params: Promise<{ id: string }> };
const noStore = { "Cache-Control": "no-store" };
const kindSchema = z.enum(["receiving", "sending"]);
const postSchema = z.object({
	kind: kindSchema,
	action: z.enum(["setup", "test"]),
	replaceMx: z.boolean().optional(),
	keepMx: z.boolean().optional(),
	mode: z.enum(["aliases", "catchall"]).optional(),
});

const originOf = (env: CloudflareEnv, request: Request) => env.APP_URL?.trim() || new URL(request.url).origin;

/** Setup checklist for receiving (?kind=receiving) or sending (?kind=sending) through ForwardEmail. */
export async function GET(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	const domain = await getDomainForUser(env, user.id, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });
	const kind = kindSchema.safeParse(new URL(request.url).searchParams.get("kind"));
	if (!kind.success) return NextResponse.json({ error: "Unknown kind" }, { status: 400 });
	try {
		return NextResponse.json({ view: await getForwardEmailView(env, domain, kind.data, originOf(env, request)) }, { headers: noStore });
	} catch (error) {
		return NextResponse.json({ error: error instanceof Error ? error.message : "Could not reach ForwardEmail" }, { status: 502 });
	}
}

/**
 * Sets up ForwardEmail for one direction, or sends a test message. Receiving
 * answers 409 MX_CONFLICT while another service owns the MX, unless the caller
 * replaces it (replaceMx) or keeps it to relay chosen addresses (keepMx).
 */
export async function POST(request: Request, { params }: Params) {
	const { id } = await params;
	const env = getEnv();
	const user = await requireUser(env, request);
	if (!canManageDomains(user)) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
	if (!hasValidSessionMutationOrigin(request)) return NextResponse.json({ error: "Invalid origin" }, { status: 403 });
	const domain = await getDomainForUser(env, user.id, id);
	if (!domain) return NextResponse.json({ error: "Not found" }, { status: 404 });
	const parsed = postSchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return NextResponse.json({ error: "Unknown action" }, { status: 400 });
	const { kind, action, replaceMx, keepMx, mode } = parsed.data;
	try {
		if (action === "test") {
			const sent = await sendSystemEmail(env, {
				to: user.email,
				subject: "Mailflare test email",
				text: `This message confirms ${domain.hostname} can send mail through ForwardEmail.`,
				hostname: domain.hostname,
			});
			if (!sent) return NextResponse.json({ error: `Create a mailbox on ${domain.hostname} to send the test from.` }, { status: 400 });
			return NextResponse.json({ ok: true, to: user.email });
		}
		await setupForwardEmail(env, domain, kind, originOf(env, request), { replaceMx: replaceMx === true, keepMx: keepMx === true, mode });
		return NextResponse.json({ view: await getForwardEmailView(env, domain, kind, originOf(env, request)) }, { headers: noStore });
	} catch (error) {
		if (error instanceof MxConflictError) return NextResponse.json({ error: error.message, code: error.code, records: error.records }, { status: 409 });
		return NextResponse.json({ error: error instanceof Error ? error.message : "ForwardEmail request failed" }, { status: 502 });
	}
}
