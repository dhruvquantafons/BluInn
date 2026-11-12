import { redirect } from "next/navigation";
import { requireSession } from "../../../lib/auth";
import { BILLING_TABS, firstOpenable } from "../../../lib/page-access";

/** /billing itself: the first Billing tab this person can open (it used to be a 404). */
export default async function BillingIndex() {
  const session = await requireSession();
  redirect(firstOpenable(session, BILLING_TABS) ?? "/");
}
