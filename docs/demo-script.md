# BluInn live demo script

About 45 minutes: 5 for the opening, then roughly 8 for each of the five sections, and 5 for questions. Each
step gives **Click** (where to go), **Show** (what to do on screen) and **Say** (the point to make). If time is
short, do only the steps marked ★.

---

## Before the demo (do this the day before)

The hosted database is almost empty: no rooms, and only the admin login. A demo with empty screens falls flat,
so set up a believable hotel first.

1. **Settings** (Admin → Settings): hotel name, legal name, address, a GSTIN, state, phone, email.
2. **Rates → Room types**: 2–3 types (Deluxe ₹4,500, Premier ₹6,500, Suite ₹9,500) and one rate plan (BAR, CP).
3. **Rooms**: 8–10 rooms across the room types.
4. **Staff**: three logins, so you can switch roles during the demo:
   - Front Desk Agent
   - Housekeeping Staff
   - General Manager
5. **HR → Setup**: shifts are already seeded. Roster the three staff for this week (Roster → Fill from pattern).
6. **Bookings**: 6–8 bookings:
   - two arriving today
   - two in-house, so they need check-out today or tomorrow
   - one future group
   - one VIP
7. **Point of sale**: open the restaurant and add 4–5 menu items.
8. **Night audit**: the business date is behind. Run night audit until the status bar shows **today**.
9. Keep two browser windows open:
   - normal window: signed in as **admin**
   - private window: signed in as **Housekeeping Staff**, to show role-based access

**On the day:**
- Zoom the browser to 110%.
- Close other tabs.
- Have the demo 2FA code ready (`123456`).

---

## 1. Opening (5 min) ★

**Say:** "BluInn is our hotel management system. One hotel, or a group of hotels, runs its whole day from it:
reservations, front desk, rooms, housekeeping, restaurant, banquets, billing with GST, staff and reports. It runs
in the browser on any device, and every customer gets their own private database."

**Show:**
1. The sign-in page, then sign in with two-step verification. **Say:** "Every login is personal, and admins and
   finance must use two-step sign-in."
2. The top bar's five sections: **Front Office, Operations, Commercial, People, Admin**. **Say:** "Everything a
   hotel does sits in one of these five. Each person sees only what their role allows."
3. The status strip shows the business date. **Say:** "The hotel works on a business date that only night audit
   moves forward. That's how accounts stay closed and correct."

---

## 2. Front Office (10 min)

Arrivals, stays, and the guests behind them.

### Dashboard ★
**Click:** Front Office → Dashboard.
**Show:** today's arrivals, departures, in-house guests, occupancy and revenue.
**Say:** "This is the first screen the manager sees each morning: how full we are, who is coming and going, what
needs attention."

### New booking ★
**Click:** Bookings → New booking.
**Show:** pick dates and a room type. The price works out by itself from the rate plan, season and tax. Add the
guest and save.
**Say:**
- "The system will not let us sell a room we don't have. It stops overbooking unless a manager overrides it with
  a reason."
- "Cancellation penalties, deposits and the GST slab are worked out automatically."

Also mention: **Groups** (one booking for many rooms), the **waitlist**, and splitting a stay.

### Tape chart
**Click:** Tape chart.
**Show:** the room-by-day grid.
**Say:** "Every room, every night, at a glance. The reservations team plans from here."

### Front desk: check-in ★
**Click:** Front desk.
**Show:** today's arrivals list; open one and check in.
- Capture ID for everyone in the room.
- Assign the room; it only offers clean, inspected rooms.
- The registration card with the guest's e-signature.

**Say:** "Check-in is one screen. ID scans are stored privately, and every time someone views one it is logged."

Also on the front desk:
- **traces**: reminders for a department on a date
- **pick-ups and drops**
- **deposits due**
- **VIP and birthday alerts**

### Walk-in
**Show:** the **Walk-in** button. Pick a room free tonight, enter the guest, and go straight to check-in.
**Say:** "A walk-in guest is in their room in under a minute."

