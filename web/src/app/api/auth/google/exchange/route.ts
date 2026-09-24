import { db } from "@/lib/db";
import { users, oauthTokens, settings, emailIdentities } from "@/lib/db/schema";
import { encrypt } from "@/lib/crypto";
import { createSessionToken, verifySessionToken } from "@/lib/session";
import { exchangeCodeForTokens, fetchGoogleProfile } from "@/lib/google-oauth";

// Called by the extension after chrome.identity.launchWebAuthFlow returns an
// authorization code. Exchanges it server-side (client secret never touches
// the extension), upserts the user, and returns a session token for the
// extension to store and send as `Authorization: Bearer <token>` from then on.
export async function POST(request: Request) {
  const body = await request.json().catch(() => null);
  const code = body?.code;
  const redirectUri = body?.redirectUri;
  const timezone = typeof body?.timezone === "string" ? body.timezone : undefined;

  if (typeof code !== "string" || typeof redirectUri !== "string") {
    return Response.json(
      { error: "code and redirectUri are required" },
      { status: 400 },
    );
  }

  try {
    const tokens = await exchangeCodeForTokens(code, redirectUri);
    if (!tokens.refresh_token) {
      // Happens if the user has already granted consent before without
      // `prompt=consent` forcing a fresh refresh token. The extension should
      // re-run the auth flow with prompt=consent if this occurs.
      return Response.json(
        { error: "No refresh token returned — retry the consent flow" },
        { status: 409 },
      );
    }
    const profile = await fetchGoogleProfile(tokens.access_token);

    const [user] = await db
      .insert(users)
      .values({ googleAccountId: profile.sub, email: profile.email, name: profile.name })
      .onConflictDoUpdate({
        target: users.googleAccountId,
        set: { email: profile.email, name: profile.name },
      })
      .returning();

    await db
      .insert(oauthTokens)
      .values({
        userId: user.id,
        accessTokenEncrypted: encrypt(tokens.access_token),
        refreshTokenEncrypted: encrypt(tokens.refresh_token),
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
        scope: tokens.scope,
      })
      .onConflictDoUpdate({
        target: oauthTokens.userId,
        set: {
          accessTokenEncrypted: encrypt(tokens.access_token),
          refreshTokenEncrypted: encrypt(tokens.refresh_token),
          expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
          scope: tokens.scope,
        },
      });

    await db
      .insert(settings)
      .values({ userId: user.id, timezone: timezone ?? "UTC" })
      .onConflictDoNothing({ target: settings.userId });

    // Seeds the address -> user_id lookup email ingest resolves senders
    // through (SPEC.md's family-readiness note: identity for new channels
    // never becomes a column on `users`). Idempotent — re-auth doesn't
    // duplicate or move the mapping.
    await db
      .insert(emailIdentities)
      .values({ address: user.email.toLowerCase(), userId: user.id })
      .onConflictDoNothing({ target: emailIdentities.address });

    const sessionToken = await createSessionToken(user.id);
    // TEMP DIAGNOSTIC — remove after resolving the "session expired
    // immediately after sign-in" bug. Round-trips the token within this
    // same request/process to rule out any deployment- or secret-related
    // inconsistency between signing and verifying.
    const roundTrip = await verifySessionToken(sessionToken);
    console.log("[debug-session]", {
      userId: user.id,
      userIdType: typeof user.id,
      roundTripUserId: roundTrip,
      match: roundTrip === user.id,
      tokenPreview: sessionToken.slice(0, 20),
    });
    return Response.json({ sessionToken, email: user.email });
  } catch (err) {
    console.error("[auth/google/exchange]", err);
    return Response.json({ error: "OAuth exchange failed" }, { status: 500 });
  }
}
