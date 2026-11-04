# BluInn

**Hotel management, simplified.**

BluInn is a cloud property management system (PMS) for hotels, built and sold by **Blu Margins**. A hotel
runs its whole day from one screen: reservations and the front desk, rooms and rates, housekeeping and
maintenance, restaurants and outlets, banquets, billing, staff and reporting.

- **For any hotel.** Nothing about a particular hotel is built in. Each customer's name, address, GSTIN,
  tax slabs, invoice series, policies and message wording live in their own database and are edited in
  the app under **Settings**.
- **One hotel or a group.** A customer starts with one property and can add more later without
  rebuilding anything. Each property's data stays separate, and head office can push shared standards
  down to every hotel.
- **Built for India first.** GST invoices and tax summaries, ₹ amounts, Indian ID types, Razorpay payment
  links, and payments taken in foreign currencies.
- **For hotel staff.** BluInn is the hotel's back office. It has no public website or guest portal;
  guests receive emails and SMS from the hotel.

---

## Contents

1. [What BluInn does](#what-bluinn-does)
2. [How BluInn is delivered](#how-bluinn-is-delivered)
3. [Quick start for developers](#quick-start-for-developers)
4. [Onboarding a new hotel](#onboarding-a-new-hotel)
5. [Configuration](#configuration)
6. [Development](#development)
7. [Deployment](#deployment)
8. [Integrations](#integrations)
9. [Security](#security)
10. [Roadmap and known limitations](#roadmap-and-known-limitations)
11. [Further reading](#further-reading)

---

## What BluInn does

The app has five sections, matching its top navigation.

| Section | Pages | What staff do there |
|---|---|---|
| **Front Office** | Dashboard, Front desk, Bookings, Guests, Groups, Tape chart | Take individual, group and split bookings, manage the waitlist and room moves. Check guests in with ID capture, a registration card and an e-signature, and check them out (with an emailed bill). Keep guest profiles and the loyalty programme |
| **Operations** | Rooms, Housekeeping, Maintenance, Point of sale, Events & banquets | Run the room board. Assign and inspect cleaning tasks, and log lost & found. Raise maintenance tickets with targets, track assets and schedule preventive work. Sell in seven outlet types with kitchen tickets and charge to room. Sell events with a diary, quotations, contracts and banquet event orders |
| **Commercial** | Rates, Revenue, Billing, Reports, Notifications | Set rate plans, seasons, restrictions and channel allocations. Run dynamic pricing rules (with approval), packages, promo codes and competitor rates. Issue GST invoices, approve refunds and keep exchange rates. Run operational and financial reports, build custom ones and email them on a schedule. Read the notification log |
| **People** | HR & attendance, Staff | Rosters, clock-in and attendance, leave, payroll export, and staff accounts |
| **Admin** | Properties, Roles, Settings, Audit log | Run a group of hotels and push standards to it. Edit roles and permissions, property settings and message templates. Read an audit log that nobody can edit |

Every printed document (invoices, folio, registration card, POS bill, kitchen ticket, quotation,
contract, banquet event order) carries the hotel's own name and details, with a small "Powered by BluInn"
line at the foot.

### Modules

Code comments refer to these module numbers ("Module 14").

| # | Module | Status |
|---|---|---|
| 1 | Reservations | ✅ |
| 2 | Front desk (check-in, check-out) | ✅ |
| 3 | Rooms, rates & inventory | ✅ |
| 4 | Revenue & dynamic pricing | ✅ |
| 5 | Housekeeping | ✅ |
| 6 | Point of sale | ✅ |
| 7 | Billing, invoicing, folios & payments | ✅ |
| 8 | Guest CRM & loyalty | ✅ |
| 9 | Channel manager (OTAs) | ⬜ Planned |
| 10 | Banquets & events | ✅ |
| 11 | Maintenance & engineering | ✅ |
| 12 | HR & staff | ✅ |
| 13 | Reporting & analytics | ✅ |
| 14 | Multi-property | ✅ |
| 15 | Roles, permissions & administration | ✅ |
| 16 | Notifications (email, SMS) | ✅ |
| 17 | Guest booking engine | ⬜ Planned |
| 18 | Mobile apps | ⬜ Planned (staff screens already work in a phone browser) |

---

## How BluInn is delivered

**Each customer (a hotel, or a hotel group) gets its own deployment and its own database.** No database is
shared between customers, so one hotel's data can never reach another, and each customer's integrations
(Razorpay, email, SMS, door locks) are set on their own deployment.

The same code and schema run in four setups. The app picks its backend from the environment:
**`DATABASE_URL` set means Neon**; otherwise it looks for Supabase settings.

| Setup | Use it for | Database | Sign-in and files |
|---|---|---|---|
| **Neon + Vercel** | Customers in production, and staging (the standard setup) | Neon Postgres | Built into the app (`app/lib/neon/`) |
| **Supabase** | A customer hosted on Supabase instead | Supabase Postgres | Supabase Auth and Storage |
| **Local stack** | Development and trying BluInn without a cloud account | PostgreSQL on your machine | Bundled Supabase Auth and a local gateway |
| **Windows desktop** | Sales demos on one PC, offline | Bundled PostgreSQL | Bundled, as above |

**Stack:** Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4 and PostgreSQL, hosted on Vercel.

> This Next.js version differs from older ones. Read the guide in `node_modules/next/dist/docs/` before
> changing framework code (see `AGENTS.md`).

### How BluInn runs on plain Postgres

The schema uses Supabase conventions (roles, `auth.uid()`, row-level security, storage buckets). On Neon
the app supplies those pieces itself, so the same queries and security policies run unchanged:

| Piece | On Neon |
|---|---|
| Roles, `auth` and `storage` schemas | `db/platform.sql` creates `anon`, `authenticated`, `service_role`, `auth.users`, `auth.uid()`, `storage.objects`, … |
| Queries (`.from()`, `.rpc()`) | `app/lib/neon/rest.ts` turns them into SQL, run as `authenticated` with the signed-in user's claims, so row-level security decides |
| Sign-in, sessions, 2FA | `app/lib/neon/auth.ts`: scrypt password hashes, `auth.sessions`, `auth.mfa_factors`, and a signed httpOnly cookie |
| File storage | `app/lib/neon/storage.ts`: files in `storage.objects`, served by `/api/storage/v1/object/…` with signed, expiring links |
| Live updates | Not available: live pages refresh every 15 seconds instead |

---

## Quick start for developers

You need **Node.js 20+** and a Postgres database on [Neon](https://console.neon.tech) (the free plan is
enough).

```bash
npm install
cp .env.example .env.local        # set DATABASE_URL, DATABASE_URL_UNPOOLED and AUTH_SECRET
npm run db:migrate                # creates the schema
npm run db:create-admin -- you@example.com 'A-Strong-Password' "Your Name"
npm run dev
```

Open <http://localhost:3000> and sign in. While `TWO_FACTOR_MODE=demo`, the second-step code is `123456`.

### Without a cloud account

`npm run dev:db` runs a Supabase-compatible backend on your own machine, with **no Docker and no account**:
PostgreSQL, Supabase Auth, PostgREST and a small storage gateway. You need PostgreSQL installed (on macOS it
looks in `/Library/PostgreSQL/18`, or set `PG_HOME`), plus **Go** for the one-time build of Supabase Auth.

```bash
cd desktop && npm install --ignore-scripts && node scripts/stage-runtime.mjs && cd ..   # once
npm run dev:db       # terminal 1: leave it running
npm run dev          # terminal 2
```

On first start it applies every migration and creates a demo hotel with 8 rooms and a demo administrator:

| Email | Password | 2FA code |
|---|---|---|
| `admin@bluinn.local` | `BluInn#Demo2026` | `123456` |

It points `.env.local` at the local backend (`http://127.0.0.1:54321`), so don't run it alongside Neon:
remove `DATABASE_URL` or keep a separate `.env.local`. Data lives in `desktop/.devdata`; delete that folder
to start again.

---

## Onboarding a new hotel

### 1. Create the customer's database

Create a Neon project at [console.neon.tech](https://console.neon.tech) in the region nearest the hotel
(for India: AWS Singapore `ap-southeast-1`, or Mumbai). Under **Connect** there are two connection strings
for the `neondb_owner` role. Its password starts with `npg_` and is **not** your Neon account password.

| Variable | Which string | Used by |
|---|---|---|
| `DATABASE_URL` | **Pooled** (host contains `-pooler`) | The app, locally and on Vercel |
| `DATABASE_URL_UNPOOLED` | **Direct** (pooling off) | `npm run db:migrate` and `db:create-admin` |

Use `sslmode=verify-full` in both. The driver treats it like `require`, and it stops a warning on every
connection.

```bash
DATABASE_URL="postgresql://neondb_owner:npg_…@ep-xxxx-pooler.<region>.aws.neon.tech/neondb?sslmode=verify-full&channel_binding=require"
DATABASE_URL_UNPOOLED="postgresql://neondb_owner:npg_…@ep-xxxx.<region>.aws.neon.tech/neondb?sslmode=verify-full&channel_binding=require"
AUTH_SECRET="…"   # openssl rand -base64 48
```

### 2. Apply the schema and create the hotel's first administrator

```bash
npm run db:migrate
npm run db:create-admin -- gm@hotel.com 'A-Strong-Password' "Their Name"
```

`db:migrate` applies `db/platform.sql`, then every file in `neon/migrations/` not yet applied, each in its
own transaction, and records them in `bluinn_meta.migrations`. Running it again applies only what is new.
`db:create-admin` works only while the staff list is empty; everyone else is added from **Staff** in the
app.

### 3. Deploy

Create the customer's Vercel project and environment variables as described in [Deployment](#deployment).

### 4. Set the hotel up in BluInn

Sign in as that administrator, then:

1. **Settings:** hotel name, legal name, address, GSTIN, phone, email, timezone, check-in and check-out
   times, tax slabs, invoice prefix and policies. Every invoice, folio, registration card and guest
   message reads them from here.
2. **Rates:** replace the sample room types and rate plan with the hotel's own.
3. **Rooms:** add every room.
4. **Point of sale, Events, Housekeeping, HR:** close the outlets the hotel doesn't run, set up its
   function spaces and packages, its cleaning checklist, departments and shifts.
5. **Roles and Staff:** adjust the twelve built-in roles if needed, then create a login for each
   colleague.
6. **Settings → Templates:** word the guest emails and SMS in the hotel's voice and languages.
7. Work through the [go-live checklist](docs/go-live-checklist.md), including switching to real two-factor
   sign-in (`TWO_FACTOR_MODE=totp`) before real guest data goes in.

A second hotel in the same group is added under **Admin → Properties**, not as a new deployment.

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
| `SUPABASE_SERVICE_ROLE_KEY` | **Supabase** | Server-only key for scheduled jobs, webhooks, staff accounts and sign-in lockout. Never expose it to the browser |
| `NEXT_PUBLIC_APP_URL` | Off Vercel | The deployment's address, for links in staff emails. On Vercel it defaults to the production domain |
| `TWO_FACTOR_MODE` | Before go-live | `demo` (the current default: every code is `DEMO_2FA_CODE`, `123456` unless set) or `totp` (real authenticator apps) |
| `RESEND_API_KEY`, `NOTIFY_FROM_EMAIL` | Optional | Guest and staff email, sent under the hotel's name |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM_NUMBER` | Optional | SMS |
| `RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` | Optional | Online payment links, and the signed webhook that credits the folio |
| `CRON_SECRET` | Optional | The scheduled jobs: maintenance escalations, emailed reports, timed guest messages |
| `DOOR_LOCK_WEBHOOK_URL`, `DOOR_LOCK_API_KEY` | Optional | Electronic key cards |
| `ROOM_CONTROLS_SECRET` | Optional | Do Not Disturb from in-room controls |
| `ATTENDANCE_API_SECRET` | Optional | Biometric attendance devices |
| `KOT_WEBHOOK_URL`, `KOT_API_KEY` | Optional | Kitchen display for outlet order tickets |

Every optional integration switches off cleanly when its keys are missing. Email, SMS and key-card attempts
are still logged as "not configured", so nothing fails silently.

`DATABASE_URL` and `NEXT_PUBLIC_SUPABASE_URL` are also read **at build time** (`next.config.ts`): the first
switches live updates to polling, the second allows Supabase Storage images. Redeploy after changing either.

Product identity (name, tagline, company, brand colour) lives in `app/lib/app-config.ts`. Never type the
product name into a page.

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
npm run dev:db            # local backend, no Docker
```

### Project structure

```
proxy.ts                   Session refresh and sign-in guard for every page
db/platform.sql            Roles, auth and storage schemas for Neon (applied before the migrations)
neon/migrations/           The database schema, security policies and triggers, in order
neon/tests/                Database behaviour tests
scripts/                   db-migrate.mjs, db-create-admin.mjs, licence key tools
tests/                     Unit tests and the Neon integration test
docs/                      How it works, go-live checklist
desktop/                   Windows desktop build, and the local stack behind `npm run dev:db`

app/
├── layout.tsx             Root layout and metadata
├── not-found.tsx, error.tsx, global-error.tsx   Branded fallback screens
├── api/                   Integration endpoints, scheduled jobs, and storage/ (files on Neon)
├── lib/                   Business logic: auth, permissions, pricing, tax, dates, folios, invoices,
│                          loyalty, POS, events, reports, revenue, notifications, properties, …
├── lib/neon/              The Neon backend: query translator, auth, sessions, TOTP, storage
└── (bluinn)/              The app. A route group, so it adds nothing to the URL
    ├── *-actions.ts       Server actions, one file per area
    ├── components/        App shell (top bar, sidebar, status strip), BrandMark, PrintFooter, ui.tsx
    ├── DESIGN.md          The design system: theme tokens, layout, components
    ├── login/, security/  Sign-in (/login), 2FA and password (/security)
    └── (protected)/       Every signed-in page: dashboard (/), front-desk, bookings, guests,
                           groups, tape-chart, rooms, housekeeping, maintenance, pos, events,
                           rates, revenue, billing, reports, notifications, hr, staff,
                           properties, roles, settings, audit
```

### Database changes

Migrations live in `neon/migrations/` and are applied in name order. **Add a new numbered file for every
change; never edit one that has been applied to a customer's database.** Migrations upgrade a database in
place and keep its data. Apply them to every customer's database with `npm run db:migrate` before
deploying the code that needs them.

Some tables are kept for data but are no longer used by the app: `night_audits`, `companies`,
`city_ledger_entries`, and the `company_id` columns. Leave them alone unless you are removing them on
purpose in a new migration. [docs/client-era-audit.md](docs/client-era-audit.md) lists these and other
clean-up candidates.

### Tests

- **Unit tests** (`npm test`, `tests/`): pricing, tax and penalties, room assignment, password policy, HR,
  message templates, invoices, currency conversion, loyalty points, POS lines and charge-to-room rules,
  hotel KPIs, report periods, pricing rules and promo codes.
- **Database behaviour tests** (`neon/tests/`): apply every migration to a throwaway Postgres and check
  what only a real database can, which is row-level security, `SECURITY DEFINER` functions and trigger
  order. They cover overbooking, permissions, staff-only access, invoice immutability, refund approval,
  loyalty, the POS bill lifecycle, report access and property isolation. **These matter most**: they have
  caught a privilege escalation, and scheduled jobs that would have acted on every hotel in a group at
  once.

  ```bash
  PGHOST=127.0.0.1 PGPORT=5432 PGUSER=postgres neon/tests/run.sh   # needs a Postgres 15+ superuser
  ```

  Lines marked `EXPECT` are deliberate refusals, not failures. Check that the set of refusals hasn't
  changed.
- **Neon backend test** (`tests/neon.integration.test.ts`): sign-in, sessions, TOTP, the query translator,
  row-level security and storage, end to end. It is skipped unless pointed at a throwaway database that
  `db:migrate` has been run against (never a customer's):

  ```bash
  NEON_TEST_DATABASE_URL=postgres://… npx vitest run tests/neon.integration.test.ts
  ```

---

## Deployment

Each customer deployment is a **Vercel** project built from `master`, connected to that customer's Neon
database. Every pull request gets its own preview.

### A new customer deployment

1. Set up the database as in [Onboarding a new hotel](#onboarding-a-new-hotel).
2. In Vercel, **Add New → Project** and import the repository. Next.js is detected; keep the default build
   settings.
3. Under **Settings → Environment Variables** (Production and Preview):

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | The customer's **pooled** Neon string (`DATABASE_URL_UNPOOLED` isn't needed on Vercel) |
   | `AUTH_SECRET` | A new `openssl rand -base64 48`, unique to this customer |
   | `CRON_SECRET` | Another `openssl rand -base64 48` |
   | `TWO_FACTOR_MODE` | `demo` while setting up, `totp` before real guest data goes in |
   | Optional | The customer's own email, SMS, Razorpay and door-lock keys (see [Configuration](#configuration)) |

   Don't set `NEXT_PUBLIC_SUPABASE_*`, `SUPABASE_SERVICE_ROLE_KEY`, `DEMO_BUILD` or
   `NEXT_PUBLIC_LOCAL_DEMO`; `DEMO_BUILD=1` builds the desktop version.
4. Under **Settings → Functions → Function Region**, pick the region nearest the database (Singapore `sin1`
   for `ap-southeast-1`), then redeploy. Every page makes several queries, so distance shows on every
   click.
5. Add the customer's domain, sign in, and continue with step 4 of
   [Onboarding a new hotel](#onboarding-a-new-hotel).

### Releasing a change

1. Run new migrations with `npm run db:migrate` against **every customer's database** before merging the
   code that needs them.
2. Check the pull request's Vercel preview.
3. Merge to `master`; every customer project deploys automatically.

### Scheduled jobs

Declared in `vercel.json`. They need `CRON_SECRET`, which Vercel sends as a bearer token.

| Job | Schedule (UTC) | Does |
|---|---|---|
| `/api/cron/reports` | 02:00 daily (07:30 IST) | Emails the scheduled reports |
| `/api/cron/maintenance` | 02:30 daily | Escalates overdue tickets, raises due preventive work |
| `/api/cron/notifications` | 03:00 daily | Pre-arrival, check-in and post-stay messages, and VIP arrival alerts |

They work through every active property in the deployment. Vercel Cron runs only on production; to test a
job on a preview, call it with the bearer token. The Hobby plan limits the number of cron jobs; if it
refuses three, merge them into one endpoint rather than dropping one.

---

## Integrations

| Endpoint | Used by | Auth |
|---|---|---|
| `POST /api/room-controls` | In-room controls (Do Not Disturb). Send the hotel code as `property` in a group | `Bearer ROOM_CONTROLS_SECRET` |
| `POST /api/attendance` | Biometric attendance devices | `Bearer ATTENDANCE_API_SECRET` |
| `GET /api/cron/maintenance`, `/reports`, `/notifications` | Scheduler (Vercel Cron) | `Bearer CRON_SECRET` |
| `POST /api/payments/razorpay/webhook` | Razorpay | `X-Razorpay-Signature` (HMAC, `RAZORPAY_WEBHOOK_SECRET`) |
| `GET /api/storage/v1/object/public/<bucket>/<path>` | Room photos (Neon) | None: public buckets only |
| `GET /api/storage/v1/object/sign/<bucket>/<path>?token=…` | ID scans, signatures, maintenance photos (Neon) | Signed, expiring link (`AUTH_SECRET`) |

Each endpoint stays off until its secret is set; request formats are documented at the top of each route
file. Door locks and kitchen displays connect through generic webhooks, so BluInn works with the hotel's
own hardware vendor. Online payments use Razorpay payment links: card details never reach BluInn, and a
folio is credited only when the signed webhook confirms the payment.

---

## Security

Every request passes three checks:

1. **`proxy.ts`** sends signed-out visitors to `/login`.
2. **Every page and server action** checks the specific permission (`requirePermission`).
3. **Row-level security** in the database checks it again, as the final safeguard. Only signed-in staff
   can read anything; this holds on Neon too, where each query runs as `authenticated` with the user's id
   in `auth.uid()`.

In a group, a **restrictive** policy on every table also limits reads and writes to the property the
person is working in. A page that forgets to filter shows too little, never too much.

Also built in:
- **Two-factor sign-in**, required for the System Administrator and Finance roles and optional for
  everyone else.
- **Password rules:** complexity, expiry, and lockout after repeated failures.
- **Sign-out after inactivity**, and administrators can end anyone's sessions.
- **Private ID scans:** only authorised roles can view them, and every view is logged.
- **An audit log** with before and after values, which nobody can edit or delete.
- **Not indexed:** `robots.txt` disallows everything.

The full model, and the traps to know before changing database code, are in
[docs/how-it-works.md](docs/how-it-works.md#security-model).

---

## Roadmap and known limitations

**Next up:**
- **Channel manager** (Module 9): two-way sync with Booking.com, Expedia and Agoda. Per-channel room
  allocations are already stored but not yet enforced. Each hotel's extranet accounts and connectivity
  credentials are needed before it can be tested.
- **Guest booking engine** (Module 17): direct bookings from a hotel's own website, through a narrow API
  rather than direct database access. Until then, website bookings are entered by the desk with the source
  *website*.
- **Mobile apps** (Module 18).

**Known limitations:**
1. **Cash outlet bills are missing from the GST tax summary.** The summary reads folio charges and event
   bills, and an outlet bill paid in cash never touches a folio (the POS reports total it separately).
   Fix this before a hotel files a GST return from BluInn.
2. **No automatic end-of-day clean-up.** Expired tentative holds aren't released, ID scans aren't deleted
   at the end of their retention period, and expired loyalty points aren't retired. Room charges are
   posted at check-out, and no-shows are marked by hand.
3. **Reports are always live.** There is no closed-day snapshot, so amending an old stay changes the
   report for its dates.
4. **No expense ledger.** GOPPAR uses a monthly operating cost entered under **Settings**.
5. **No stock or recipe tracking** in the outlets.
6. **Guest profiles are per property.** A guest who stays at two hotels in a group has a profile at each;
   loyalty rules are shared from head office, points are earned per property.
7. **The app is in English.** Other languages apply to guest messages.
8. **Event equipment isn't held against a date**, so there is no clash check between functions.
9. **On Neon, nothing updates live.** The dashboard, front desk and housekeeping boards refresh every 15
   seconds while on screen.
10. **On Neon, files live in the database.** Room photos, ID scans and maintenance photos count towards the
    Neon plan's storage (0.5 GB on the free plan).
11. **Uploads over 4.5 MB fail on Vercel.** The app allows 5 MB images, but a Vercel function accepts at
    most 4.5 MB per request.

**Not planned:** GDS connectivity, WhatsApp and push notifications, and paid competitor rate-shopping
(competitor rates are entered by hand).

---

## Further reading

- [docs/how-it-works.md](docs/how-it-works.md): the rules each area enforces and why (reservations, billing,
  revenue, multi-property, POS, events, loyalty, reports, the security model).
- [docs/go-live-checklist.md](docs/go-live-checklist.md): what to set up and confirm before a hotel goes
  live.
- [app/(bluinn)/DESIGN.md](app/%28bluinn%29/DESIGN.md): the design system, for building or changing a page.
- [desktop/README.md](desktop/README.md): the Windows desktop demo build, licensing and support.

---

© Blu Margins. All rights reserved.
