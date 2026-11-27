import type { Metadata } from "next";

import { EmbedChat } from "@/components/agents/embed-chat";
import { assistantStores, ensureLoaded, findAssistant } from "@/server/assistants";
import { PUBLIC_QUESTION_MAX } from "@/server/chat";
import { currentGuest } from "@/server/page-session";

export const metadata: Metadata = { title: "Assistant", robots: { index: false } };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function loadAssistant(id: string) {
  const stores = assistantStores();
  const cached = await stores.assistants.get(id);
  if (cached !== null) return cached;
  const guest = await currentGuest();
  if (guest === null) return null;
  const view = await findAssistant(guest.app, guest.session.userId, id);
  if (view === null) return null;
  await ensureLoaded(stores, view);
  return stores.assistants.get(id);
}

export default async function EmbedPage({ params, searchParams }: PageProps<"/embed/[id]">) {
  const { id } = await params;
  const widget = (await searchParams).widget === "1";
  const record = UUID.test(id) ? await loadAssistant(id) : null;
  if (record === null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm font-medium text-text">This assistant is offline</p>
        <p className="text-xs text-text-muted">
          It may have been deleted, or the server restarted and its index is being rebuilt.
        </p>
      </div>
    );
  }
  const assistant = record.config;
  return (
    <EmbedChat
      assistantId={assistant.id}
      name={assistant.name}
      host={assistant.url}
      starterQuestions={assistant.starterQuestions.slice(0, 3)}
      maxQuestion={PUBLIC_QUESTION_MAX}
      widget={widget}
    />
  );
}
