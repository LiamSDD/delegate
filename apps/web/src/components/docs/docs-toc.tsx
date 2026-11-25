"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

export interface TocHeading {
  id: string;
  text: string;
  depth: number;
}

const ACTIVATION_OFFSET_PX = 32;

function headerOffset(): number {
  const header = document.querySelector<HTMLElement>("body > header");
  return (header?.getBoundingClientRect().height ?? 0) + ACTIVATION_OFFSET_PX;
}

function currentHeading(headings: readonly TocHeading[]): string | null {
  const line = headerOffset();
  let current: string | null = null;
  for (const heading of headings) {
    const element = document.getElementById(heading.id);
    if (element === null) continue;
    if (element.getBoundingClientRect().top - line > 1) break;
    current = heading.id;
  }
  const atEnd =
    window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2 &&
    window.scrollY > 0;
  return atEnd ? (headings.at(-1)?.id ?? current) : current;
}

export function DocsToc({ headings }: { headings: readonly TocHeading[] }) {
  const [active, setActive] = useState<string | null>(null);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      setActive(currentHeading(headings));
    };
    const schedule = () => {
      if (frame === 0) frame = requestAnimationFrame(update);
    };
    schedule();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule, { passive: true });
    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, [headings]);

  return (
    <nav aria-label="On this page" className="flex flex-col gap-3">
      <p className="font-mono text-2xs tracking-label text-text-subtle uppercase">On this page</p>
      <ul className="border-l border-border">
        {headings.map((heading) => {
          const current = heading.id === active;
          return (
            <li key={heading.id}>
              <a
                href={`#${encodeURIComponent(heading.id)}`}
                aria-current={current ? "location" : undefined}
                className={cn(
                  "-ml-px block border-l py-1 pr-1 text-sm leading-5 transition-colors",
                  heading.depth > 2 ? "pl-6" : "pl-3.5",
                  current
                    ? "border-text text-text"
                    : "border-transparent text-text-muted hover:border-border-strong hover:text-text",
                )}
              >
                {heading.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
