import type { Metadata, Viewport } from "next";
import "./globals.css";
import { adminFonts } from "./(bluinn)/fonts";
import { PRODUCT } from "./lib/app-config";

export const metadata: Metadata = {
  title: {
    default: PRODUCT.name,
    template: `%s | ${PRODUCT.name}`,
  },
  description: `${PRODUCT.name} — ${PRODUCT.tagline}.`,
  applicationName: PRODUCT.name,
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: PRODUCT.themeColor,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${adminFonts} h-full antialiased`}>
      <body className="min-h-full bg-slate-50 text-slate-900 font-sans">{children}</body>
    </html>
  );
}
