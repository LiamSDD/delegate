"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import { NAV_ITEMS } from "@/lib/site";
import { cn } from "@/lib/utils";

const INDICATOR = {
  header: "after:-bottom-[13px]",
  row: "after:-bottom-[6px]",
} as const;

export function NavLinks({
  className,
  placement = "header",
}: {
  className?: string;
  placement?: keyof typeof INDICATOR;
}) {
  const pathname = usePathname();
  return (
    <ul className={cn("flex items-center gap-1", className)}>
      {NAV_ITEMS.map((item) => {
        const current = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <li key={item.href}>
            <Link
              href={item.href}
              aria-current={current ? "page" : undefined}
              className={cn(
                "relative inline-flex h-8 items-center rounded-md px-2.5 text-sm text-text-muted transition-colors hover:text-text",
                current && [
                  "text-text after:absolute after:inset-x-2.5 after:h-px after:bg-text",
                  INDICATOR[placement],
                ],
              )}
            >
              {item.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}
