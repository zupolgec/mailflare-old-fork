import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = mkdtempSync(join(root, "tests", ".tmp-team-bypass-"));
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
		external: ["better-sqlite3"],
	});
	return import(pathToFileURL(join(outDir, outfile)).href);
}

const { SqliteDatabase } = await bundle("server/runtime/sqlite-database.ts", "sqlite.mjs");
const { getDb } = await bundle("src/db/index.ts", "db.mjs");
const licenses = await bundle("src/lib/licenses/service.ts", "licenses.mjs");
const { isTeamMailboxSharingEnabled } = await bundle("src/lib/mailboxes/access-utils.ts", "access.mjs");

const migrationsDir = join(root, "drizzle", "migrations");
const migrationStatements = readdirSync(migrationsDir)
	.filter((name) => name.endsWith(".sql"))
	.sort()
	.map((name) => readFileSync(join(migrationsDir, name), "utf8"));

function createEnv(teamBypass) {
	const database = new SqliteDatabase(":memory:");
	for (const sql of migrationStatements) database.db.exec(sql);
	database.db
		.prepare("INSERT INTO license_settings (id, instance_id, updated_at) VALUES ('default', 'inst', 1)")
		.run();
	return { DB: database, TEAM_BYPASS: teamBypass ? "true" : undefined };
}

test("without TEAM_BYPASS a fresh install stays on the community plan", async () => {
	const env = createEnv(false);
	try {
		const status = await licenses.getLicenseStatus(env);
		assert.equal(status.plan, "community");
		assert.equal(status.state, "inactive");
		assert.equal(status.active, false);
		const entitlements = await licenses.getLicenseEntitlements(env);
		assert.deepEqual(entitlements, {
			plan: "community",
			canCustomizeBranding: false,
			canManageAccounts: false,
			canForwardEmail: false,
		});
		assert.equal(await isTeamMailboxSharingEnabled(getDb(env)), false);
	} finally {
		env.DB.db.close();
	}
});

test("TEAM_BYPASS reports an active Team plan and unlocks team entitlements and shared mailboxes", async () => {
	const env = createEnv(true);
	try {
		const status = await licenses.getLicenseStatus(env);
		assert.equal(status.plan, "team");
		assert.equal(status.state, "active");
		assert.equal(status.active, true);
		const entitlements = await licenses.getLicenseEntitlements(env);
		assert.equal(entitlements.canManageAccounts, true);
		assert.equal(entitlements.canForwardEmail, true);
		assert.equal(entitlements.canCustomizeBranding, true);
		assert.equal(await isTeamMailboxSharingEnabled(getDb(env)), true);
	} finally {
		env.DB.db.close();
	}
});

test("TEAM_BYPASS restores the Team plan after the row drifts away from it", async () => {
	const env = createEnv(true);
	try {
		await licenses.getLicenseStatus(env);
		env.DB.db
			.prepare("UPDATE license_settings SET plan = 'community', state = 'invalid' WHERE id = 'default'")
			.run();
		assert.equal(await isTeamMailboxSharingEnabled(getDb(env)), false);
		const status = await licenses.getLicenseStatus(env);
		assert.equal(status.plan, "team");
		assert.equal(status.state, "active");
		assert.equal(await isTeamMailboxSharingEnabled(getDb(env)), true);
	} finally {
		env.DB.db.close();
	}
});

test("TEAM_BYPASS keeps license actions away from Paymug and the plan stays Team", async () => {
	const env = createEnv(true);
	const calls = [];
	const realFetch = globalThis.fetch;
	globalThis.fetch = async (url) => {
		calls.push(String(url));
		throw new Error("network disabled");
	};
	try {
		for (const action of [
			() => licenses.activateLicense(env, "any-key", "https://mail.example.com", "team"),
			() => licenses.validateLicense(env, "any-key", "https://mail.example.com"),
			() => licenses.deactivateLicense(env),
		]) {
			const status = await action();
			assert.equal(status.plan, "team");
			assert.equal(status.state, "active");
		}
		assert.equal(calls.length, 0);
		assert.equal(await isTeamMailboxSharingEnabled(getDb(env)), true);
	} finally {
		globalThis.fetch = realFetch;
		env.DB.db.close();
	}
});