### Folio and cash shift
**Click:** open an in-house booking, then the **Folio** tab.
**Show:** room charges, post an extra, take a payment.
**Click:** Cash shifts.
**Show:** open a shift with a float, then show the expected cash figure.
**Say:** "Every cashier opens a shift. At close, the system says what should be in the drawer, and any
difference is recorded for the manager to review."

### Check-out ★
**Show:** check out a departing guest, and email the bill.

### Guests and loyalty
**Click:** Guests.
**Show:** one guest profile: stay history, preferences, loyalty points.
**Say:** "Repeat guests are recognised, and the loyalty programme rewards them."

### Night audit ★
**Click:** Night audit.
**Show:** the checklist before running:
- arrivals not yet checked in
- departures not checked out
- open cash shifts
- room discrepancies

Then show the daily report from a previous night.
**Say:** "At the end of each day, night audit posts room charges, handles no-shows, closes the day and moves the
date forward. Once a day is closed, nobody can quietly change it. Corrections are posted as new entries, which
auditors expect."

---

## 3. Operations (8 min)

Rooms, upkeep, outlets and events.

### Rooms
**Click:** Operations → Rooms.
**Show:** the live room board: occupied, vacant, dirty, clean, inspected, out of order.

### Housekeeping ★
**Click:** Housekeeping.
**Show:** today's cleaning tasks, assigned to attendants.
**Then:** switch to the **private window** (Housekeeping Staff login).
**Show:**
- they see only **My tasks**
- start and finish a room, then report it occupied or vacant
- post a minibar item to the guest's bill from the room

**Say:**
- "The attendant uses a phone. When they finish, the front desk sees the room is ready immediately."
- "If housekeeping says a room is empty but the desk says occupied, we flag it as a discrepancy, a skipper or a
  sleeper."
- **Point out:** this login cannot see billing, rates or reports at all.

### Maintenance
**Click:** Maintenance.
**Show:** raise a ticket with a photo, then show priorities and target times, and preventive schedules.
**Say:** "Overdue tickets escalate by themselves. Repeating work, like AC servicing, is raised automatically."

### Inventory
**Click:** Inventory.
**Show:** stock levels with low-stock badges, receiving stock and issuing it to a floor.
**Say:** "Minibar and amenities are deducted automatically when bills settle or rooms are cleaned."

### Point of sale ★
**Click:** Point of sale.
**Show:** open a restaurant bill, add items, send the kitchen ticket, then **charge to room**.
**Say:** "Seven outlet types: restaurant, bar, room service, minibar, spa, shop, laundry. A bill charged to the
room appears on the guest's folio straight away."

### Events and banquets
**Click:** Events & banquets.
**Show:** the events diary, a quotation, the banquet event order.
**Say:** "Weddings and conferences from enquiry to contract to bill. The system warns us if the same projector
or hall is promised twice."

---

## 4. Commercial (8 min)

Rates, revenue, billing and reports.

### Rates
**Click:** Commercial → Rates.
**Show:** rate plans with meal plans, seasons (weekend and peak rates), and restrictions (minimum stay, closed to
arrival, stop-sell).

### Revenue
**Click:** Revenue.
**Show:** the forecast and the pricing rules, for example "above 80% occupancy, +15%".
**Say:** "Rates move with demand. Big changes wait for the GM's approval, and promo codes have limits."

### GST invoice ★
**Click:** a checked-out booking → Folio → **Issue invoice**.
**Show:** the bill-to form with a business GSTIN.
**Show:** the printed invoice:
- both GSTINs
- place of supply
- SAC code on every line
- the CGST and SGST split
- the SAC summary

**Say:** "This is a fully GST-compliant tax invoice. The system checks the guest's GSTIN for typos before it
prints."

### Credit note ★
**Show:** **Issue credit note** under the invoice. Credit part of one night, then show the credit-note print.
**Say:** "Under GST we can't just edit or cancel an old invoice. We issue a numbered credit note, as the law
requires, and the guest's balance updates."

### GST register
**Click:** Billing → **GST register**.
**Show:** the month's figures and the CSV downloads: B2B, B2C, credit notes, SAC summary, documents issued.
**Say:** "The accountant gets GSTR-1 data ready-made. No retyping invoices."

### Flash report ★
**Click:** Reports → **Flash**.
**Show:**
- today, month to date and year to date against last year
- occupancy, ADR, RevPAR
- revenue by department
- the week ahead

