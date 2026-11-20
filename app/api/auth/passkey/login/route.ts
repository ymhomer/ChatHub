import { verifyPasskeyAuthentication } from "@/lib/server/auth";

export async function POST(request: Request) {
  try {
    const { challengeId, response } = await request.json() as { challengeId?: string; response?: Parameters<typeof verifyPasskeyAuthentication>[1]; label?: string };
    if (!challengeId || !response) return Response.json({ error: "Incomplete Passkey response." }, { status: 400 });
    const result = await verifyPasskeyAuthentication(challengeId, response);
    return Response.json({ user: result.user }, { headers: { "Set-Cookie": result.session.cookie } });
  } catch { return Response.json({ error: "Passkey verification failed. Retry or use another sign-in method." }, { status: 401 }); }
}
