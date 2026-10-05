import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test, { after, afterEach } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(tmpdir(), "mailflare-forwardemail-"));
after(() => rmSync(outDir, { recursive: true, force: true }));

async function bundle(entry, outfile) {
	await build({
		entryPoints: [join(root, entry)],
		outfile: join(outDir, outfile),
		bundle: true,
		platform: "node",
		format: "esm",
		target: "node22",
		logLevel: "silent",
		alias: { "@": join(root, "src") },
	});
	return import(pathToFileURL(join(outDir, outfile)).href);
}

const webhook = await bundle("src/lib/email/forwardemail-webhook.ts", "webhook.mjs");
const api = await bundle("src/lib/email/forwardemail-api.ts", "api.mjs");
const records = await bundle("src/lib/domains/forwardemail-utils.ts", "records.mjs");

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** Records every request and answers each with the next queued response. */
function mockFetch(...responses) {
	const calls = [];
	globalThis.fetch = async (url, init = {}) => {
		calls.push({ url: String(url), init });
		const next = responses.shift() ?? { status: 200, body: {} };
		return new Response(JSON.stringify(next.body), { status: next.status, headers: { "Content-Type": "application/json" } });
	};
	return calls;
}

const RAW = [
	"From: Alice <alice@example.org>",
	"To: support@acme.test",
	"Subject: Ciao",
	"Message-ID: <abc@example.org>",
	"",
	"Hello there",
].join("\r\n");

test("webhook token is stable per API key and differs between keys", async () => {
	const a = await webhook.forwardEmailWebhookToken("key-one");
	assert.match(a, /^[0-9a-f]{64}$/);
	assert.equal(await webhook.forwardEmailWebhookToken("key-one"), a);
	assert.notEqual(await webhook.forwardEmailWebhookToken("key-two"), a);
});

test("webhook URL carries the token and skips parsed attachments", () => {
	const url = new URL(webhook.forwardEmailWebhookUrl("https://mail.acme.test/", "tok"));
	assert.equal(url.origin + url.pathname, "https://mail.acme.test/api/inbound/forwardemail");
	assert.equal(url.searchParams.get("token"), "tok");
	assert.equal(url.searchParams.get("attachments"), "false");
});

test("webhook token comparison accepts only the exact token", async () => {
	const token = await webhook.forwardEmailWebhookToken("key-one");
	assert.equal(webhook.tokensMatch(token, token), true);
	assert.equal(webhook.tokensMatch(token, token.slice(0, -1) + (token.endsWith("0") ? "1" : "0")), false);
	assert.equal(webhook.tokensMatch(token, null), false);
	assert.equal(webhook.tokensMatch(token, ""), false);
});

test("webhook payload yields envelope sender, every recipient and the raw MIME bytes", () => {
	const body = JSON.stringify({
		raw: RAW,
		recipients: ["Support@Acme.test", "info@acme.test"],
		session: { recipient: "https://mail.acme.test/api/inbound/forwardemail", sender: "bounce@example.org" },
		from: { value: [{ address: "alice@example.org", name: "Alice" }], text: "Alice <alice@example.org>" },
		subject: "Ciao",
	});
	const parsed = webhook.parseForwardEmailWebhook(body);
	assert.equal(parsed.from, "bounce@example.org");
	assert.deepEqual(parsed.recipients, ["Support@Acme.test", "info@acme.test"]);
	assert.equal(new TextDecoder().decode(parsed.raw), RAW);
});

test("webhook payload falls back to the From header when there is no envelope sender", () => {
	const parsed = webhook.parseForwardEmailWebhook(JSON.stringify({
		raw: RAW,
		recipients: ["support@acme.test"],
		session: { sender: "" },
		from: { value: [{ address: "alice@example.org" }] },
	}));
	assert.equal(parsed.from, "alice@example.org");
});

test("webhook payload without raw MIME or recipients is rejected", () => {
	assert.equal(webhook.parseForwardEmailWebhook("not json"), null);
	assert.equal(webhook.parseForwardEmailWebhook(JSON.stringify({ recipients: ["a@acme.test"] })), null);
	assert.equal(webhook.parseForwardEmailWebhook(JSON.stringify({ raw: RAW, recipients: [] })), null);
});

test("sending posts to the emails API with Basic auth, our Message-ID and base64 attachments", async () => {
	const calls = mockFetch({ status: 200, body: { id: "fe-1", message_id: "<ignored@forwardemail.net>" } });
	const result = await api.sendForwardEmail("secret-key", {
		from: "Support <support@acme.test>",
		to: ["bob@example.org"],
		cc: ["carol@example.org"],
		subject: "Re: Ciao",
		html: "<p>Hi</p>",
		text: "Hi",
		headers: { "Message-ID": "<mine@acme.test>", "In-Reply-To": "<abc@example.org>", References: "<abc@example.org>" },
		attachments: [{ filename: "a.txt", type: "text/plain", content: new TextEncoder().encode("hey").buffer, disposition: "attachment" }],
	});
	assert.equal(result.messageId, "<mine@acme.test>");
	assert.equal(calls.length, 1);
	assert.equal(calls[0].url, "https://api.forwardemail.net/v1/emails");
	assert.equal(calls[0].init.method, "POST");
	assert.equal(calls[0].init.headers.Authorization, `Basic ${Buffer.from("secret-key:").toString("base64")}`);
	const body = JSON.parse(calls[0].init.body);
	assert.equal(body.from, "Support <support@acme.test>");
	assert.deepEqual(body.to, ["bob@example.org"]);
	assert.deepEqual(body.cc, ["carol@example.org"]);
	assert.equal(body.bcc, undefined);
	assert.equal(body.messageId, "<mine@acme.test>");
	assert.equal(body.headers["Message-ID"], undefined);
	assert.equal(body.headers["In-Reply-To"], "<abc@example.org>");
	assert.deepEqual(body.attachments, [{ filename: "a.txt", content: Buffer.from("hey").toString("base64"), encoding: "base64", contentType: "text/plain", contentDisposition: "attachment" }]);
});