**Say:** "This is the one page a GM reads every morning."

Also: **Reports** tabs (financial, operations, guests), the **report builder** with Excel export, and
**scheduled reports** emailed automatically.

---

## 5. People (6 min)

Staff, shifts, attendance and leave.

### My work and My profile ★
**Click:** People → HR & attendance.
**Show:**
- **clock in** from the phone; it checks the staff member is at the hotel
- my shifts this week
- request leave
- **My timesheet**

**Then:** My profile.
**Say:** "Every staff member gets this, whatever their role. They keep their own phone number and emergency
contact up to date."

### Roster and attendance
**Show:**
- **Roster**: the weekly grid, copy last week
- **Attendance**: who is present, late or absent today

### Timesheets and overtime ★
**Click:** Timesheets.
**Show:** last week's hours per person (rostered, worked, overtime, worked on a day off), then **Approve** one.
**Say:**
- "Overtime is worked out automatically: beyond 9 hours a day or 48 a week, the usual labour-law limits."
- "Once a manager approves a week, that attendance is locked, so payroll is paid on figures that can't change
  afterwards."

**Show:** the **payroll export** CSV with approved hours.

### Staff
**Click:** Staff.
**Show:** create a staff login, suspend one, end someone's sessions.

---

## 6. Admin (5 min)

### Roles and permissions ★
**Click:** Admin → Roles.
**Show:** the 14 built-in roles and the permission ticks.
**Say:** "Each hotel decides exactly who can do what. The database enforces every permission, not just the
screens."

### Settings
**Click:** Settings.
**Show:** hotel details, tax slabs, GST, policies, and **Templates** (guest email and SMS wording, in several
languages).

### Properties
**Click:** Properties.
**Show:** comparing hotels in a group, and pushing standards to all of them.
**Say:** "A hotel group runs every property from one login."

### System status
**Click:** System status.
**Show:** which integrations are working (email, SMS, Razorpay, kitchen display), the database version, each
hotel's last night audit, and the scheduled jobs. Press **Send me a test email**.
**Say:** "Our support team and the hotel can see at a glance that everything is connected."

### Audit log and data export ★
**Click:** Audit log.
**Show:** every change with before and after values; filter by module; download CSV.
**Click:** **Security events**.
**Show:** sign-ins, failed logins, role changes.
**Click:** Data export.
**Say:** "Nothing can be changed without a trace, and nobody can edit the log. The hotel owns its data and can
download all of it at any time."

---

## 7. Close (2 min)

**Say:**
- "One system, from booking to GST return to payroll hours."
- "It is built for Indian hotels: GST, ₹, Indian ID types, Razorpay."
- "It is secure: personal logins, two-step sign-in, database-level permissions, a locked audit log."
- "It scales from one hotel to a group."
- "Next on our roadmap: a channel manager for OTAs (Booking.com, MakeMyTrip, Agoda), a direct booking engine and
  mobile apps."

---

## Likely questions

| Question | Answer |
|---|---|
| Does it connect to OTAs? | Not yet. The channel manager is next on the roadmap; OTA bookings are entered with the source *OTA* for now. |
| Does it do payroll? | It gives approved hours, overtime and leave to the payroll system or accountant. It does not calculate salaries, PF or ESI. |
| Is our data safe from other hotels? | Every customer has its own separate database. In a group, each hotel's data is kept apart. |
| Can staff use phones? | Yes. Every screen works in a phone browser: housekeeping, clock-in, POS. |
| Does it work offline? | It's a cloud system. There is a Windows desktop build for offline demos. |
| E-invoicing? | Not yet. It is needed only above ₹5 crore turnover, and needs a GST portal integration. |
| What if the internet goes down? | Data is safe in the cloud. Printed registration cards and bills can be reprinted later. |

## If something goes wrong

| Problem | Fix |
|---|---|
| A screen is empty | Say "this is a fresh hotel" and add a record live. It shows how quick setup is. |
| Asked for the 2FA code | `123456` (demo mode). |
| "Night audit is behind" (amber status bar) | Run night audit; that is a feature, not an error. |
