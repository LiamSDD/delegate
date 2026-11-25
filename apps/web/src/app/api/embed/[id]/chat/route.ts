import { handleAssistantChat } from "@/server/chat";
import { chatDeps } from "@/server/chat-deps";

export const maxDuration = 120;

export async function POST(request: Request, context: RouteContext<"/api/embed/[id]/chat">) {
  const { id } = await context.params;
  return handleAssistantChat(request, id, "public", chatDeps());
}
