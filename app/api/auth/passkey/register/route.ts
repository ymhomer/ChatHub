import { verifyPasskeyRegistration } from "@/lib/server/auth";

export async function POST(request: Request) {
  try {
    const { challengeId, response, label } = await request.json() as { challengeId?: string; response?: Parameters<typeof verifyPasskeyRegistration>[1]; label?: string };
    if (!challengeId || !response) return Response.json({ error: "Incomplete Passkey response." }, { status: 400 });
    await verifyPasskeyRegistration(challengeId, response, String(label ?? "Passkey"));
    return Response.json({ ok: true });
  } catch { return Response.json({ error: "Passkey registration did not finish. Please retry." }, { status: 400 }); }
}
