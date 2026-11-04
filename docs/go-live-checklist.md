# Go-live checklist

Work through this for each hotel before real guests and real money go through BluInn. Setup and deployment
are in the [README](../README.md).

- [ ] Switch 2FA to real mode: `TWO_FACTOR_MODE=totp`
- [ ] Enter the hotel's name, legal name, address, GSTIN, phone and email under **Settings**; every
      invoice, folio, registration card and guest email reads them from there
- [ ] Set `NEXT_PUBLIC_APP_URL` on any deployment that is not Vercel production
- [ ] Verify the hotel's domain in Resend and switch `NOTIFY_FROM_EMAIL` to a real address;
      `onboarding@resend.dev` only delivers to the Resend account owner
- [ ] Review the pricing rules and the automatic-approval percentage under **Revenue** before the
      engine is allowed to move live rates; it ships with the threshold at 10%
- [ ] Decide the pre-arrival, check-in and post-stay message timings under **Settings**, and read
      each template through as the guest will receive it
- [ ] Swap Razorpay test keys for live keys, and re-point the webhook at the live site
- [ ] Confirm the invoice prefix and GSTIN with the hotel's accountant before the first invoice is issued
- [ ] Set real exchange rates under **Billing → Currencies** before turning multi-currency on; the seeded
      rates are indicative only
- [ ] Agree the loyalty earn and redemption rates, tier thresholds and points expiry with the owner, then
      turn the programme on under **Guests → Loyalty** (it ships switched off)
- [ ] Confirm which outlets the hotel actually runs and close the rest under **Point of sale → Outlets &
      menus**; all seven ship set up, with only the restaurant, mini-bar, room service and laundry open
- [ ] Confirm every outlet's tax rate and service charge with the accountant, and load the real menus and prices
- [ ] Decide the outlet charge limit per stay under **Settings** (it ships at no limit)
- [ ] Set the hall's real rates, its floor, its seating-plan capacities, the per-head catering prices and the
      equipment hire charges under **Events & banquets → Hall & packages**; everything seeded there is a
      placeholder and the setup page says so until it is changed
- [ ] Decide who approves banquet quotations. **Sales & Marketing** and the **General Manager** hold the
      approval out of the box; give it to whoever actually sells functions
- [ ] Confirm the hall's and the catering's tax rates with the accountant — they are not the same rate
- [ ] Agree the quotation approval threshold, the service charge and the deposit percentage under
      **Settings → Events & banquets**, and write the hotel's function contract terms there
- [ ] Enter the monthly operating cost under **Settings** if the owner wants GOPPAR reported
- [ ] Point a daily scheduler at `/api/cron/reports` and set up who receives which report
- [ ] If the group runs more than one hotel: add each under **Properties**, assign every staff
      member to one, and reserve the head-office tick for people who genuinely need every hotel.
      Confirm which one is the default property
- [ ] Add the email and SMS keys, then send a test message
- [ ] Connect door locks, if used, and test with the vendor
- [ ] Confirm the Neon data region is acceptable to the hotel
- [ ] Use a production `AUTH_SECRET` that differs from every developer's `.env.local`, and reset the Neon
      role password (Neon console → **Roles**) if a connection string was ever shared or pasted anywhere
- [ ] Give every staff member their own login (no shared accounts)
