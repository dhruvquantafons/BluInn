import { useId } from "react";

/**
 * The BluInn mark: an inn's roofline over a "B", on a line of water — drawn
 * in white-to-pale-blue line work for the blue surfaces it sits on (the top
 * bar, the hero banner, the sign-in panel).
 *
 * The gradient id comes from useId because the sidebar renders the mark more
 * than once (mobile bar, drawer, desktop rail), and a gradient referenced by
 * a shared id stops painting when its first copy sits in a hidden subtree.
 */
export default function BrandMark({ className = "w-10 h-10" }: { className?: string }) {
  const tint = `brand-tint-${useId().replace(/:/g, "")}`;
  const stroke = `url(#${tint})`;
  return (
    <svg viewBox="0 0 40 40" className={className} role="img" aria-label="BluInn" fill="none">
      <defs>
        <linearGradient id={tint} x1="6" y1="4" x2="34" y2="36" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#c2d7fd" />
        </linearGradient>
      </defs>
      <g stroke={stroke} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        {/* Roofline */}
        <path d="M5 17.5 20 6l15 11.5" />
        {/* The B */}
        <path d="M15 16v14.5M15 16h5.5a3.6 3.6 0 0 1 0 7.2H15M15 23.2h6.3a3.65 3.65 0 0 1 0 7.3H15" />
        {/* Water */}
        <path d="M6 35.5q3.5-2.4 7 0t7 0 7 0 7 0" strokeWidth="1.6" />
      </g>
    </svg>
  );
}
