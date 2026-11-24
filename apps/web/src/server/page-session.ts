import { cookies } from "next/headers";

import { type AppDatabase, getAppDatabase } from "./db";
import { readGuest, SESSION_COOKIE, type GuestSession, sessionSecret } from "./session";

export async function currentGuest(): Promise<{ app: AppDatabase; session: GuestSession } | null> {
  const store = await cookies();
  const value = store.get(SESSION_COOKIE)?.value;
  if (value === undefined) return null;
  const app = await getAppDatabase();
  const session = await readGuest(app, value, sessionSecret());
  return session === null ? null : { app, session };
}
