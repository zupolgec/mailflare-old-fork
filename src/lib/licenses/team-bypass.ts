import { eq } from "drizzle-orm";
import { getDb } from "@/db";
import { licenseSettings } from "@/db/schema";

const LICENSE_SETTINGS_ID = "default";

/**
 * Fork: true when Team features are unlocked without a license key
 * (TEAM_BYPASS set to "true" or "1"). Upstream has no equivalent file.
 */
export function isTeamBypassEnabled(env: Pick<CloudflareEnv, "TEAM_BYPASS">): boolean {
	const value = env.TEAM_BYPASS?.trim().toLowerCase();
	return value === "true" || value === "1";
}

/**
 * Fork: while TEAM_BYPASS is on, keep the license row on an active Team plan.
 * Every reader of license_settings (status, entitlements, mailbox sharing) then
 * sees Team, and the row re-heals on the next status read if anything writes
 * it back to a lower plan. Callers pass a row that was just read or created, so
 * the update only happens when the row actually drifted.
 */
export async function applyTeamBypassToRow(
	env: CloudflareEnv,
	settings: typeof licenseSettings.$inferSelect,
): Promise<typeof licenseSettings.$inferSelect> {
	if (!isTeamBypassEnabled(env)) return settings;
	if (settings.plan === "team" && settings.state === "active") return settings;
	const now = new Date();
	await getDb(env)
		.update(licenseSettings)
		.set({ plan: "team", state: "active", updatedAt: now })
		.where(eq(licenseSettings.id, LICENSE_SETTINGS_ID));
	return { ...settings, plan: "team", state: "active", updatedAt: now };
}
