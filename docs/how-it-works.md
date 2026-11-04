# How BluInn works

Design notes for each area of the app: the rules it enforces and why. Read the section for an area before
changing it. For setup and deployment, see the [README](../README.md).

Module numbers in code comments ("Module 14") refer to BluInn's 18 functional modules, listed in the
README's [Features](../README.md#features) table.

## Contents

- [Reservations and front desk](#reservations-and-front-desk)
- [Billing and invoicing](#billing-and-invoicing)
- [Revenue and dynamic pricing](#revenue-and-dynamic-pricing)
- [Notifications](#notifications)
- [Multi-property](#multi-property)
- [Housekeeping](#housekeeping)
- [Outlets (point of sale)](#outlets-point-of-sale)
- [Events and banquets](#events-and-banquets)
- [Maintenance](#maintenance)
- [HR](#hr)
- [Guests](#guests)
- [Loyalty](#loyalty)
- [Reports](#reports)
- [Administration](#administration)
- [Security model](#security-model)

## Reservations and front desk
- **Booking statuses:** Tentative, Confirmed, Checked-In, Checked-Out, Cancelled, No-Show, Waitlisted.
- **Prices** are calculated as: base rate (or weekend rate) → season → rate plan → length-of-stay discount, plus extra adults. The agreed nightly prices are saved on the booking, so later rate changes don't affect it.
- **Overbooking is blocked by the database.** A manager can override it with a reason, which is logged.
- **Booking sources** include walk-in, phone, email, website, OTA, travel agent, corporate and mobile app, so bookings that arrive through a hotel's own channels are recorded alongside the desk's.
- **Check-in** needs an inspected room, government ID, a signed registration card and the deposit.
- **Check-out** posts the stay's room charges and tax, settles the bill and can email it. There is no
night audit or business date: the app works on today's date in the property's timezone, and no-shows are
marked by hand from the booking.

## Billing and invoicing
- **Folios:** every stay starts with one master bill. The desk can open more — "Company", "Extras" — and move charges between them, so one stay can be billed to more than one payer.
- **Tax invoices** are numbered `INV/2026-27/0001`: sequential per financial year, handed out by the database so two people issuing at once cannot collide, and never reused. An issued invoice cannot be edited or deleted — only cancelled, and the number stays spent.
- The invoice freezes its own lines, totals, rate-wise tax summary and the customer's name and GSTIN, so later changes to the guest record cannot alter a document already given out.
- **Online payments** use Razorpay payment links: the guest pays on Razorpay's page, so no card details reach this application. A folio is credited only when the signed webhook confirms the money arrived — never from the browser.
- **Refunds** at or above the configured threshold need a second person to approve, and never the person who asked. Approving pays out and posts the folio line in one step.

## Revenue and dynamic pricing
- **Rules raise or drop the rate on four triggers** — occupancy crossing a threshold, day of week,
a special event or holiday, and how far ahead the booking is. A rule's conditions are ANDed, so
"Fridays in December above 80% full" is one rule rather than three.
- **Nothing changes a live rate silently.** A proposal at or below the configured percentage is applied
automatically; anything larger waits for a manager under **Revenue → Approvals**. Re-running the engine
each morning reconciles against decisions already made, so an approved rate is not knocked back into the
queue overnight.
- **The build-up order is** base → season → dynamic adjustment → rate plan → length-of-stay → extras,
with a promo code coming off the finished total. A booking stores the nightly prices it was sold at, so
later rate movements never rewrite it.
- **A promo discount is spread back across the nights** rather than left as a total-level deduction.
Room charges bill from the stored nightly breakdown, so a discount that stayed at the top would be
invisible on the bill and the tax would be computed on a price nobody paid.
- **Redemption counting belongs to the database.** A trigger keeps a promo code's usage in step with the
bookings that used it, so a code with 50 uses cannot be oversold by the application forgetting to count.
- **Competitor rates are entered by hand.** The screen records what somebody saw rather than calling a
paid rate-shopping service.

## Notifications
- **Guest messages:** booking confirmation, pre-arrival reminder, check-in instructions, post-stay
thank-you, payment receipt, and a note when a booking is changed. The timing of the
three scheduled ones is configurable in days under **Settings**.
- **Staff alerts:** new booking, VIP arrival, maintenance ticket assigned, and tickets past their SLA.
Each is a toggle, because a hotel that is told everything stops reading any of it.
- **Every attempt is logged**, including ones skipped for want of an API key, so the history answers "was
anybody told?" rather than only "did it work?" — the question that matters when a VIP arrives unannounced.
Browse it under **Notifications**.
- **The scheduled messages are idempotent.** A partial unique index means a retrying scheduler cannot send
the same guest the same pre-arrival reminder twice.
- **Templates are editable per property and per language** with placeholders like `{GuestName}`, under
**Settings → Edit message templates**. WhatsApp and push notifications are not built.

## Multi-property
- **`properties` is the table that was `property_settings`.** Each hotel holds its own name, brand, tax
slabs, check-in times and fee rules. A view still called `property_settings` shows *the
property this request is about*, which is why the many functions written as `from property_settings limit 1`
kept working and kept meaning the right thing.
- **The database decides which hotel, not the browser.** `current_property()` reads the signed-in staff
member's selection from their own row; every `property_id` column defaults to it. That default is why
almost no insert in the application had to change.
- **Separation is one restrictive policy per table.** Postgres ORs permissive policies together, so adding
"and it must be your property" as another permissive policy would have *widened* access. Restrictive
policies are ANDed instead. No existing policy was rewritten, so none could be broken by the change.
- **You work in one hotel at a time.** Even a group owner sees the hotel they have switched to — an
arrivals list, room board or tape chart with two hotels interleaved is unreadable and dangerous to act on.
Comparing hotels is what the group dashboard is for.
- **Natural keys are per-property.** Both hotels may have a room 101, a rate plan called BAR and an
invoice series that restarts each financial year. Twenty-two unique keys carry the property for that reason.
- **Child records follow their parent, not the open screen.** A trigger takes a folio entry's property from
its booking. This matters for the webhook and the nightly jobs, which run as the service role and are not
subject to row-level security at all.
- **Head office pushes standards down.** Brand wording, loyalty rules and the tax template are held once
and copied into the properties chosen. A copy rather than a link, because a hotel can still adjust locally
afterwards — which is what a standard is, as opposed to a lock.
- **The central dashboard** compares occupancy, ADR, RevPAR and revenue side by side. No group ADR is
shown: averaging averages across hotels of different sizes gives a number that means nothing.
- **Central reservation** shows rooms free at every hotel on the chosen dates from the new-booking screen.
Picking one moves the desk there; the booking is then made by the same availability rules, rate plans and
overbooking checks as any other.

## Housekeeping
- Check-outs create cleaning tasks automatically. Tasks are assigned by floor zone and workload, skipping staff on leave or rostered off.
- Status flow: **Dirty → Cleaning → Clean → Inspected**. Only inspected rooms can be checked into.
- Also included: a linen/amenities/minibar checklist, turnaround targets, deep-clean schedule, Do Not Disturb, and lost & found.

## Outlets (point of sale)
- **Seven outlet types** are set up out of the box: restaurant, bar, spa, gift shop, mini-bar, room service and
laundry. Each keeps its own menu, prices, tax rate and service charge.
- **Tax** is set on the outlet and can be overridden per category or per item, so one restaurant charges 5% on
food and 18% on a beer. The effective rate is shown on every menu row.
- **An order is the bill.** Splitting moves lines onto a second bill; merging moves them back and voids the empty
one — the same idea as moving a charge between folios.
- **Charge to room** posts to the guest's folio, one line per tax rate so the tax invoice's rate-wise summary stays
correct. It is refused unless the guest is checked in, and it respects the property's outlet limit per stay.
- **Paying at the outlet:** cash, card, UPI, or loyalty points at the guest's tier rate.
- **Kitchen tickets** mark each line as fired once, print from the browser, and can also be posted to a kitchen
display with `KOT_WEBHOOK_URL`. POS hardware is the hotel's own; BluInn integrates with it.
- **Prices and tax are frozen onto every line** when it is ordered, so re-pricing the menu never rewrites a bill
that has already been served.
- The outlet reports total the takings, because a bill settled with cash never touches a folio and would
otherwise be missing from the day's revenue.

## Events and banquets
- **One hall, sold several ways.** The hall is a record rather than a constant, carrying its name, floor, area,
full-day, half-day and hourly rates, its minimum charge, and how long it is held either side of a function for
dressing and clearing. Each seating plan (theatre, banquet rounds, classroom, U-shape, boardroom, cluster) carries
its own capacity, and the screen warns when a plan is too small for the head count. Equipment can be tied to a
space or left to travel between rooms, and only what serves the chosen space is offered.
- **Catering is quoted per head**, which is how banquet business is actually priced, and the packages are kept
separate from the restaurant menus. What each package includes prints on the quotation, one line per entry.
- **The billed head count is the guarantee or the turnout, whichever is higher.** A client who guarantees 100 and
brings 60 pays for 100; one who brings 120 pays for 120. Closing the event off on the real number reprices the
catering.
- **The hall and the food are taxed at their own rates.** In India hall rental is 18% and banquet catering is
usually 5%, so one function's bill carries more than one rate. `event_tax_bands()` is the single definition of that
split and is used by the quotation, the invoice and the GST tax summary alike, so the three cannot disagree.
- **Only a confirmed function holds the hall.** Two enquiries for the same Saturday are ordinary business — the
hotel quotes several and wins one — so they may overlap and the diary shows them side by side with the days worth
a telephone call. Confirming a second function over a confirmed one is refused.
- **A quotation at or above a configurable value needs a second person's approval**, and whoever prepared it may
not approve it. Repricing a quotation withdraws its approval. Below the threshold no approval is needed at all.
Approval sits with sales, so the **Sales & Marketing** role holds `events.approve` — banquet
business is sold, not taken at the desk.
- **Payment terms are recorded on the booking** and print on the quotation and the contract. Left blank, the
hotel's usual deposit sentence is used.
- **Three documents** print from the same figures: the **quotation** for the client, the **contract** with the
hotel's own terms and both signatures, and the **banquet event order** for the kitchen, the stewards and the
technicians — which deliberately carries no prices.
- **Billing is the main billing module, not a second one.** An event is settled in one of two ways: posted to a
resident guest's folio (a residential conference, one bill with the rooms), or invoiced from the property's own GST
invoice series — the same run of numbers a room invoice takes, because the tax law wants one series for the whole
business.
- **Once an event has been billed its price is fixed.** Changing the head count, the package, the hall charge or
the discount is refused, for the same reason an issued invoice cannot be edited.
- Event revenue is reported on its own under **Reports → Financial**, not folded into occupancy, ADR or RevPAR —
a function is not a room night, and mixing them would spoil all three.

## Maintenance
- Any staff member can raise a ticket for a room, an asset or a place, with photos.
- Priorities are Low, Medium, High and Urgent. Urgent tickets alert the engineering supervisor.
- A ticket can take a room out of order. Resolving the ticket returns the room to sale, marked dirty for housekeeping.
- Each priority has a resolution target; tickets past it are escalated. Assets keep their own history, and preventive schedules raise tickets when due.

## HR
- **Staff profiles:** employee ID, department, shift pattern.
- **Roster:** a weekly grid of shifts.
- **Attendance:** self clock-in (optionally only on site), manual entry by HR, or biometric devices.
- **Leave:** requests and approval.
- **Performance:** summary per staff member.
- **Payroll export:** CSV for payroll software.

## Guests
- **Profiles:** stay history, total spend, preferences, birthday and anniversary.
- **Tags:** VIP and Blacklisted (warned at booking and check-in). Repeat Guest is added automatically.
- **Feedback:** recorded by the desk from the guest's profile, and reported under **Reports → Guests**.
- **Housekeeping of records:** duplicate merging, plus data export and erasure for privacy requests.

## Loyalty
- **Points are held as lots.** Each earning carries its own expiry date and how much of it is left. A
redemption eats the oldest lot first and expiry retires whatever is unused when a lot's date passes — so
the desk can always say which stay a point came from and when it dies, which a single running total
cannot.
- **Earning** happens automatically when an invoice is issued, at the earn rate of the tier the guest
held at the time, on the **taxable value** only: tax collected for the government is not spend with the
hotel. Reprinting an invoice never earns twice.
- **Redeeming** posts a payment to the folio, so points settle a bill exactly as cash does. A redemption
can never exceed the balance, the property's minimum, or what is actually owed.
- **Tiers** (Silver, Gold, Platinum by default, all editable) need both the nights *and* the spend of a
rolling twelve months. **Review every member** (Guests → Loyalty) re-checks everyone after the thresholds
change, and each move is recorded with its reason.
- Erasing a guest's data removes the membership and its points history; the folio lines a redemption
produced are financial record and stay.

## Reports
- **Core KPIs** for any period: occupancy, ADR, RevPAR, GOPPAR, total revenue, outstanding balance, cancellation
rate and no-show rate. ADR divides by rooms *sold* and RevPAR by rooms *available* — that difference is why a
hotel quotes both.
- **Figures are computed live** from bookings and folios. With no night audit there is no closed-day snapshot, so
amending an old stay changes the report for its dates.
- **Financial reports** — daily revenue, tax summary by rate, payments and refunds, outlet-wise sales, outlet
settlement, and money owed — are restricted to management and finance. The restriction is enforced by the database
functions themselves, not just hidden in the interface, so it holds for the screen, the CSV export and the
scheduler alike.
- **Operational reports:** housekeeping performance per attendant, maintenance turnaround against SLA by priority,
and staff attendance against the roster.
- **Guest reports:** repeat guest ratio, feedback scores by category, and loyalty performance including how much
of the outstanding points liability guests are actually redeeming.
- **Build a report** from any of the above over a chosen period, then export to CSV (which Excel opens) or print
to PDF. It is a chooser over reports the system knows how to produce rather than an open query tool: every report
carries its own access rule, and the front desk should not be able to write SQL against the folio.
- **Scheduled email reports** go out daily, weekly on Monday, or monthly on the 1st — always covering a period
that has finished. A schedule already sent today is skipped, so a retrying scheduler cannot email the owner twice.
- **GOPPAR** needs the hotel's running cost, which BluInn does not hold: it has no expense ledger, and accounting
is left to the hotel's own software. Enter a monthly figure under Settings and it is prorated across
the days reported; leave it at zero and GOPPAR is simply not reported rather than reported wrongly.

## Administration
- **Roles:** twelve built-in, all editable, and you can add your own. Permissions are set per module and
action — including loyalty enrolment, corrections and redemption, and the outlets (taking orders,
settling bills and managing menus are separate permissions), and reports (operational, financial and scheduling
are separate).
- **Audit log:** every change, with before/after values. Entries cannot be edited or deleted. Adding a hotel,
changing the group's standards and moving somebody between hotels are all logged — they are changes of access,
which is what the trail is for.
- **Message templates:** editable per property and per language with placeholders like `{GuestName}`, under
**Settings → Edit message templates**.
- **Activity & sessions:** see who is signed in and end someone's sessions, under **Staff → Activity & sessions**.
- **Properties:** compare hotels, add one, and push group standards, under **Properties**. Hidden for a
single-hotel installation, which is what every installation starts as.

## Security model

Access is checked in three layers:
1. `proxy.ts` sends signed-out visitors to the login page.
2. Every page and server action checks the specific permission.
3. Database row-level security checks it again as the final safeguard.

A fourth applies once there is more than one hotel: a **restrictive** policy on every table holds reads and
writes to the property the person is working in. It is ANDed with the layers above rather than ORed with them,
so a page that forgets to filter shows too little, never too much.

On Neon the third layer is unchanged: every query from a signed-in page runs as the `authenticated` role with
that person's id in `auth.uid()`, inside its own transaction, so the same policies apply. Trusted server work
(cron jobs, webhooks, creating logins) runs as the table owner, which bypasses RLS just as Supabase's service
role did.

Other protections:
- **2FA** for administrator and finance roles. Anyone can opt in.
- **Passwords:** complexity rules, expiry, and lockout after repeated failures.
- **Auto sign-out** after a period of inactivity.
- **ID scans** are private. Only authorised roles can view them, each view is logged, and scans are deleted after the retention period.
- **A guest login is not a staff login.** `has_permission()` reads the staff table and answers false for a
guest, so every policy refuses them by default; what a guest may see is granted explicitly and narrowly. The
sign-up trigger creates a staff row only to bootstrap an empty project, and browser-supplied metadata is only
ever read to *decline* that — never to grant it.

**Two things worth knowing before changing database code.** A `SECURITY DEFINER` function runs as its owner
and is therefore *not* subject to row-level security, so any such function that scans a whole table needs its
property filter written in by hand. And the service role bypasses row-level security entirely, which is why
child records get their property from a trigger rather than from a column default.