test("sending mints a Message-ID on the sender's domain when none is given", async () => {
	const calls = mockFetch({ status: 200, body: { id: "fe-2" } });
	const result = await api.sendForwardEmail("k", { from: "support@acme.test", to: ["bob@example.org"], subject: "Hi", text: "Hi" });
	assert.match(result.messageId, /^<[0-9a-f-]+@acme\.test>$/);
	assert.equal(JSON.parse(calls[0].init.body).messageId, result.messageId);
});

test("inline attachments keep their content id", async () => {
	const calls = mockFetch({ status: 200, body: {} });
	await api.sendForwardEmail("k", {
		from: "support@acme.test", to: ["bob@example.org"], subject: "Hi", html: "<img src=\"cid:logo\">",
		attachments: [{ filename: "logo.png", type: "image/png", content: new Uint8Array([1, 2]).buffer, disposition: "inline", contentId: "logo" }],
	});
	const [attachment] = JSON.parse(calls[0].init.body).attachments;
	assert.equal(attachment.cid, "logo");
	assert.equal(attachment.contentDisposition, "inline");
});

test("API errors surface ForwardEmail's message", async () => {
	mockFetch({ status: 403, body: { statusCode: 403, error: "Forbidden", message: "Outbound SMTP is not enabled for this domain." } });
	await assert.rejects(
		api.sendForwardEmail("k", { from: "support@acme.test", to: ["bob@example.org"], subject: "Hi", text: "Hi" }),
		/ForwardEmail: Outbound SMTP is not enabled for this domain\./,
	);
});

test("a missing domain reads as null, other failures throw", async () => {
	const calls = mockFetch({ status: 404, body: { message: "Domain does not exist" } }, { status: 500, body: { message: "boom" } });
	assert.equal(await api.getForwardEmailDomain("k", "acme.test"), null);
	assert.equal(calls[0].url, "https://api.forwardemail.net/v1/domains/acme.test");
	await assert.rejects(api.getForwardEmailDomain("k", "acme.test"), /ForwardEmail: boom/);
});

test("a missing catch-all alias reads as null", async () => {
	const calls = mockFetch({ status: 404, body: { message: "Alias does not exist" } });
	assert.equal(await api.getForwardEmailAlias("k", "acme.test", "*"), null);
	assert.equal(calls[0].url, "https://api.forwardemail.net/v1/domains/acme.test/aliases/*");
});

test("new domains are created without ForwardEmail's default catch-all", async () => {
	const calls = mockFetch({ status: 200, body: { id: "d1", name: "acme.test" } });
	await api.createForwardEmailDomain("k", "acme.test");
	const body = JSON.parse(calls[0].init.body);
	assert.equal(body.domain, "acme.test");
	assert.equal(body.catchall, false);
});

test("verification, DKIM, return-path and DMARC records are absolute names on the domain", () => {
	const domain = {
		verification_record: "AbCd1234",
		smtp_dns_records: {
			dkim: { name: "fe-a1b2c3._domainkey", value: "v=DKIM1; k=rsa; p=MIIB;" },
			return_path: { name: "fe-bounces", value: "forwardemail.net" },
			dmarc: { name: "_dmarc", value: "v=DMARC1; p=reject; pct=100; rua=mailto:dmarc-d1@forwardemail.net;" },
		},
	};
	assert.deepEqual(records.forwardEmailVerificationRecord("acme.test", domain), { type: "TXT", name: "acme.test", value: "forward-email-site-verification=AbCd1234" });
	assert.deepEqual(records.forwardEmailSendingRecords("acme.test", domain), [
		{ key: "dkim", type: "TXT", name: "fe-a1b2c3._domainkey.acme.test", value: "v=DKIM1; k=rsa; p=MIIB;" },
		{ key: "return_path", type: "CNAME", name: "fe-bounces.acme.test", value: "forwardemail.net" },
		{ key: "dmarc", type: "TXT", name: "_dmarc.acme.test", value: "v=DMARC1; p=reject; pct=100; rua=mailto:dmarc-d1@forwardemail.net;" },
	]);
});

test("ForwardEmail MX hosts are recognised with or without a trailing dot", () => {
	assert.equal(records.isForwardEmailMx("mx1.forwardemail.net"), true);
	assert.equal(records.isForwardEmailMx("MX2.forwardemail.net."), true);
	assert.equal(records.isForwardEmailMx("aspmx.l.google.com"), false);
	assert.equal(records.isForwardEmailMx("route1.mx.cloudflare.net"), false);
});

test("only a catch-all pointing at Mailflare's webhook counts as Mailflare's", () => {
	assert.equal(records.isMailflareWebhook("https://mail.acme.test/api/inbound/forwardemail?token=abc&attachments=false"), true);
	assert.equal(records.isMailflareWebhook("someone@gmail.com"), false);
	assert.equal(records.isMailflareWebhook("https://hooks.example.org/inbound"), false);
	assert.deepEqual(records.catchAllOwnership(null), "none");
	assert.deepEqual(records.catchAllOwnership({ recipients: ["https://mail.acme.test/api/inbound/forwardemail?token=abc"] }), "mailflare");
	assert.deepEqual(records.catchAllOwnership({ recipients: ["me@gmail.com"] }), "other");
	assert.deepEqual(records.catchAllOwnership({ recipients: ["me@gmail.com", "https://mail.acme.test/api/inbound/forwardemail?token=abc"] }), "shared");
});
