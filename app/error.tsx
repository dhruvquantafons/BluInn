"use client"; // Error boundaries must be Client Components

import { useEffect } from "react";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import AuthShell from "./(bluinn)/components/AuthShell";
import { buttonClass, secondaryButtonClass } from "./(bluinn)/components/ui";
import { PRODUCT } from "./lib/app-config";

/**
 * An unexpected error anywhere below the root layout. Server errors arrive
 * with a generic message and a digest; the digest is shown so staff can quote
 * it and it can be matched to the server log.
 */
export default function ErrorPage({ error, retry }: { error: Error & { digest?: string }; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <AuthShell
      badge={<TriangleAlert strokeWidth={1.75} />}
      title="Something went wrong"
      subtitle={`${PRODUCT.name} hit an unexpected error. Try again, and if it keeps happening, quote the reference below.`}
    >
      <div className="space-y-3">
        <button type="button" onClick={() => retry()} className={`${buttonClass} w-full h-11`}>
          Try again
        </button>
        <Link href="/" className={`${secondaryButtonClass} w-full h-11`}>
          Back to the dashboard
        </Link>
        {error.digest && (
          <p className="text-center text-[11px] text-slate-400 pt-1">
            Reference <span className="font-mono">{error.digest}</span>
          </p>
        )}
      </div>
    </AuthShell>
  );
}
