import { useId } from "react";
import { PRODUCT } from "../../lib/app-config";

/**
 * The BluInn mark: a bold "B" monogram cut by a diagonal slit that echoes
 * the fluted-glass stripes of the sign-in panel, with a small cyan spark at
 * the top right. Solid shapes, so it holds up at 28px. The counters and the
 * slit are cut out with a mask, so the surface it sits on (the top bar, the
 * hero banner, the sign-in panel) shows through them.
 *
 * Ids come from useId because the sidebar renders the mark more than once
 * (mobile bar, drawer, desktop rail), and a gradient or mask referenced by a
 * shared id stops painting when its first copy sits in a hidden subtree.
 */
export default function BrandMark({ className = "w-10 h-10" }: { className?: string }) {
  const id = useId().replace(/:/g, "");
  const tint = `brand-tint-${id}`;
  const cut = `brand-cut-${id}`;
  return (
    <svg viewBox="0 0 40 40" className={className} role="img" aria-label={PRODUCT.name} fill="none">
      <defs>
        <linearGradient id={tint} x1="9" y1="6" x2="30" y2="34" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="1" stopColor="#b5d0ff" />
        </linearGradient>
        <mask id={cut} maskUnits="userSpaceOnUse" x="0" y="0" width="40" height="40">
          <rect width="40" height="40" fill="#fff" />
          {/* Counters */}
          <path d="M15 11h5.6a2.5 2.5 0 0 1 0 5H15zM15 23.2h6.6a2.9 2.9 0 0 1 0 5.8H15z" fill="#000" />
          {/* Glass slit */}
          <path d="M3 9.5 37 33.5" stroke="#000" strokeWidth="1.7" strokeLinecap="round" />
        </mask>
      </defs>
      {/* The B */}
      <path
        d="M11.5 6H21a6.9 6.9 0 0 1 4.9 11.8A7.4 7.4 0 0 1 22.6 34H11.5A2.5 2.5 0 0 1 9 31.5v-23A2.5 2.5 0 0 1 11.5 6Z"
        fill={`url(#${tint})`}
        mask={`url(#${cut})`}
      />
      {/* Spark */}
      <path d="M32.5 3.5q.45 2.55 3 3-2.55.45-3 3-.45-2.55-3-3 2.55-.45 3-3Z" fill="#8fe6ff" />
    </svg>
  );
}

/**
 * The product name as a two-tone wordmark: "Blu" in the surface's text colour,
 * "Inn" in pale blue. In Inter a capital I and a lower-case l are the same
 * stroke, so a single-colour "BluInn" reads as "Blulnn"; the colour change
 * marks where "Inn" begins. Splits at the last capital, so it follows
 * PRODUCT.name.
 */
export function Wordmark({ className = "" }: { className?: string }) {
  const name: string = PRODUCT.name;
  const at = Math.max(1, name.search(/[A-Z][a-z]*$/));
  return (
    <span className={`admin-display ${className}`} aria-label={name}>
      <span aria-hidden="true">{name.slice(0, at)}</span>
      <span aria-hidden="true" className="admin-wordmark-tail">
        {name.slice(at)}
      </span>
    </span>
  );
}
