# Client-era audit

BluInn began as the PMS for a single client hotel. This file lists everything still in the
repository that was built for that one hotel, rather than for a product sold to many. Each row
is either **Done** (cleaned up in the November 2026 pass) or **Later** (with a recommendation).

Ground rules from the split, which still apply:

- Nothing in BluInn belongs to one hotel. Hotel identity goes in `properties` and **Settings**, and
  product identity in `app/lib/app-config.ts` (`PRODUCT`).
- BluInn is staff-only. There is no public site, guest portal or booking widget.
- India comes first for now: ₹, GST, Indian ID types and +91 stay as defaults. Section C lists
  them so they can be made per-property later.
- Never edit an applied migration. Add a new numbered one instead.

---

## A. Leftovers from the guest portal and public website

| # | What | Where | Status |
|---|---|---|---|
| A1 | Guest-scoped read policies (guests, bookings, payments, folio, notifications) and the portal functions `current_guest`, `guest_link_account`, `guest_update_profile`, `guest_cancel_booking`, `portal_settings`, `auth_used_password` | `0021_guest_portal.sql`, `0023_guest_password_login.sql`, `0022:171` | **Done.** Dropped by `0026_drop_guest_portal.sql` |
| A2 | `can_access_property()` had a signed-in guest branch and an `else` branch for "the public website, which sells one hotel". Every per-property policy goes through this function | `0024_multi_property.sql:158` | **Done.** Rewritten in `0026`: a null property, or staff working in that property; otherwise false |
| A3 | `handle_new_user()` let `is_guest` sign-ups through | `0021:54` | **Done.** `0026` removes the branch; only the very first login becomes an admin |
| A4 | Anyone with the public (anon) key could read room types, extra charges, rate plans, seasons, restrictions, package components, applied price changes, public promo codes and currencies | `0001:195-196`, `0006:330-343`, `0020:561-605`, `0021:387` | **Done.** `0026` requires `is_staff()`. Applied prices and public codes stay readable by any staff member, because the desk quotes from them |
| A5 | Columns only the portal used: `guests.auth_user_id`, `guests.account_created_at`, `properties.best_rate_message`, `group_settings.best_rate_message` | `0021`, `0024:253` | **Later.** The app no longer reads them, and the `best_rate_message` form fields are gone. Dropping the columns means rebuilding the `property_settings` view (`select *` over `properties`) and `push_central_config()` |
| A6 | `guest_feedback.token`, `requested_at`, and `source='guest'` exist only for the deleted `/feedback/[token]` page | `0013:71` | **Later.** Drop `token` in a schema-cleanup migration |
| A7 | Copy and comments about a "feedback link" that no longer exists | guest profile, Settings → notifications, `message-templates.ts`, the `reissueKeys` comment | **Done** |
| A8 | The `request_received` message template ("a guest sends a booking request online") | seeded in `0013:190`, `message-templates.ts`, `booking-actions.ts`, tests | **Later.** Remove it, or rename it to a desk-sent "tentative booking" acknowledgement |
| A9 | The `publicOnly` option on `loadPricingData()` and `resolvePromo()`, which no caller passed | `app/lib/rate-data.ts` | **Done.** Removed. The tested `checkPromo({ publicOnly })` flag is kept for a future channel or booking engine |
| A10 | The "offer on the website" flags `rate_plans.is_public`, `packages.is_public` and `promo_codes.is_public` | rates and revenue pages | **Later.** Keep the columns, but relabel them "sell on channels / booking engine" when the channel manager (Module 9) is built |
| A11 | Website marketing fields on room types (`tagline`, `highlights`, `size`, `view`, `slug`, `gallery`) and the public `room-photos` bucket ("the marketing site must load these without a key") | `rates-actions.ts`, `rates/NewRoomTypeForm.tsx`, `rates/RoomPhotoForm.tsx`, `0002_room_photos.sql`, the public mode of `app/api/storage/...` | **Later.** Make the bucket private (signed URLs only). Drop the "card" and "pop-up" wording, or move the fields to a booking-engine config |
| A12 | The unused server action `validatePromoCode`. An exported server action is still a reachable endpoint | `revenue-actions.ts` | **Done.** Removed |
| A13 | Guest-portal checks in the SQL behaviour suite | `neon/tests/behaviour.sql` | **Done.** Replaced by staff-only access checks |
| A14 | Self-signup left on in the desktop auth service, plus a comment about guest-portal one-time codes | `desktop/lib/services.js:21` (`GOTRUE_DISABLE_SIGNUP: "false"`), `desktop/scripts/stage-app.mjs:74` | **Later** (desktop is frozen for now). Turn signup off. On hosted Supabase, also turn it off in the dashboard |

