import type { Metadata, Viewport } from "next";

import { ACCESSIBILITY_PREFERENCES_BOOTSTRAP_SCRIPT } from "@/lib/preferences/accessibility-preferences";
import { SITE_URL } from "@/lib/site";

import "./globals.css";

const DESCRIPTION = "Build skills that stay with a private, adaptive learning studio for coding, DSA, web, and AI.";

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: "Codestead",
    template: "%s · Codestead"
  },
  description: DESCRIPTION,
  applicationName: "Codestead",
  alternates: {
    canonical: "/"
  },
  openGraph: {
    type: "website",
    url: SITE_URL,
    siteName: "Codestead",
    title: "Codestead",
    description: DESCRIPTION
  },
  twitter: {
    card: "summary_large_image",
    title: "Codestead",
    description: DESCRIPTION
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  colorScheme: "dark light",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f6f1" },
    { media: "(prefers-color-scheme: dark)", color: "#121611" }
  ]
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" data-scroll-behavior="smooth" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{ __html: ACCESSIBILITY_PREFERENCES_BOOTSTRAP_SCRIPT }}
          id="accessibility-preferences-bootstrap"
        />
      </head>
      <body>
        <a className="skip-link" href="#main-content" tabIndex={0}>
          Skip to content
        </a>
        {children}
      </body>
    </html>
  );
}
