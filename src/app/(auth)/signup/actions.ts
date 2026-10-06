"use server";

import { headers } from "next/headers";
import { originFromHeaders } from "@/lib/site-url";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { canSendEmail, sendEmail } from "@/lib/notify/email";
import { signupConfirmEmail } from "@/lib/notify/auth-email";
import { ensureWorkspace } from "@/lib/provision";

export interface SignUpState {
  error: string | null;
  /** Set once the confirmation email is on its way, so the form can say so. */
  checkEmail?: boolean;
  email?: string;
}


/**
 * Creates the account, and emails the confirmation as EDOSPMIS.
 *
 * `admin.generateLink` creates the user and hands back the confirmation token
 * without sending anything, which leaves the message to us — see
 * lib/notify/auth-email.ts for why that is worth the extra step.
 *
 * Where this deployment has no mail configured, it falls back to
 * `supabase.auth.signUp()` so sign-up still works; the person then gets
 * Supabase's own stock email, or lands straight in the app if the project
 * does not require confirmation at all.
 */
export async function signUp(
  _prev: SignUpState,
  form: FormData,
): Promise<SignUpState> {
  const fullName = String(form.get("full_name") ?? "").trim();
  const email = String(form.get("email") ?? "")
    .trim()
    .toLowerCase();
  const password = String(form.get("password") ?? "");
  const tenantName = String(form.get("tenant_name") ?? "").trim();

  if (!fullName || !email || !password || !tenantName) {
    return { error: "Please fill in every field." };
  }
  if (!email.includes("@"))
    return { error: "Please enter a valid email address." };
  if (password.length < 8)
    return { error: "Password must be at least 8 characters." };

  const base = originFromHeaders(await headers());

  // pending_tenant_name survives to the first moment a session exists, which
  // is where the workspace actually gets created — see lib/provision.ts.
  const metadata = { full_name: fullName, pending_tenant_name: tenantName };

  if (canSendEmail()) {
    let admin;
    try {
      admin = createAdminClient();
    } catch {
      return {
        error:
          "Sign-up isn't set up yet on this deployment. Please contact support.",
      };
    }

    const { data, error } = await admin.auth.admin.generateLink({
      type: "signup",
      email,
      password,
      options: {
        data: metadata,
        redirectTo: `${base}/auth/callback?next=/welcome`,
      },
    });

    if (error) {
      const message = error.message.toLowerCase();
      // Unlike a password reset, this one has to say so: the person is trying
      // to create an account and needs to know it already exists. Signing in
      // reveals the same thing anyway.
      if (message.includes("already") || message.includes("registered")) {
        return {
          error:
            "There is already an account with that email. Try signing in instead.",
        };
      }
      return { error: "We couldn't create your account. Please try again." };
    }

    const created = data?.user ?? null;

    /**
     * Undoes the account this request just created.
     *
     * `generateLink` creates the user before anything has been sent, so a mail
     * failure would otherwise strand the address for good: the person cannot
     * finish signing up, and cannot start again either, because the next
     * attempt is told the account already exists. Removing it puts them back
     * where they began, which is the only state they can act on themselves.
     *
     * Guarded, because deleting a user deserves to be narrow: only one that
     * has never confirmed an email and never signed in — which is exactly what
     * the call above just made, and never an account already in use. There is
     * nothing else to undo; the workspace is provisioned at the first sign-in,
     * not here.
     */
    const rollback = async (): Promise<boolean> => {
      if (!created?.id) return false;
      if (created.email_confirmed_at || created.last_sign_in_at) return false;
      const { error: deleteError } = await admin.auth.admin.deleteUser(
        created.id,
      );
      if (deleteError) {
        // Worth a line in the log: the address is now stuck, and knowing that
        // is the difference between fixing one account and hunting a ghost.
        console.error("EDOSPMIS signup rollback failed:", deleteError.message);
      }
      return !deleteError;
    };

    const tokenHash = data?.properties?.hashed_token;
    if (!tokenHash) {
      await rollback();
      return { error: "We couldn't create your account. Please try again." };
    }

    const link = `${base}/auth/callback?token_hash=${encodeURIComponent(tokenHash)}&type=signup&next=/welcome`;
    const sent = await sendEmail({
      to: email,
      ...signupConfirmEmail({ link, name: fullName || null }),
    });

    if (!sent.ok) {
      console.error("EDOSPMIS signup confirmation email failed:", sent.error);
      // Rolled back, so the message can tell them to simply try again —
      // advice that only works because the address is free once more.
      const undone = await rollback();
      return {
        error: undone
          ? "We couldn't send your confirmation email, so nothing was saved. Please try signing up again in a moment."
          : "Your account was created but we couldn't send the confirmation email. Use “Forgot your password?” on the sign-in page to get in.",
      };
    }

    return { error: null, checkEmail: true, email };
  }

  // ---- no mail configured: Supabase sends whatever it is set up to send ----
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: metadata },
  });
  if (error) return { error: error.message };

  if (!data.session || !data.user)
    return { error: null, checkEmail: true, email };

  await ensureWorkspace(supabase, data.user);
  redirect("/app");
}
