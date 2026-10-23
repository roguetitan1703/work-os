"use client";

import { ThemeProvider } from "next-themes";

export function Providers({ children, nonce }: { children: React.ReactNode; nonce?: string }) {
  return (
    <ThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      enableColorScheme={false}
      disableTransitionOnChange
      nonce={nonce}
    >
      {children}
    </ThemeProvider>
  );
}
