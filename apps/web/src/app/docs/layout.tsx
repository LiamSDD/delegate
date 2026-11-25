import type { ReactNode } from "react";

import { DocsFrame } from "@/components/docs/docs-frame";
import { docsRegistry } from "@/lib/docs/registry";

export default function DocsLayout({ children }: { children: ReactNode }) {
  return <DocsFrame sections={docsRegistry().navigation()}>{children}</DocsFrame>;
}
