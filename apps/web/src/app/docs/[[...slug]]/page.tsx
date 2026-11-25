import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";

import { DocPage } from "@/components/docs/doc-page";
import { SECTION_REDIRECTS } from "@/lib/docs/manifest";
import { docRoute, docsRegistry, loadDoc } from "@/lib/docs/registry";

export function generateStaticParams(): { slug: string[] }[] {
  return docsRegistry().entries.map((entry) => ({ slug: [...entry.slug] }));
}

export async function generateMetadata({
  params,
}: PageProps<"/docs/[[...slug]]">): Promise<Metadata> {
  const { slug = [] } = await params;
  const entry = docsRegistry().bySlug(slug);
  if (entry === undefined) return { title: "Docs" };
  const doc = loadDoc(entry);
  return {
    title: entry.slug.length === 0 ? "Docs" : `${doc.title} · Docs`,
    description: entry.summary,
    alternates: { canonical: entry.route },
  };
}

export default async function DocsRoute({ params }: PageProps<"/docs/[[...slug]]">) {
  const { slug = [] } = await params;
  const registry = docsRegistry();
  const entry = registry.bySlug(slug);
  if (entry === undefined) {
    const section = slug.length === 1 ? SECTION_REDIRECTS[slug[0] ?? ""] : undefined;
    if (section !== undefined) redirect(docRoute(section));
    notFound();
  }
  return <DocPage doc={loadDoc(entry)} registry={registry} />;
}
