import "@fontsource-variable/instrument-sans";
import "@fontsource-variable/jetbrains-mono";
import "@fontsource/instrument-serif";
import "./globals.css";

import type { Metadata } from "next";
import type { ReactNode } from "react";

export const metadata: Metadata = {
  title: "Delegate",
  description: "Turns a company's goals into finished, verified work.",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body className="min-h-dvh antialiased">{children}</body>
    </html>
  );
}
