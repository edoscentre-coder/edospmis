/**
 * Where this app lives, for links that leave it.
 *
 * Password resets, invitations and anything else opened from outside the
 * browser tab need an absolute URL. Building one from the request's own host
 * header is right for the request and wrong for the email: a reset asked for
 * on a dev server emails a link to localhost:3000, which is correct at the
 * moment it is made and useless by the time it reaches a phone. That is how
 * this was found, on the POS build.
 *
 * The host header is also attacker-controlled. A request carrying
 * `Host: attacker.example` would otherwise produce an email that is genuinely
 * ours, correctly signed, carrying a valid one-time token, pointing at
 * somebody else's server. Vercel rejects unknown hosts before they reach this
 * code — but that is a security property borrowed from the host, and it
 * disappears the day this runs anywhere else.
 *
 * So in production the origin must be a host we own. In development it is
 * whatever was asked for, because localhost there is what was meant.
 */

const PRODUCTION_URL = "https://edospmis.edoscentre.co.ke";

const LOOPBACK = /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(:\d+)?$/i;

function resolveSiteUrl(): string {
  const configured = process.env.NEXT_PUBLIC_SITE_URL?.trim().replace(/\/$/, "");
  if (!configured) return PRODUCTION_URL;
  // A configured value beats a missing one, so `NEXT_PUBLIC_SITE_URL` set to
  // localhost in production would win over any fallback. It has happened.
  if (process.env.NODE_ENV === "production" && LOOPBACK.test(configured)) {
    return PRODUCTION_URL;
  }
  return configured;
}

export const SITE_URL = resolveSiteUrl();

/**
 * Hosts this app may claim to be: the configured site, the canonical domain,
 * and Vercel previews — a preview must keep linking to itself, or testing a
 * branch sends the tester to production.
 */
function isKnownHost(host: string): boolean {
  const bare = host.toLowerCase().split(":")[0];
  const allowed = new Set<string>();

  for (const candidate of [SITE_URL, PRODUCTION_URL]) {
    try {
      allowed.add(new URL(candidate).hostname.toLowerCase());
    } catch {
      // A malformed configured value contributes nothing; the canonical
      // domain is always in the set.
    }
  }

  if (allowed.has(bare)) return true;
  return bare.endsWith(".vercel.app");
}

/**
 * The origin to put in an emailed link.
 *
 * Takes the request's own host where that host is one of ours, so previews
 * and custom domains keep working, and falls back to the canonical site
 * otherwise.
 */
export function originFromHeaders(headers: Headers): string {
  const forwardedHost = headers.get("x-forwarded-host") ?? headers.get("host");
  if (!forwardedHost) return SITE_URL;

  const proto =
    headers.get("x-forwarded-proto") ??
    (forwardedHost.startsWith("localhost") ? "http" : "https");
  const origin = `${proto}://${forwardedHost}`;

  if (process.env.NODE_ENV === "production") {
    if (LOOPBACK.test(origin)) return SITE_URL;
    if (!isKnownHost(forwardedHost)) return SITE_URL;
  }

  return origin;
}

/** Join a path onto an origin without ending up with a double slash. */
export function absoluteUrl(path: string, origin: string = SITE_URL): string {
  return `${origin.replace(/\/$/, "")}/${path.replace(/^\//, "")}`;
}
