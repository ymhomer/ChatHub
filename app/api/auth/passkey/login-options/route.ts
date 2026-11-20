import { authRateAllowed, passkeyAuthenticationOptions } from "@/lib/server/auth";

export async function POST(request: Request) {
  try { if (!(await authRateAllowed(request, "passkey-login", 10))) return Response.json({ error: "Too many attempts. Please try again later." }, { status: 429 }); return Response.json(await passkeyAuthenticationOptions()); }
  catch { return Response.json({ error: "Unable to start Passkey sign-in." }, { status: 400 }); }
}
