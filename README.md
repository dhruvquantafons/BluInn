# BluInn

**Hotel management, simplified.** BluInn is a property management system (PMS) by QuantaFONS. It
runs a hotel's day from one screen: reservations and the front desk, rooms and rates, revenue,
housekeeping, maintenance, outlets, banquets, billing, HR and reporting.

- **One hotel or a group.** It starts as a single property and grows into a group without a rebuild,
  with each hotel's data kept separate.
- **No hotel is baked in.** Each hotel's name, address, GSTIN, invoice series and message wording live in
  the database and are edited under **Settings**.
- **Built for India first.** GST invoicing and tax summaries, ₹ formatting, IST business dates,
  Razorpay payments and multi-currency settlement.
- **Staff only.** BluInn is the back office, served from the site root (`/`, `/login`, `/bookings`, …).
  It has no public guest-facing website; a hotel's own website is a separate project.

---

## Contents

1. [Features](#features)
2. [Quick start](#quick-start)
3. [Running BluInn](#running-bluinn): [Neon](#neon-recommended) · [Supabase](#supabase) · [Local, no cloud](#local-no-cloud) · [Windows desktop](#windows-desktop)
4. [Configuration](#configuration)
5. [Development](#development)
6. [Deployment](#deployment)
7. [Integrations](#integrations)
8. [Security](#security)
9. [Known gaps](#known-gaps)
10. [Further reading](#further-reading)

---

## Features

The app is organised into five sections, which match its top navigation.

| Section | What it covers |
|---|---|
| **Front Office** | Dashboard, front desk (check-in with ID capture, registration card and e-signature; check-out and express check-out), bookings (individual, group, corporate, split, waitlist, room moves), tape chart, guest profiles, loyalty, night audit |
| **Operations** | Room board, housekeeping (auto-assigned tasks, inspections, lost & found), maintenance (tickets, assets, preventive schedules, SLAs), point of sale (seven outlet types, KOT, charge to room), events & banquets (diary, quotations, contracts, event orders) |
| **Commercial** | Rates (plans, seasons, restrictions, channel allocation), revenue (dynamic pricing rules with approval, packages, promo codes, competitor rates), billing (folios, GST invoices, refunds, city ledger, currencies), companies, reports with scheduled email, notification log |
| **People** | HR (roster, attendance, leave, payroll export), staff accounts |
| **Admin** | Properties and group standards, roles and permissions, settings and message templates, an audit log that cannot be edited |

### Module status

Code comments refer to these module numbers ("Module 14").

| # | Module | Status |
|---|---|---|
| 1 | Reservations & booking engine | ✅ Done |
| 2 | Front desk (check-in / check-out) | ✅ Done |
| 3 | Rooms, rates & inventory | ✅ Done |
| 4 | Revenue & dynamic pricing | ✅ Done |
| 5 | Housekeeping | ✅ Done |
| 6 | Point of sale | ✅ Done |
| 7 | Billing, invoicing, folio & payments | ✅ Done |
| 8 | Guest CRM & loyalty | ✅ Done |
| 9 | Channel manager / OTAs | ⬜ Not started |
| 10 | Banquets & events | ✅ Done |
| 11 | Maintenance / engineering | ✅ Done |
| 12 | HR & staff | ✅ Done |
| 13 | Reporting & analytics | ✅ Done |
| 14 | Multi-property / multi-brand | ✅ Done |
| 15 | Roles, permissions & administration | ✅ Done |
| 16 | Notifications (email, SMS) | ✅ Done |
| 17 | Guest booking portal | ⬜ Not in BluInn: guest-facing (see [Known gaps](#known-gaps)) |
| 18 | Mobile apps | ⬜ Not started (staff screens work in a phone browser) |

**The channel manager (Module 9) is the biggest piece left.** Much of it waits on each hotel: the
Booking.com, Expedia and Agoda extranet accounts and their connectivity credentials have to exist before
the integration can be built or tested.

**Not built on purpose:** stock and recipe deduction in the outlets, GDS connectivity, WhatsApp and push
notifications, and paid competitor rate-shopping (competitor rates are entered by hand instead).

---

## Quick start

You need **Node.js 20+** and a Postgres database on [Neon](https://console.neon.tech) (the free plan is
enough to try it).

```bash
npm install
cp .env.example .env.local        # set DATABASE_URL, DATABASE_URL_UNPOOLED and AUTH_SECRET
npm run db:migrate                # creates the schema
npm run db:create-admin -- you@hotel.com 'A-Strong-Password' "Your Name"
npm run dev
```

Open <http://localhost:3000> and sign in with that account. While `TWO_FACTOR_MODE=demo`, the
second-step code is `123456`.

Then, in the app:
1. **Settings:** enter the hotel's name, legal name, address, GSTIN, phone and email. Every invoice,
   folio, registration card and guest email reads them from there.
2. **Rates:** edit or replace the two sample room types.
3. **Rooms:** add the hotel's rooms.
4. **Staff:** create a login for each colleague.

No cloud account yet? Use the [local stack](#local-no-cloud) instead.

**Stack:** Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4 and PostgreSQL, deployed on
Vercel.

> This Next.js version differs from older ones. Read the guide in `node_modules/next/dist/docs/` before
> changing framework code (see `AGENTS.md`).

---

## Running BluInn

The same code and the same schema run in four setups. The app picks its backend from the environment:
**`DATABASE_URL` set means Neon**; otherwise it looks for Supabase settings.

| Setup | Use it for | Database | Sign-in, files |
|---|---|---|---|
| [Neon](#neon-recommended) | Production and staging (recommended) | Neon Postgres | Provided by the app (`app/lib/neon/`) |
| [Supabase](#supabase) | Hosting on Supabase instead | Supabase Postgres | Supabase Auth and Storage |
| [Local, no cloud](#local-no-cloud) | Trying it out and development without an account | PostgreSQL on your machine | Bundled Supabase Auth and a local gateway |
| [Windows desktop](#windows-desktop) | An offline install on one PC | Bundled PostgreSQL | Bundled, as above |

Whichever you choose, **each hotel group gets its own database.** Never share one with another product or
with a hotel's website.

### Neon (recommended)

1. **Create a project** at [console.neon.tech](https://console.neon.tech) in the region nearest the hotel
   (for India: AWS Singapore `ap-southeast-1`, or Mumbai). Under **Connect** there are two connection
   strings for the `neondb_owner` role. Its password starts with `npg_` and is **not** your Neon account
   password.

   | Variable | Which string | Used by |
   |---|---|---|
   | `DATABASE_URL` | **Pooled** (host contains `-pooler`) | The app, locally and on Vercel |
   | `DATABASE_URL_UNPOOLED` | **Direct** (pooling off) | `npm run db:migrate` and `db:create-admin` |

   Write `sslmode=verify-full` rather than `sslmode=require` in both. The driver treats them the same,
   and `verify-full` stops a warning on every connection.

   ```bash
   DATABASE_URL="postgresql://neondb_owner:npg_…@ep-xxxx-pooler.<region>.aws.neon.tech/neondb?sslmode=verify-full&channel_binding=require"
   DATABASE_URL_UNPOOLED="postgresql://neondb_owner:npg_…@ep-xxxx.<region>.aws.neon.tech/neondb?sslmode=verify-full&channel_binding=require"
   AUTH_SECRET="…"   # openssl rand -base64 48
   ```

   Leave the Supabase variables, `DEMO_BUILD` and `NEXT_PUBLIC_LOCAL_DEMO` unset.

2. **Apply the schema and create the first administrator:**

   ```bash
   npm run db:migrate
   npm run db:create-admin -- you@hotel.com 'A-Strong-Password' "Your Name"
   ```

   `db:migrate` applies `db/platform.sql`, then each file in `supabase/migrations/` that hasn't been
   applied yet, each in its own transaction. It records them in `bluinn_meta.migrations`, so running it
   again applies only what is new; a fresh database ends with "Applied 25 migration(s)".
   `db:create-admin` works only while the staff list is empty. Everyone after the first administrator is
   added from **Staff** in the app.

**How BluInn runs on plain Postgres.** The schema was written for Supabase, so on Neon the app provides
the pieces Supabase's servers would. The queries, row-level security policies and storage policies run
unchanged:

| Supabase piece | On Neon |
|---|---|
| Roles, `auth` and `storage` schemas | `db/platform.sql` creates `anon`, `authenticated`, `service_role`, `auth.users`, `auth.uid()`, `storage.objects`, … under the same names |
| PostgREST (`.from()`, `.rpc()`) | `app/lib/neon/rest.ts` turns the same requests into SQL, run as `authenticated` with the signed-in user's claims, so RLS decides exactly as before |
| Auth (passwords, sessions, TOTP) | `app/lib/neon/auth.ts`: scrypt password hashes, rows in `auth.sessions` and `auth.mfa_factors`, and a signed httpOnly cookie |
| Storage buckets | `app/lib/neon/storage.ts`: file bytes in `storage.objects`, served by `/api/storage/v1/object/…`, with signed, expiring links for private buckets |
| Realtime | Not available: pages that update live refresh every 15 seconds instead |

### Supabase

Without `DATABASE_URL`, BluInn uses Supabase.

1. Create a project at [supabase.com/dashboard](https://supabase.com/dashboard).
2. In the **SQL editor**, run each file in `supabase/migrations/` **in order**, one at a time.
3. Copy the project URL, anon key and service role key (**Project Settings → API**) into `.env.local`
   as `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY`.
4. Add the first user under **Authentication → Users**, with "Auto Confirm User" ticked. The first
   account becomes the administrator.

On Supabase, pages update live through Supabase Realtime.

### Local, no cloud

`npm run dev:db` runs a Supabase-compatible backend on your own machine, with **no Docker and no
account**: PostgreSQL, Supabase Auth, PostgREST and a small storage gateway. These are the same pieces the
Windows desktop build bundles. It suits trying BluInn out, and development.

You need PostgreSQL installed locally (on macOS it looks in `/Library/PostgreSQL/18`, or set `PG_HOME`),
plus **Go** for the one-time build of Supabase Auth.

```bash
cd desktop && npm install --ignore-scripts && node scripts/stage-runtime.mjs && cd ..   # once
npm run dev:db       # terminal 1: leave it running
npm run dev          # terminal 2
```

On first start it applies every migration, creates a demo hotel ("BluInn Demo Hotel", with 8 rooms) and
a demo administrator:

| Email | Password | 2FA code |
|---|---|---|
| `admin@bluinn.local` | `BluInn#Demo2026` | `123456` |

It also points `.env.local` at the local backend (`http://127.0.0.1:54321`), so **don't use it alongside
Neon**: remove `DATABASE_URL`, or keep a separate `.env.local`. Data is kept in `desktop/.devdata`;
delete that folder to start again from an empty database.

### Windows desktop

An installer (`BluInn-Setup-<version>.exe`) that runs the whole of BluInn on one Windows PC, with
nothing to host and nothing for the hotel to set up. It bundles PostgreSQL, Supabase Auth and PostgREST,
and has a 10-day trial followed by activation keys issued by QuantaFONS. It is built on GitHub Actions
(Windows runners) from the `exe-compile` branch. See [`desktop/README.md`](desktop/README.md) for
building, licensing and support.

---

## Configuration

Set variables in `.env.local` locally, and under **Vercel → Settings → Environment Variables** for
Production and Preview. `.env.example` lists every one, with notes.

| Variable | Needed | Purpose |
|---|---|---|
| `DATABASE_URL` | **Neon** | Pooled Neon connection string. Selects the Neon backend |
| `DATABASE_URL_UNPOOLED` | Neon scripts | Direct connection string, for `db:migrate` and `db:create-admin` |
| `AUTH_SECRET` | **Neon** | 32+ random characters. Signs session cookies, file links and the demo 2FA cookie. Changing it signs everyone out |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | **Supabase** | Supabase project URL and public key |
| `SUPABASE_SERVICE_ROLE_KEY` | **Supabase** | Server-only key for nightly jobs, webhooks, staff accounts and sign-in lockout. Never expose it to the browser |
| `NEXT_PUBLIC_APP_URL` | Off Vercel | Where this deployment answers, for links emailed to staff. On Vercel it defaults to the production domain |
| `TWO_FACTOR_MODE` | Before go-live | `demo` (every code is `DEMO_2FA_CODE`, default `123456`) or `totp` (real authenticator apps) |
| `RESEND_API_KEY`, `NOTIFY_FROM_EMAIL` | Optional | Guest and staff email, sent under the hotel's name |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Optional | SMS |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Optional | Online payment links, and the signed webhook that credits the folio |
| `CRON_SECRET` | Optional | The scheduled jobs: maintenance escalations, emailed reports, timed guest messages |
| `DOOR_LOCK_WEBHOOK_URL`, `DOOR_LOCK_API_KEY` | Optional | Electronic key cards |
| `ROOM_CONTROLS_SECRET` | Optional | Do Not Disturb from in-room controls |
| `ATTENDANCE_API_SECRET` | Optional | Biometric attendance devices |
| `KOT_WEBHOOK_URL`, `KOT_API_KEY` | Optional | Kitchen display for outlet order tickets |

Every optional integration switches off cleanly when its keys are missing. Email, SMS and key-card
attempts are still logged as "not configured", so nothing fails silently.

`DATABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL` are also read **at build time** (`next.config.ts`): the
first switches live updates to polling, and the second allows Supabase Storage images. Redeploy after
changing either.

---

## Development

```bash
npm run dev               # development server, http://localhost:3000
npm run build             # production build
npm start                 # serve the production build
npm run lint              # ESLint
npm test                  # unit tests
npm run db:migrate        # apply new migrations (Neon)
npm run db:create-admin   # first administrator on an empty database (Neon)
npm run dev:db            # local backend, no Docker (see above)
```

### Tests

- **Unit tests** (`npm test`, `tests/`): pricing, tax and penalties, room assignment, password policy,
  HR, message templates, invoices, city-ledger ageing, currency conversion, loyalty points, POS lines and
  charge-to-room rules, hotel KPIs, report periods, pricing rules and promo codes.
- **Database behaviour tests** (`supabase/tests/`): apply every migration to a throwaway Postgres and
  check what only a real database can, which is row-level security, `SECURITY DEFINER` functions and
  trigger order. They cover overbooking, permissions, invoice immutability, refund approval, credit
  limits, loyalty, the POS bill lifecycle, report access and property isolation. **These are the tests
  that matter most.** They have caught a privilege escalation and nightly jobs that would have acted on
  every hotel in a group at once.

  ```bash
  PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres supabase/tests/run.sh   # needs a Postgres 15+ superuser
  ```

  Lines marked `EXPECT` are deliberate refusals, not failures. What you are checking is that the set of
  refusals hasn't changed.
- **Neon backend test** (`tests/neon.integration.test.ts`): sign-in, sessions, TOTP, the query
  translator, RLS and storage, end to end. It is skipped unless pointed at a throwaway database that
  `db:migrate` has been run against (never production):

  ```bash
  NEON_TEST_DATABASE_URL=postgres://… npx vitest run tests/neon.integration.test.ts
  ```

### Project structure

```
proxy.ts                   Session refresh and sign-in guard for every page
db/platform.sql            Roles, auth and storage schemas for Neon (applied before the migrations)
supabase/migrations/       The database schema, security policies and triggers, in order
supabase/tests/            Database behaviour tests
scripts/                   db-migrate.mjs, db-create-admin.mjs (Neon)
tests/                     Unit and Neon integration tests
docs/                      How it works, go-live checklist
desktop/                   Windows desktop build, and the local stack behind `npm run dev:db`

app/
├── layout.tsx             Root layout: BluInn metadata, Inter
├── api/                   Integration endpoints, and storage/ (files on Neon)
├── lib/                   Business logic: auth, permissions, pricing, tax, dates, folio, invoices,
│                          loyalty, POS, events, reports, revenue, notifications, properties, …
├── lib/neon/              The Neon backend: query translator, auth, sessions, TOTP, storage
└── (bluinn)/              The app. A route group, so it adds nothing to the URL
    ├── *-actions.ts       Server actions, one file per area
    ├── components/        App shell (top bar, sidebar), BrandMark and the ui.tsx primitives
    ├── DESIGN.md          Design system: theme tokens, layout, components
    ├── login/, security/  Sign-in (/login), 2FA and password (/security)
    └── (protected)/       Every signed-in page: dashboard (/), front-desk, bookings, guests,
                           groups, tape-chart, night-audit, rooms, housekeeping, maintenance, pos,
                           events, rates, revenue, billing, companies, reports, notifications,
                           hr, staff, properties, roles, settings, audit
```

### Database schema

| Migration | What it adds |
|---|---|
| `0001_init.sql` | Base schema, security policies, two sample room types |
| `0002_room_photos.sql` | Room photo storage |
| `0003_room_status_and_staff.sql` | Room occupancy, staff details |
| `0004_staff_roles.sql` | Manager and housekeeping roles |
| `0005_foundation.sql` | Roles & permissions, settings, audit log, sign-in tracking |
| `0006_rooms_and_rates.sql` | Room blocks, rate plans, seasons, restrictions, channel allocation, companies |
| `0007_reservations.sql` | Booking statuses, groups, room moves, folio, guest IDs, overbooking guard |
| `0008_front_desk.sql` | Registration cards, ID scans, guest requests, key cards, night audit, message log |
| `0009_housekeeping.sql` | Cleaning tasks, zones, checklist, inspections, DND, lost & found |
| `0010_housekeeping_sow_scope.sql` | Trims housekeeping to its final scope |
| `0011_maintenance.sql` | Tickets, photos, assets, preventive schedules, resolution targets |
| `0012_hr.sql` | HR profiles, shifts, roster, attendance, leave |
| `0013_guest_crm_and_admin.sql` | Guest profiles, feedback, merge & erase; message templates, languages, sessions |
| `0014_billing.sql` | Split folios, GST invoice numbering, gateway payments, refund approval |
| `0015_city_ledger_and_currency.sql` | City ledger (corporate A/R), exchange rates, foreign-currency settlement |
| `0016_loyalty.sql` | Loyalty tiers, points lots, redemption, expiry, tier history |
| `0017_pos.sql` | Outlets, menus, modifiers, bills, split/merge, charge to room, KOT |
| `0018_reports.sql` | Permission-checked report functions, KPI sources, scheduled reports |
| `0019_events.sql` | Event spaces, seating plans, per-head catering, quotations, approval, event billing |
| `0020_revenue.sql` | Pricing rules, approval queue, competitor rates, packages, promo codes |
| `0021_guest_portal.sql` | Guest accounts and self-service functions, for a future guest-facing app |
| `0022_notifications.sql` | Pre-arrival, check-in, post-stay and receipt templates; notification log |
| `0023_guest_password_login.sql` | Password sign-in for guest accounts |
| `0024_multi_property.sql` | Properties, per-property isolation, group settings, central dashboard |
| `0025_event_tax_in_gst_return.sql` | Event bills in the GST tax summary |

New schema changes go in a new numbered file; never edit one that has been applied to a live database.
Migrations upgrade a database in place and keep its data. Back up before applying `0024` to a database
that already holds data: it renames `property_settings` to `properties` and adds `property_id` to about
70 tables.

---

## Deployment

BluInn deploys to **Vercel** from `master`, against Neon. Every pull request gets its own preview.

### First deployment

1. Set up the database as in [Neon](#neon-recommended): `db:migrate`, then `db:create-admin`.
2. In Vercel, **Add New → Project** and import the repository. Next.js is detected; keep the default
   build settings.
3. Under **Settings → Environment Variables** (Production and Preview):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | The **pooled** Neon string. `DATABASE_URL_UNPOOLED` isn't needed on Vercel |
   | `AUTH_SECRET` | A new `openssl rand -base64 48`, different from any `.env.local` |
   | `CRON_SECRET` | Another `openssl rand -base64 48` |
   | `TWO_FACTOR_MODE` | `demo` while setting up, `totp` before real guest data goes in |
   | Optional | Email, SMS, Razorpay, door locks… (see [Configuration](#configuration)) |

   Don't set `NEXT_PUBLIC_SUPABASE_*`, `SUPABASE_SERVICE_ROLE_KEY`, `DEMO_BUILD` or
   `NEXT_PUBLIC_LOCAL_DEMO`. `DEMO_BUILD=1` builds the desktop version.
4. Under **Settings → Functions → Function Region**, pick the region nearest the database (Singapore
   `sin1` for `ap-southeast-1`), then redeploy. Every page makes several queries, so the distance shows
   on every click.
5. Sign in, fill in **Settings**, and work through the [go-live checklist](docs/go-live-checklist.md).

### Every change after that

1. Run new migrations with `npm run db:migrate` **before** merging the code that needs them.
2. Check the pull request's Vercel preview.
3. Merge to `master`; production deploys automatically.

### Scheduled jobs

Declared in `vercel.json`, and all need `CRON_SECRET`, which Vercel sends as a bearer token:

| Job | Schedule (UTC) | Does |
|---|---|---|
| `/api/cron/reports` | 02:00 daily (07:30 IST) | Emails the scheduled reports |
| `/api/cron/maintenance` | 02:30 daily | Escalates overdue tickets, raises preventive work |
| `/api/cron/notifications` | 03:00 daily | Pre-arrival, check-in and post-stay messages; VIP arrival alerts |

They walk every active property in the group. Vercel Cron runs only on production deployments; to test
one on a preview, call it yourself with the bearer token. On the Pro plan, the maintenance sweep can be
tightened to `*/30 * * * *`. The Hobby plan caps the number of cron jobs; if it refuses three, merge
them into one endpoint rather than dropping one.

---

## Integrations

| Endpoint | Used by | Auth |
|---|---|---|
| `POST /api/room-controls` | In-room controls (Do Not Disturb) | `Bearer ROOM_CONTROLS_SECRET` |
| `POST /api/attendance` | Biometric attendance devices | `Bearer ATTENDANCE_API_SECRET` |
| `GET /api/cron/maintenance`, `/reports`, `/notifications` | Scheduler (Vercel Cron) | `Bearer CRON_SECRET` |
| `POST /api/payments/razorpay/webhook` | Razorpay | `X-Razorpay-Signature` (HMAC, `RAZORPAY_WEBHOOK_SECRET`) |
| `GET /api/storage/v1/object/public/<bucket>/<path>` | Room photos (Neon) | None: public buckets only |
| `GET /api/storage/v1/object/sign/<bucket>/<path>?token=…` | ID scans, signatures, maintenance photos (Neon) | Signed, expiring link (`AUTH_SECRET`) |

Each endpoint stays off until its secret is set. Request formats are documented at the top of each route
file. Online payments use Razorpay payment links, so no card details ever reach BluInn, and a folio is
credited only when the signed webhook confirms payment.

---

## Security

Every request passes three checks:

1. **`proxy.ts`** sends signed-out visitors to `/login`.
2. **Every page and server action** checks the specific permission (`requirePermission`).
3. **Row-level security** in the database checks it again, as the final safeguard. This holds on Neon
   too: each signed-in query runs as `authenticated`, with the user's id in `auth.uid()`.

With more than one hotel, a **restrictive** policy on every table also holds reads and writes to the
property the person is working in. A page that forgets to filter shows too little, never too much.

Also built in:
- **Two-factor sign-in** for administrator and finance roles, and optional for everyone else.
- **Password rules:** complexity, expiry, and lockout after repeated failures.
- **Sign-out after inactivity**, and an administrator can end someone's sessions.
- **Private ID scans:** only authorised roles can view them, every view is logged, and scans are deleted
  after the retention period.
- **An audit log** with before and after values, which nobody can edit or delete.
- **Not indexed:** `robots.txt` disallows everything.

The full model, and the traps to know before changing database code, is in
[docs/how-it-works.md](docs/how-it-works.md#security-model).

---

## Known gaps

1. **No guest-facing pages.** There's no public booking engine, guest portal or online feedback form.
   The database keeps the guest-account functions (`0021`, `0023`) for a future guest app. Until then,
   bookings from a hotel's website are entered by the desk with the source *website*.
2. **No channel manager yet** (Module 9). Per-channel room allocations are stored but not enforced.
3. **No expense ledger.** GOPPAR uses a monthly operating cost entered under **Settings**.
4. **No stock tracking in the outlets.** Recipe and ingredient deduction isn't built.
5. **Cash outlet bills are missing from the GST tax summary.** The summary reads folio charges and event
   bills, and an outlet bill settled in cash never touches a folio. Night audit totals outlet takings
   separately. Fix this before the first GST return is filed from BluInn.
6. **Guest profiles are per property.** A guest who stays at two hotels in a group has a profile at each.
   Loyalty rules are shared from head office; points are earned per property.
7. **English only.** Other languages apply to guest messages, not the app.
8. **Event equipment isn't held against a date.** How many of each item the hotel owns is shown when
   quoting; with one hall, two functions can't overlap anyway, so there's no clash check.
9. **On Neon, nothing updates live.** The dashboard, front desk and housekeeping boards refresh every 15
   seconds while on screen.
10. **On Neon, files live in the database.** Room photos, ID scans and maintenance photos count towards the
    Neon plan's storage (0.5 GB on the free plan).
11. **Uploads over 4.5 MB fail on Vercel.** The app allows 5 MB images, but a Vercel function accepts at
    most 4.5 MB per request.

---

## Further reading

- [docs/how-it-works.md](docs/how-it-works.md): the rules each area enforces and why (reservations,
  billing, revenue, multi-property, POS, events, loyalty, reports, the security model).
- [docs/go-live-checklist.md](docs/go-live-checklist.md): what to set up and confirm for each hotel
  before going live.
- [app/(bluinn)/DESIGN.md](app/%28bluinn%29/DESIGN.md): the design system, for building or changing a page.
- [desktop/README.md](desktop/README.md): the Windows desktop build, licensing and support.
