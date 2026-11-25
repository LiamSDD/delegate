import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";

import { AssistantWorkspace } from "@/components/agents/assistant-workspace";
import { requestOrigin } from "@/lib/agents/embed";
import { assistantStores, ensureLoaded, findAssistant } from "@/server/assistants";
import { OWNER_QUESTION_MAX } from "@/server/chat";
import { currentGuest } from "@/server/page-session";

export const metadata: Metadata = { title: "Assistant" };

export default async function AssistantPage({ params }: PageProps<"/agents/[id]">) {
  const { id } = await params;
  const guest = await currentGuest();
  if (guest === null) notFound();
  const view = await findAssistant(guest.app, guest.session.userId, id);
  if (view === null) notFound();
  await ensureLoaded(assistantStores(), view);
  return (
    <AssistantWorkspace
      key={view.assistant.id}
      assistant={view.assistant}
      evals={view.evals}
      gaps={view.gaps}
      runId={view.runId}
      runFinished={view.runStatus === "completed" || view.runStatus === "failed"}
      origin={requestOrigin(await headers())}
      maxQuestion={OWNER_QUESTION_MAX}
    />
  );
}
