import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { headers } from "next/headers";
import "./globals.css";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",", 1)[0]?.trim();
  const requestHost = forwardedHost || requestHeaders.get("host") || "localhost:3002";
  const safeHost = /^[a-z0-9.-]+(?::\d{1,5})?$/i.test(requestHost) ? requestHost : "localhost:3002";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto")?.split(",", 1)[0]?.trim();
  const protocol = forwardedProtocol === "http" || forwardedProtocol === "https"
    ? forwardedProtocol
    : safeHost.startsWith("localhost") || safeHost.startsWith("127.")
      ? "http"
      : "https";
  const origin = new URL(`${protocol}://${safeHost}`);
  const previewImage = new URL("/og.png", origin).toString();

  return {
    metadataBase: origin,
    title: "Reference Bridge — HPO & PanelApp Offline Downloader",
    description: "Download verified HPO and green PanelApp UK/Australia reference files for PDF to HPO offline.",
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: {
      title: "Reference Bridge",
      description: "Verified HPO and green PanelApp reference packs for PDF to HPO offline.",
      type: "website",
      images: [{ url: previewImage, width: 1730, height: 909, alt: "Reference Bridge HPO and PanelApp downloader" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "Reference Bridge",
      description: "Verified HPO and green PanelApp reference packs for PDF to HPO offline.",
      images: [previewImage],
    },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable}`}>{children}</body>
    </html>
  );
}
