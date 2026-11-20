import { passkeyRegistrationOptions } from "@/lib/server/auth";

export async function POST() {
  try { return Response.json(await passkeyRegistrationOptions()); }
  catch { return Response.json({ error: "Sign in before adding a Passkey." }, { status: 401 }); }
}
