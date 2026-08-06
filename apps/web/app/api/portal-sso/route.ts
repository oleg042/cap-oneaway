import crypto, { timingSafeEqual } from "node:crypto";
import { db } from "@cap/database";
import { nanoId } from "@cap/database/helpers";
import { organizationMembers, organizations, users } from "@cap/database/schema";
import { Organisation, User } from "@cap/web-domain";
import { eq } from "drizzle-orm";
import { encode } from "next-auth/jwt";
import { NextResponse } from "next/server";

// OneAway portal SSO bridge. The OneAway portal (Clerk-authenticated) mints a short-lived HMAC ticket and
// sends the user here; we verify it, ensure a single shared "recorder" Cap account exists (fully
// provisioned with its org, so recordings have a valid orgId), mint that account's NextAuth session cookie,
// and redirect. Net effect: being logged into the portal = being logged into Cap, with NO separate Cap
// sign-in. Real per-recording authorship is tracked portal-side (the optimistic insert stamps the Clerk
// user), so a shared Cap identity is fine and avoids per-user provisioning.
export const dynamic = "force-dynamic";

const COOKIE_NAME = "next-auth.session-token";
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days, matching NextAuth's default
const RECORDER_EMAIL = (
	process.env.TAPE_RECORDER_EMAIL || "tape-recorder@oneaway.io"
).toLowerCase();

// Ticket = base64url(payloadJSON).base64url(hmacSHA256(payload, PORTAL_SSO_SECRET)). Payload carries an
// absolute `exp` (ms). Verified with a constant-time compare; rejected if malformed/expired.
function verifyTicket(ticket: string, secret: string): boolean {
	const dot = ticket.indexOf(".");
	if (dot <= 0) return false;
	const body = ticket.slice(0, dot);
	const sig = ticket.slice(dot + 1);
	const expected = crypto
		.createHmac("sha256", secret)
		.update(body)
		.digest("base64url");
	const a = Buffer.from(sig);
	const b = Buffer.from(expected);
	if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
	try {
		const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
		return typeof payload.exp === "number" && Date.now() <= payload.exp;
	} catch {
		return false;
	}
}

// Idempotently ensure the shared recorder account exists. Mirrors DrizzleAdapter.createUser: user + default
// org + owner membership + activeOrganizationId. Safe under concurrency (re-checks inside the transaction).
async function ensureRecorderUser() {
	const database = db();
	const [existing] = await database
		.select()
		.from(users)
		.where(eq(users.email, RECORDER_EMAIL))
		.limit(1);
	if (existing) return existing;

	const userId = User.UserId.make(nanoId());
	await database.transaction(async (tx) => {
		const [again] = await tx
			.select({ id: users.id })
			.from(users)
			.where(eq(users.email, RECORDER_EMAIL))
			.limit(1);
		if (again) return;
		await tx.insert(users).values({
			id: userId,
			email: RECORDER_EMAIL,
			name: "OneAway Tape",
			activeOrganizationId: Organisation.OrganisationId.make(""),
		});
		const orgId = Organisation.OrganisationId.make(nanoId());
		await tx
			.insert(organizations)
			.values({ id: orgId, ownerId: userId, name: "OneAway" });
		await tx.insert(organizationMembers).values({
			id: nanoId(),
			organizationId: orgId,
			userId,
			role: "owner",
		});
		await tx
			.update(users)
			.set({ activeOrganizationId: orgId, defaultOrgId: orgId })
			.where(eq(users.id, userId));
	});

	const [created] = await database
		.select()
		.from(users)
		.where(eq(users.email, RECORDER_EMAIL))
		.limit(1);
	return created;
}

export async function GET(request: Request) {
	const ssoSecret = process.env.PORTAL_SSO_SECRET;
	const authSecret = process.env.NEXTAUTH_SECRET;
	if (!ssoSecret || !authSecret) {
		return NextResponse.json({ error: "SSO not configured" }, { status: 500 });
	}

	const url = new URL(request.url);
	const ticket = url.searchParams.get("ticket") ?? "";
	if (!verifyTicket(ticket, ssoSecret)) {
		return NextResponse.json(
			{ error: "Invalid or expired ticket" },
			{ status: 401 },
		);
	}

	const user = await ensureRecorderUser();
	if (!user) {
		return NextResponse.json(
			{ error: "Could not provision recorder account" },
			{ status: 500 },
		);
	}

	// Mint the same JWT the app's jwt() callback produces, so decodeSessionToken accepts it.
	const token = await encode({
		token: {
			id: user.id,
			sub: user.id,
			name: user.name ?? "OneAway Tape",
			lastName: (user as { lastName?: string | null }).lastName ?? null,
			email: user.email,
			picture: (user as { image?: string | null }).image ?? null,
			sessionVersion: (user as { authSessionVersion?: number }).authSessionVersion ?? 0,
		},
		secret: authSecret,
		maxAge: SESSION_MAX_AGE,
	});

	// Only allow same-origin relative redirects to avoid an open redirect.
	const requested = url.searchParams.get("redirect") ?? "/dashboard";
	const safe =
		requested.startsWith("/") && !requested.startsWith("//")
			? requested
			: "/dashboard";

	const res = NextResponse.redirect(new URL(safe, url.origin));
	res.cookies.set(COOKIE_NAME, token, {
		httpOnly: true,
		sameSite: "none",
		secure: true,
		path: "/",
		maxAge: SESSION_MAX_AGE,
	});
	return res;
}
