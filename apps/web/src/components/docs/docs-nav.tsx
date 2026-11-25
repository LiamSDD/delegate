"use client";

import { ChevronRight } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useId, useState } from "react";

import type { NavItem, NavSection } from "@/lib/docs/registry";
import { cn } from "@/lib/utils";

function normalise(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

export function findNavItem(
  sections: readonly NavSection[],
  pathname: string,
): { section: NavSection; item: NavItem; parent: NavItem | null } | null {
  const current = normalise(pathname);
  for (const section of sections)
    for (const item of section.items) {
      if (item.route === current) return { section, item, parent: null };
      const child = item.children?.find((candidate) => candidate.route === current);
      if (child !== undefined) return { section, item: child, parent: item };
    }
  return null;
}

const ITEM_CLASS =
  "-ml-px flex min-h-8 items-center border-l py-1 pr-2 pl-3.5 text-sm leading-5 transition-colors";

function itemClass(current: boolean): string {
  return cn(
    ITEM_CLASS,
    current
      ? "border-text font-medium text-text"
      : "border-transparent text-text-muted hover:border-border-strong hover:text-text",
  );
}

interface LinkHandlers {
  onClick?: () => void;
}

function NavGroup({
  item,
  pathname,
  handlers,
}: {
  item: NavItem;
  pathname: string;
  handlers: LinkHandlers;
}) {
  const children = item.children ?? [];
  const inside = pathname === item.route || children.some((child) => child.route === pathname);
  const [toggled, setToggled] = useState<{ at: string; open: boolean } | null>(null);
  const open = toggled !== null && toggled.at === pathname ? toggled.open : inside;
  const listId = useId();
  return (
    <li>
      <div className="flex items-stretch">
        <Link
          href={item.route}
          aria-current={pathname === item.route ? "page" : undefined}
          {...handlers}
          className={cn(itemClass(pathname === item.route), "flex-1")}
        >
          {item.label}
          <span className="ml-2 font-mono text-2xs font-normal text-text-subtle tabular">
            {children.length}
          </span>
        </Link>
        <button
          type="button"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={`${open ? "Hide" : "Show"} the ${item.label.toLowerCase()} list`}
          onClick={() => {
            setToggled({ at: pathname, open: !open });
          }}
          className="inline-flex w-8 items-center justify-center rounded-md text-text-subtle transition-colors hover:bg-surface-2 hover:text-text"
        >
          <ChevronRight
            className={cn("size-3.5 transition-transform", open && "rotate-90")}
            strokeWidth={1.75}
            aria-hidden="true"
          />
        </button>
      </div>
      <ul id={listId} hidden={!open} className="ml-3.5 border-l border-border">
        {children.map((child) => (
          <li key={child.route}>
            <Link
              href={child.route}
              aria-current={pathname === child.route ? "page" : undefined}
              {...handlers}
              title={child.label}
              className={cn(itemClass(pathname === child.route), "gap-2.5")}
            >
              <span className="font-mono text-2xs font-normal text-text-subtle tabular">
                {child.prefix}
              </span>
              <span className="min-w-0 truncate">{child.label}</span>
            </Link>
          </li>
        ))}
      </ul>
    </li>
  );
}

export function DocsNav({
  sections,
  onNavigate,
  label = "Documentation",
}: {
  sections: readonly NavSection[];
  onNavigate?: () => void;
  label?: string;
}) {
  const pathname = normalise(usePathname());
  const handlers: LinkHandlers = onNavigate === undefined ? {} : { onClick: onNavigate };
  return (
    <nav aria-label={label} className="flex flex-col gap-7">
      {sections.map((section) => (
        <div key={section.id} className="flex flex-col gap-2.5">
          <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">
            {section.title}
          </p>
          <ul className="border-l border-border">
            {section.items.map((item) =>
              item.children === undefined ? (
                <li key={item.route}>
                  <Link
                    href={item.route}
                    aria-current={pathname === item.route ? "page" : undefined}
                    {...handlers}
                    className={itemClass(pathname === item.route)}
                  >
                    {item.label}
                  </Link>
                </li>
              ) : (
                <NavGroup key={item.route} item={item} pathname={pathname} handlers={handlers} />
              ),
            )}
          </ul>
        </div>
      ))}
    </nav>
  );
}
