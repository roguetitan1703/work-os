import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";
import { Providers } from "@/components/providers";
import { RegisterServiceWorker, ThemeColorSync } from "@/components/pwa";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Work OS",
  description: "Personal task manager",
  robots: { index: false, follow: false },
  applicationName: "Work OS",
  appleWebApp: { capable: true, title: "Work OS", statusBarStyle: "default" },
  icons: { apple: "/icons/180" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

// proxy.ts sends every page a Content-Security-Policy with a nonce; next-themes' inline script needs it too. Reading the
// request makes every page render per request (a nonce cannot be baked into a static page).
export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const nonce = (await headers()).get("content-security-policy")?.match(/'nonce-([^']+)'/)?.[1];
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="h-full flex bg-background">
        <Providers nonce={nonce}>
          {children}
          <Toaster />
          <RegisterServiceWorker />
          <ThemeColorSync />
        </Providers>
      </body>
    </html>
  );
}
