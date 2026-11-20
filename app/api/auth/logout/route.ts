import { cookies } from "next/headers";
import { eq } from "drizzle-orm";
import { authSessions } from "@/db/schema";
import { getDb } from "@/db";
import { ensureAuthSchema } from "@/lib/server/auth";
import { clearSessionCookie } from "@/lib/server/auth";

export async function POST() {
  await ensureAuthSchema();
  const token = (await cookies()).get("chathub_session")?.value;
  if (token) {
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)));
    const tokenHash = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    await getDb().delete(authSessions).where(eq(authSessions.tokenHash, tokenHash));
  }
  return Response.json({ ok: true }, { headers: { "Set-Cookie": clearSessionCookie() } });
}
