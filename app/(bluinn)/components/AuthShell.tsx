import { BedDouble, ChartColumn, ConciergeBell, ReceiptIndianRupee, ShieldCheck } from "lucide-react";
import BrandMark, { Wordmark as WordmarkText } from "./BrandMark";
import GlassStripes from "./GlassStripes";
import { adminFonts } from "../fonts";
import { PRODUCT } from "../../lib/app-config";

/** What BluInn covers, shown on the brand panel. Copy only, no figures. */
const HIGHLIGHTS = [
  { icon: ConciergeBell, title: "Front office", text: "Reservations, check-in and the tape chart" },
  { icon: BedDouble, title: "Rooms & housekeeping", text: "Live room board, tasks and inspections" },
  { icon: ReceiptIndianRupee, title: "Billing & GST", text: "Folios, GST invoices, refunds and payments" },
  { icon: ChartColumn, title: "Reports & analytics", text: "Occupancy, ADR, RevPAR and scheduled reports" },
];

/**
 * The frame around the signed-out screens (sign-in and two-step
 * verification): the brand panel on the left from 1024px, the form on the
 * right. Below 1024px the panel collapses to a short gradient header above
 * the form, so the screens never open on a bare page.
 *
 * Server component; the form passed as children brings its own client code.
 */
export default function AuthShell({
  children,
  title,
  subtitle,
  badge,
}: {
  children: React.ReactNode;
  title: string;
  subtitle: React.ReactNode;
  /** An icon tile shown above the title (e.g. a shield on the 2FA step). */
  badge?: React.ReactNode;
}) {
  return (
    <main className={`admin-theme ${adminFonts} min-h-screen bg-slate-50 lg:grid lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)]`}>
      {/* Brand panel */}
      <section className="admin-hero admin-auth-panel hidden lg:flex flex-col justify-between rounded-none! p-12 xl:p-16">
        <GlassStripes />
        <Wordmark />

        <div className="max-w-md">
          <h1 className="admin-auth-title text-[2.6rem]! leading-[1.1]! tracking-[-0.03em]! font-semibold!">
            Every room, every guest, <span className="admin-auth-accent">one desk.</span>
          </h1>
          <p className="admin-auth-lede text-[15px] mt-4 leading-relaxed">
            Front office, housekeeping, outlets, billing and reports for the hotel, in one place.
          </p>

          <ul className="grid grid-cols-2 gap-3 mt-10">
            {HIGHLIGHTS.map(({ icon: Icon, title, text }) => (
              <li key={title} className="admin-auth-card rounded-2xl p-4">
                <span className="admin-auth-card-icon w-9 h-9 rounded-xl flex items-center justify-center">
                  <Icon className="w-[18px] h-[18px]" strokeWidth={1.9} />
                </span>
                <p className="text-[13.5px] font-semibold text-white mt-3">{title}</p>
                <p className="admin-auth-card-text text-[12px] mt-0.5 leading-snug">{text}</p>
              </li>
            ))}
          </ul>
        </div>

        <p className="admin-auth-lede text-xs opacity-80">Staff access only.</p>
      </section>

      {/* Form side */}
      <div className="admin-auth-canvas relative flex flex-col min-h-screen lg:min-h-0">
        {/* Compact brand header below 1024px */}
        <div className="admin-hero admin-auth-panel lg:hidden rounded-t-none! rounded-b-[2rem]! px-6 pt-6 pb-16">
          <Wordmark />
        </div>

        <div className="relative z-10 flex-1 flex items-start lg:items-center justify-center px-4 sm:px-8 -mt-10 lg:mt-0 pb-10 lg:py-12">
          <div className="w-full max-w-[400px]">
            <div className="admin-auth-form-card rounded-3xl p-7 sm:p-9">
              <div className="mb-7">
                {badge && (
                  <span className="admin-auth-badge mb-5 w-12 h-12 rounded-2xl flex items-center justify-center [&_svg]:w-6 [&_svg]:h-6">
                    {badge}
                  </span>
                )}
                <p className="admin-display admin-auth-heading text-[2rem] leading-tight">{title}</p>
                <p className="text-sm text-slate-500 mt-1.5 leading-relaxed">{subtitle}</p>
              </div>
              {children}
            </div>

            <p className="flex items-center justify-center gap-1.5 text-[11.5px] text-slate-500 mt-6">
              <ShieldCheck className="w-3.5 h-3.5 text-brand-500" strokeWidth={2} aria-hidden="true" />
              Staff access only. Ask an administrator for an account.
            </p>
          </div>
        </div>
      </div>
    </main>
  );
}

function Wordmark() {
  return (
    <div className="admin-auth-brand flex items-center gap-3">
      <span className="admin-auth-brand-tile w-12 h-12 rounded-2xl flex items-center justify-center">
        <BrandMark className="w-9 h-9" />
      </span>
      <span>
        <WordmarkText className="block text-[1.35rem] leading-none text-white" />
        <span className="block text-[12px] text-white/85 mt-1.5">{PRODUCT.descriptor}</span>
      </span>
    </div>
  );
}
