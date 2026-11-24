import { Monogram } from "@/components/monogram";
import { APP_VERSION, DOCS_URL, REPO_URL, repoFileUrl } from "@/lib/site";
import { CURRENT_MILESTONE, milestoneById } from "@/lib/roadmap";

const LINKS = [
  { href: REPO_URL, label: "GitHub" },
  { href: DOCS_URL, label: "Docs" },
  { href: repoFileUrl("docs/ARCHITECTURE.md"), label: "Architecture" },
  { href: repoFileUrl("docs/SECURITY.md"), label: "Security" },
] as const;

export function SiteFooter() {
  const milestone = milestoneById(CURRENT_MILESTONE);
  return (
    <footer data-print="hide" className="border-t border-border">
      <div className="mx-auto grid max-w-content gap-6 px-6 py-8 text-sm text-text-muted md:grid-cols-[1fr_auto_1fr] md:items-center">
        <div className="flex items-center gap-2">
          <Monogram className="size-4" />
          <span className="font-serif text-md leading-none text-text">Delegate</span>
          <span className="font-mono text-xs text-text-subtle tabular">
            v{APP_VERSION} · {milestone.id} {milestone.title}
          </span>
        </div>
        <p className="font-mono text-xs">
          <span className="text-text">$0</span> · keyless by default
        </p>
        <ul className="flex flex-wrap gap-x-5 gap-y-2 md:justify-end">
          {LINKS.map((link) => (
            <li key={link.label}>
              <a
                href={link.href}
                target="_blank"
                rel="noreferrer"
                className="underline-offset-4 transition-colors hover:text-text hover:underline"
              >
                {link.label}
              </a>
            </li>
          ))}
        </ul>
      </div>
    </footer>
  );
}
