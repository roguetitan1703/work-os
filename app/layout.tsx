import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { Sidebar } from "@/components/sidebar";
import { CurrentBlockBar } from "@/components/current-block-bar";
import { PageTint } from "@/components/page-tint";
import { Toaster } from "@/components/ui/sonner";
import { Providers } from "@/components/providers";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Work OS",
  description: "Personal task manager",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="h-full flex bg-background">
        <Providers>
          <PageTint />
          <Sidebar />
          <main className="flex-1 overflow-y-auto pb-12 relative z-10">
            <div className="p-6">{children}</div>
          </main>
          <CurrentBlockBar />
          <Toaster />
        </Providers>
      </body>
    </html>
  );
}