## B. One client's seed data and scope

| # | What | Where | Status |
|---|---|---|---|
| B1 | The original hotel's real tariff: "Premier Room" ₹9,499 and "Luxury Room" ₹10,799 with full marketing copy; extra charges 2,200 / 1,500 / 1,470 / 750 | `0001_init.sql:211-236` | **Later.** Move to an optional `scripts/seed-demo.sql`. A later migration can delete the rows when they are untouched |
| B2 | Demo rooms 101–104 and 201–204 tied to those slugs. The test seed copies the client's production data (`quoted_rate 9499`, source `website`) | `desktop/scripts/dev-stack.js:86-90`, `neon/tests/seed_before_upgrade.sql` | **Later.** Move to the demo seed |
| B3 | Rate plan "BAR … with breakfast, free cancellation up to 48 hours" (meal plan CP), and the form hint "CPAI, inclusive of taxes" | `0006:187-193`, `rates/NewRoomTypeForm.tsx:38`, `rates/RoomTypeForm.tsx:38` | **Later.** Make the hint generic, and keep the plan only as an optional default |
| B4 | A one-hall banquet model: the seeded "Grand Conference Hall", six catering packages and eight equipment items. The setup UI only adds a space when there is none, the copy says "the hall", and equipment has no clash check because "with one hall, two functions can't overlap" | `0019_events.sql:101-205`, `events/setup/page.tsx:221-231`, `event-actions.ts`, `db-errors.ts:98`, README Known gaps #8 | **Done (Nov 2026).** Setup adds any number of spaces, the copy says "space", and `0034` refuses equipment over-committed across overlapping confirmed functions. The seeded hall and packages are still seeds (see B7) |
| B5 | All seven POS outlets seeded with Indian GST rates | `0017_pos.sql:74-85` | **Later.** Seed nothing, or offer an onboarding template |
| B6 | Daily stay-over and touch-up housekeeping removed "to the SOW"; lost & found trimmed to that client's fields | `0010_housekeeping_sow_scope.sql` | **Done (Nov 2026)** for stay-overs: `0032` brings them back behind **Settings → Daily service for stay-over rooms**. Touch-ups and the trimmed lost & found fields stay as they are |
| B7 | Loyalty tiers (₹75,000 / ₹200,000, "Airport transfer"), HR departments and shifts, the housekeeping checklist, and starter exchange rates | `0016:83-90`, `0012:46-75`, `0009:71-80`, `0015:80-90` | **Later.** Sensible defaults. Turn them into onboarding templates rather than migration seeds |
| B8 | About 100 references to the client's contract ("SOW Module N", "SOW §x.y", "the SOW asks for") in code comments, `.env.example` and some on-screen copy (Reports: "the SOW leaves accounting…") | `app/`, `.env.example`, `tests/` | **Done.** Rewritten as the README's module numbers. Migrations and `desktop/` still contain them; leave those as history |
| B9 | `docs/go-live-checklist.md` is written for the original hotel ("all seven ship set up, with only the restaurant, mini-bar, room service and laundry open", "Set the hall's real rates") | whole file | **Later.** Rewrite as a generic tenant onboarding checklist, and eventually as in-app onboarding |
| B10 | "this system" and "the panel" in on-screen copy | POS menu, notification log, roles, staff, Password & 2FA | **Done.** These now read `PRODUCT.name` |

## C. India-first assumptions to make per-property later

There is a per-property `currency` setting already; most of the app ignores it.

