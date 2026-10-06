"use server";

import { headers } from "next/headers";
import { originFromHeaders } from "@/lib/site-url";
import { createAdminClient } from "@/lib/supabase/admin";
import { canSendEmail, sendEmail } from "@/lib/notify/email";
import { passwordResetEmail } from "@/lib/notify/auth-email";

export interface ResetState {
  error: string | null;
  sent?: boolean;
}

/**
 * Recent requests per address.
 *
 * In memory, so it resets on deploy and is per-instance. That is weak on its
 * own; it is not on its own, because a link is only ever generated for an
 * address that already has an account here. This just stops one person
 * hammering the button.
 */
const recent = new Map<string, number[]>();
const WINDOW_MS = 15 * 60 * 1000;
const MAX_PER_WINDOW = 3;

function rateLimited(email: string): boolean {
  const now = Date.now();
  const seen = (recent.get(email) ?? []).filter((t) => now - t < WINDOW_MS);
  if (seen.length >= MAX_PER_WINDOW) {
    recent.set(email, seen);
    return true;
  }
  seen.push(now);
  recent.set(email, seen);
  return false;
}


/**
 * Emails a password-reset link, as EDOSPMIS.
 *
 * The link is built here with the token in the query string rather than taken
 * from Supabase's `action_link`, which returns its tokens in a URL fragment —
 * and a browser never sends a fragment to the server, so /auth/callback could
 * not read them at all.
 *
 * It answers the same whether or not the address has an account: naming one
 * that does not would let anyone with this page check who our customers are.
 */
export async function requestPasswordReset(
  _prev: ResetState,
  form: FormData,
): Promise<ResetState> {
  const address = String(form.get("email") ?? "").trim().toLowerCase();
  if (!address || !address.includes("@")) {
    return { error: "Please enter a valid email address." };
  }

  // A misconfigured deployment is not a secret, and silence here would leave
  // nobody able to tell it apart from an address with no account.
  if (!canSendEmail()) {
    return { error: "Password reset email isn't set up yet. Please contact support." };
  }

  if (rateLimited(address)) {
    return { error: "Too many requests. Please wait a few minutes and try again." };
  }

  const indistinguishable: ResetState = { error: null, sent: true };

  let admin;
  try {
    admin = createAdminClient();
  } catch {
    return { error: "Password reset isn't set up yet. Please contact support." };
  }

  const base = originFromHeaders(await headers());
  const { data, error } = await admin.auth.admin.generateLink({
    type: "recovery",
    email: address,
    options: { redirectTo: `${base}/auth/callback?next=/update-password%3Ftype%3Drecovery` },
  });

  const tokenHash = data?.properties?.hashed_token;
  if (error || !tokenHash) return indistinguishable;

  const link = `${base}/auth/callback?token_hash=${encodeURIComponent(tokenHash)}&type=recovery&next=/update-password%3Ftype%3Drecovery`;
  const sent = await sendEmail({ to: address, ...passwordResetEmail({ link }) });

  if (!sent.ok) {
    // Worth knowing in the logs; still not worth telling the browser, which
    // would confirm that the address exists.
    console.error("EDOSPMIS password reset email failed:", sent.error);
  }

  return indistinguishable;
}
