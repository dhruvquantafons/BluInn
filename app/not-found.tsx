import Link from "next/link";
import type { Metadata } from "next";
import { Compass } from "lucide-react";
import AuthShell from "./(bluinn)/components/AuthShell";
import { buttonClass } from "./(bluinn)/components/ui";
import { PRODUCT } from "./lib/app-config";

export const metadata: Metadata = { title: "Page not found" };

/** Any URL BluInn does not serve, and any record that no longer exists. */
export default function NotFound() {
  return (
    <AuthShell
      badge={<Compass strokeWidth={1.75} />}
      title="Page not found"
      subtitle="The page may have moved, or the record it pointed to no longer exists."
    >
      <Link href="/" className={`${buttonClass} w-full h-11`}>
        Back to {PRODUCT.name}
      </Link>
    </AuthShell>
  );
}