| # | What | Where |
|---|---|---|
| C1 | `fmtMoney()` always prints `₹` with `en-IN` grouping (about 250 uses). `formatIn()` is currency-aware but also fixes `en-IN` | `components/ui.tsx:397`, `app/lib/currency.ts` |
| C2 | `₹` hardcoded in about 66 field labels and success messages | Settings, rates, revenue, bookings, companies, actions, `charts.tsx` |
| C3 | The rupee icons `IndianRupee` and `ReceiptIndianRupee` | `components/nav.ts`, `AuthShell.tsx`, the dashboard, rates, events |
| C4 | `Asia/Kolkata` fallbacks. The maintenance alert emails ignored the property's timezone; **fixed** (they now use the ticket's property) | `cron/reports`, `cron/maintenance`, `report-email.ts`, `settings.ts`, `0012:240` |
| C5 | Default nationality "Indian" and country "India"; "foreign" means "not Indian" | `CheckInForm.tsx:46`, `frontdesk-actions.ts`, `booking-actions.ts`, `guest-actions.ts`, `NewBookingForm.tsx` |
| C6 | A passport requirement for foreign guests (Form C reporting is not planned; decided Nov 2026) | `frontdesk-actions.ts:155`, `CheckInForm.tsx:108` |
| C7 | ID types `aadhaar`, `voter_id` and `pan`, fixed in a database check constraint | `0007_reservations.sql:64`, `types.ts`, actions |
| C8 | `normalisePhone()` adds `+91` to any 10-digit number (also used for Razorpay) | `app/lib/integrations.ts:72`, `billing-actions.ts` |
| C9 | GST slabs as the default tax template (5% up to ₹7,500, 18% above). The slab engine itself is generic | `settings.ts`, `actions.ts`, `0024` group settings |
| C10 | The April–March financial year for invoice and event numbering and the "this financial year" report preset | `app/lib/invoices.ts:81`, `app/lib/reports.ts:178`, `0014:164` |
| C11 | GSTIN as the only tax-registration field, and a "GST return" summary | invoices, `types.ts`, `reports.ts` |
| C12 | Razorpay as the only payment gateway, built on paise | `app/lib/razorpay.ts`, the webhook route, `billing-actions.ts` |
| C13 | Weekend fixed as Friday and Saturday nights | `app/lib/pricing.ts:97` |

Recommendation: a per-property **region profile** (currency, locale, home country, dialling code,
ID types, fiscal-year start, weekend nights, tax-ID label) that seeds these defaults, with India as
the first profile.

## D. Deployment model

| # | What | Status |
|---|---|---|
| D1 | `desktop/`: a Windows Electron installer with bundled Postgres, GoTrue and PostgREST, a 10-day trial and machine-locked licence keys. It still shows the **old client visuals** (`desktop/build/icon.png` is the "SR" gold monogram; `desktop/ui/style.css` is the gold palette) and the old vendor contact (`desktop/contact.json`: a personal email and phone) | **Later**, by decision: left untouched in this pass. Rebrand or move to its own repository. Don't change `appId`, the `HKCU\Software\QuantaFONS\BluInn` registry key or the `ProgramData\QuantaFONS` path casually: existing installs and licences depend on them |
| D2 | Coupling to the desktop build: `npm run dev:db`, `DEMO_BUILD` and `output: standalone` in `next.config.ts`, and `NEXT_PUBLIC_LOCAL_DEMO` in `LiveRefresh.tsx` | **Later.** Goes with D1. Replace `dev:db` with a plain local Postgres plus `db:migrate` |
| D3 | Two backends, Neon (`app/lib/neon/*`, chosen when `DATABASE_URL` is set) and Supabase (`app/lib/supabase/*`). Both are live today | **Later.** Standardise on Neon. Then drop `@supabase/ssr`, the realtime client, the Supabase half of `proxy.ts` and the `supabase_realtime` publication blocks. Keep `@supabase/postgrest-js` and the `SupabaseClient` type. Rename `app/lib/supabase/` to `app/lib/db/` |
| D4 | Three Supabase-shim SQL files: `db/platform.sql`, `desktop/sql/platform.sql`, `neon/tests/supabase_stub.sql` | **Later.** Point `neon/tests/run.sh` at `db/platform.sql`, and drop the desktop copy with D1 |
| D5 | Integration credentials set once per deployment in env vars: one Razorpay account, one email sender, one SMS number, one door-lock URL, one KOT URL, single shared secrets for room controls and attendance | **Later.** Fine while each customer gets its own deployment and database. For a shared SaaS, move them to per-property settings (encrypted) |
| D6 | The reports cron reads one property's timezone and uses it for every property's schedules | **Later.** Compute "today" per property, and run hourly if properties span timezones |
| D7 | The only CI workflow is the Windows demo build. Nothing runs lint, tests or a web build | **Later.** Add a CI workflow: `npm run lint`, `npm test`, `next build`, `neon/tests/run.sh` |
| D8 | 2FA defaulted to demo mode (every code is `123456`) when `TWO_FACTOR_MODE` was unset | **Later**, by decision: demo stays the default while BluInn is being demoed. Before the first real hotel goes live, make `totp` the default in `app/lib/two-factor.ts` (`isDemoTwoFactor`) |

