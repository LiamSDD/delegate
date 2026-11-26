import { z } from "zod";

const errorSchema = z.object({
  error: z.object({ message: z.string(), issues: z.array(z.string()).optional() }),
});

export async function readErrorLines(response: Response): Promise<string[]> {
  const parsed = errorSchema.safeParse(await response.json().catch(() => null));
  return parsed.success
    ? [parsed.data.error.message, ...(parsed.data.error.issues ?? [])]
    : [`The server answered HTTP ${response.status}.`];
}

export async function readError(response: Response): Promise<string> {
  return (await readErrorLines(response))[0] ?? `The server answered HTTP ${response.status}.`;
}

export function postJson(url: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
