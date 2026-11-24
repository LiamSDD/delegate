import Link from "next/link";

import { CommandPaletteButton } from "@/components/command-palette";
import { Monogram } from "@/components/monogram";
import { NavLinks } from "@/components/nav-links";
import { ThemeToggle } from "@/components/theme-toggle";

export function SiteHeader() {
  return (
    <header className="sticky top-0 z-40 border-b border-border bg-bg/85 backdrop-blur-md supports-[backdrop-filter]:bg-bg/70">
      <div className="mx-auto flex h-14 max-w-content items-center gap-6 px-6">
        <Link href="/" className="flex items-center gap-2 rounded-sm" aria-label="Delegate, home">
          <Monogram />
          <span className="font-serif text-xl leading-none tracking-display">Delegate</span>
        </Link>
        <nav aria-label="Primary" className="hidden md:block">
          <NavLinks />
        </nav>
        <div className="ml-auto flex items-center gap-2">
          <CommandPaletteButton />
          <ThemeToggle />
        </div>
      </div>
      <nav aria-label="Primary" className="border-t border-border px-4 md:hidden">
        <NavLinks className="h-11 overflow-x-auto" placement="row" />
      </nav>
    </header>
  );
}
