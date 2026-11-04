import { PRODUCT } from "../../lib/app-config";

/**
 * The product's sign-off on a printed document: one muted line at the foot of
 * invoices, folios, bills and the like. The hotel's identity stays in the
 * document's header; this only says what produced it. Not used in guest
 * emails, which carry the hotel alone.
 */
export default function PrintFooter({ className = "" }: { className?: string }) {
  return (
    <p className={`mt-6 text-center text-[10px] tracking-wide text-slate-400 ${className}`}>
      Powered by {PRODUCT.name}
    </p>
  );
}
