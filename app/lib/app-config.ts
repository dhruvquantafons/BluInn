/**
 * The product's own identity, and the address this deployment answers on.
 *
 * Hotel identity — name, address, GSTIN — is not here: it belongs to each
 * property and is edited under Settings.
 */
export const PRODUCT = {
  name: "BluInn",
  tagline: "Hotel management, simplified",
} as const;

/**
 * Where this deployment lives, for the links it emails to staff ("open the
 * booking"). Set NEXT_PUBLIC_APP_URL in production; on Vercel the project's
 * production domain is used when it is not set.
 *
 * Trailing slashes are trimmed because every use appends a path.
 */
export const APP_URL = (
  process.env.NEXT_PUBLIC_APP_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : "") ||
  "http://localhost:3000"
).replace(/\/+$/, "");
