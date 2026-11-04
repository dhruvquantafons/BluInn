"use client"; // Error boundaries must be Client Components

import "./globals.css";
import { TriangleAlert } from "lucide-react";
import AuthShell from "./(bluinn)/components/AuthShell";
import { buttonClass } from "./(bluinn)/components/ui";
import { adminFonts } from "./(bluinn)/fonts";
import { PRODUCT } from "./lib/app-config";

/**
 * The last resort: an error in the root layout itself. It replaces the root
 * layout, so it brings its own <html>, <body>, styles and font.
 */
export default function GlobalError({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <html lang="en" className={`${adminFonts} h-full antialiased`}>
      <body className="min-h-full bg-slate-50 text-slate-900 font-sans">
        <AuthShell
          badge={<TriangleAlert strokeWidth={1.75} />}
          title="Something went wrong"
          subtitle={`${PRODUCT.name} could not load. Try again in a moment.`}
        >
          <button type="button" onClick={() => retry()} className={`${buttonClass} w-full h-11`}>
            Try again
          </button>
          {error.digest && (
            <p className="text-center text-[11px] text-slate-400 pt-4">
              Reference <span className="font-mono">{error.digest}</span>
            </p>
          )}
        </AuthShell>
      </body>
    </html>
  );
}
