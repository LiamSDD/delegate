"use client";

import "@fontsource-variable/instrument-sans";
import "@fontsource/instrument-serif";
import "./globals.css";

import { themeInitScript } from "@/lib/theme";

export default function GlobalError({ retry }: { error: unknown; retry: () => void }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <title>Delegate is unavailable</title>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="flex min-h-dvh items-center bg-bg text-text">
        <main className="mx-auto flex max-w-content flex-col gap-6 px-6" role="alert">
          <p className="font-mono text-2xs tracking-label text-danger uppercase">Error</p>
          <h1 className="font-serif text-display-sm tracking-display">Delegate failed to load</h1>
          <p className="max-w-xl text-md text-text-muted">
            Something broke before the page could render. Reloading usually fixes it.
          </p>
          <button
            type="button"
            onClick={retry}
            className="inline-flex h-9 w-fit items-center rounded-md bg-accent px-4 text-sm font-medium text-accent-fg hover:bg-accent/90"
          >
            Try again
          </button>
        </main>
      </body>
    </html>
  );
}
