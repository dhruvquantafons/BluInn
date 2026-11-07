# BluInn demo data

`seed_demo.sql` turns a freshly migrated BluInn database (one property, its first administrator) into a mid-size Indian hotel with a month of history and a month of forward bookings. All dates are relative to "today" in the property's time zone, so the data always runs from 30 days back to 30 days ahead.

## Load

```sh
psql "$DATABASE_URL_UNPOOLED" -v ON_ERROR_STOP=1 -f neon/demo/seed_demo.sql
```

- It runs as one transaction: it loads completely or not at all. It takes about 10 seconds locally.
- Run it with the role that ran the migrations (the Neon database owner). It needs nothing beyond `db/platform.sql` and migrations 0001–0039.
- It acts as the first active superuser, the way the app does (through the `request.jwt.claims` / `auth.uid()` settings), and works at that person's property.
- It does not rename the property. It only fills in blanks: legal name, address, city, state, postcode, phone, email, GST state code and a GSTIN with a valid check digit (needed for GST invoices). It also turns on loyalty and sets an HR geofence if none is set.
- A second run stops with `DEMO_ALREADY_SEEDED`. The schema `demo_seed` is the marker.

## What it adds

| Area | What's there |
|---|---|
| Rooms & rates | 2 new room types (Classic Room ₹5,999, which falls in the 5% slab, and Executive Suite), 30 rooms on 4 floors. One room (308) is out of order. Also 6 rate plans (Corporate, Non-refundable, Stay 3, Group, MAP, Romantic Getaway package with components), 5 seasons, 4 restrictions and channel allocations. |
| Guests | 59 profiles (51 Indian, 8 foreign) with Aadhaar, licence or passport details, birthdays and anniversaries in the coming weeks, and 21 loyalty members across Silver, Gold and Platinum. There is a duplicate pair (Amit Verma), one blacklisted guest and about 75 feedback entries. |
| Bookings | About 430 stays: about 235 checked out (folios settled, GST invoices issued, B2B invoices with the buyer's GSTIN, a city-ledger transfer), 18 in house, and arrivals and departures today. The rest are future confirmed and tentative stays, cancellations, a no-show with its penalty, an in-house corporate group, a wedding group of 6 rooms with no rooms assigned yet, a complimentary stay and promo-code redemptions. |
| Night audit | The last 30 days are closed, with their daily reports. The business date is today. |
| Billing | About 250 invoices. There is one credit note with its approved and processed refund, a refund waiting for approval, and a company part-payment on the city ledger. |
| Front desk | 15 closed cash shifts and 2 open ones (with a paid-out and a safe drop), traces, requests, a room move, airport pickup and drop, and deposits. |
| Housekeeping | History of cleaned and inspected tasks. Today's tasks are in every state (pending, in progress, cleaned, inspected, failed touch-up). There are also lost-and-found items and room status reports (one discrepancy). |
| Maintenance | 11 assets, 5 preventive schedules and 15 tickets (open, in progress, on hold, resolved, escalated, preventive). |
| Inventory | 5 locations and 22 items, with purchases, transfers, POS and housekeeping consumption, wastage and a stock count. |
| POS | Menus for all 7 outlets (Bar, Spa and Gift Shop are switched on) and about 830 bills, settled or charged to rooms. Today there is an open table, a part-paid bar tab, laundry in process and a room-service charge. |
| Events | 5 events: completed and invoiced, confirmed with an advance, a quotation waiting for approval, and an enquiry. They have banquet event order (BEO) notes. Seeded package, equipment and hall prices are set where they were zero. |
| Revenue | Promo codes, pricing rules, rate changes waiting for approval, rejected and expired, and 4 competitors with 14 days of rates. |
| Reports & notifications | 4 report schedules and about 110 notification log rows (emails sent and failed, SMS skipped, staff alerts). The app has no table of saved reports; the stored night-audit reports serve that role. |
| People | 16 staff in 8 departments. There is a roster for last week and this week, about 190 attendance records, leave requests (approved, pending, rejected), timesheets (2 submitted, 1 approved) and staff feedback. |

## Demo logins

Every account uses the password **`Demo@12345`**. Each one is set up so it doesn't have to change its password at first sign-in.

| Email | Role |
|---|---|
| rajesh.iyer@example.com | General Manager (manager) |
| priya.nair@example.com | Front Office Manager |
| ankit.sharma@example.com | Front Desk |
| sneha.kulkarni@example.com | Front Desk |
| vikram.rathod@example.com | Night Auditor |
| meera.joshi@example.com | Reservations Agent |
| sunita.devi@example.com | Housekeeping Supervisor |
| ramesh.yadav@example.com, lakshmi.pillai@example.com, imran.khan@example.com | Housekeeping |
| suresh.patil@example.com | Maintenance |
| arjun.malhotra@example.com | F&B Manager |
| kavita.singh@example.com | POS Cashier |
| nikhil.agarwal@example.com | Finance (this role requires 2FA, so the first sign-in asks for an authenticator) |
| farah.sheikh@example.com | Banquet Manager |
| pooja.menon@example.com | Guest Relations |

The existing administrator's account and password are not touched.

## Remove

```sh
psql "$DATABASE_URL_UNPOOLED" -v ON_ERROR_STOP=1 -f neon/demo/remove_demo.sql
```

- It deletes exactly the rows recorded in `demo_seed.rows`, along with the demo's audit-log rows.
- It restores the property fields, outlet switches and event prices the seed changed, resets the invoice, event and POS number series, then drops `demo_seed`.
- Folio lines, invoices, credit notes and stock movements are append-only by trigger. The script disables user triggers on the affected tables for its own transaction, which needs the table owner, and re-enables them before commit.
- If real data has since been attached to a demo row, the script stops with `DEMO_STILL_REFERENCED` and removes nothing.
- Some things are not reverted:
  - Sequence counters, so booking, group, ticket, lost-and-found and loyalty member numbers carry on from where the demo left them.
  - The property's business date.

## Known issue

If a room turned over today (one guest left today and another checked into the same room), the room shows as `available`/`dirty` instead of `occupied`. To fix it after loading:

```sql
update rooms r set status = 'occupied'
  from bookings b where b.room_id = r.id and b.status = 'checked_in' and r.status = 'available';
```