## E. API routes

| Route | Verdict |
|---|---|
| `POST /api/room-controls` | **Done (bug fix).** Room numbers are unique only within a hotel, and the route updated every room with that number across the group. It now takes an optional `property` (the hotel code), and refuses with 409 when the number is ambiguous. **Later:** a secret per property |
| `POST /api/attendance` | Vendor-neutral, and employee codes are unique group-wide. Keep. **Later:** a secret per device or property |
| `POST /api/payments/razorpay/webhook` | Keep. Move it behind a gateway interface (C12) |
| `GET /api/storage/v1/object/...` | Keep signed links. Drop the public mode once `room-photos` is private (A11) |
| `/api/cron/{reports,maintenance,notifications}` | Keep. Fix D6 |

## F. Unused code removed

`validatePromoCode` (`revenue-actions.ts`), `getStaff` (`app/lib/auth.ts`), `isMultiProperty`
(`app/lib/properties.ts`), `runReportByKind` (`app/lib/report-data.ts`), `todayIso` and
`isoPlusDays` (`app/lib/dates.ts`), and `MANUAL_GUEST_TAGS`, `ROOM_STATUS_LABELS` and
`PRICING_ADJUSTMENT_STATUS_LABELS` (`app/lib/types.ts`). `fetchPaymentLink` is kept for payment
reconciliation.

---

## Features removed (November 2026)

| What | Notes |
|---|---|
| **Night audit** | **Reinstated the same month** (see [the PMS review](pms-review.md)). Restored from git with a pre-audit checklist (arrivals, overstays, open cash shifts, room discrepancies), a closed-day lock on folio lines (`0028`), and a guard against closing a date that has not started |
| **Corporate accounts** | Companies page, City ledger (Billing tab, statements, receivables report), company field on bookings, guests, groups and events, corporate rate plans, bill-to-company at check-out, folio and event, and the "Company bill" payment method. Invoices bill the guest; there is no GSTIN bill-to for a business guest any more |

Corporate accounts leave their tables (`companies`, `city_ledger_entries`, the `company_id` columns) and data untouched. The `companies.manage` and `folio.city_ledger` permissions are not shown on the Roles page (`HIDDEN_PERMISSIONS` in `app/lib/permissions.ts`), and saving a role no longer deletes them. `frontdesk.night_audit` is back on the Roles page.

## Rebrand, done in the same pass

- `PRODUCT` gained `descriptor`, `company` (Blu Margins) and `themeColor`. The top bar, drawer,
  sign-in panel, brand mark, viewport colour and email accents read from it.
- The setup notice uses the sign-in frame and says "BluInn is not configured". Previously it said
  "Reservations desk not configured", in real gold, because it sat outside `.admin-theme`.
- New branded `app/not-found.tsx`, `app/error.tsx` and `app/global-error.tsx`.
- Authenticator apps show **BluInn** as the issuer.
- Internal names: the `pms_2fa` cookie is now `bluinn_2fa` (anyone mid-way through the second step
  signs in once more), plus `bluinn:lastActivity` and `bluinn:open-menu`.
- All 245 legacy `yellow-*` accent classes became `brand-*`, with no visual change inside the app.
- "Powered by BluInn" (`components/PrintFooter.tsx`) at the foot of invoices, the folio,
  registration card, POS bill, KOT, quotation, contract and BEO. Staff emails
  (scheduled reports and staff alerts) are signed "Sent by BluInn". Guest emails carry the hotel
  alone.
- One hotel-name fallback: "Your Hotel".
