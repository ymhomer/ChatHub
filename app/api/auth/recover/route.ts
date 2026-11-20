import { authRateAllowed, recoverEmailPassword } from "@/lib/server/auth";

export async function POST(request: Request) {
  try {
    if (!(await authRateAllowed(request, "recovery", 5))) return Response.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
    const { email, recoveryCode, password } = await request.json() as { email?: string; recoveryCode?: string; password?: string };
    if (!email || !recoveryCode || !password) return Response.json({ error: "Enter your email, recovery code and new password." }, { status: 400 });
    const result = await recoverEmailPassword(email, recoveryCode, password);
    return Response.json({ recoveryCodes: result.recoveryCodes }, { headers: { "Set-Cookie": result.session.cookie } });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    return Response.json({ error: reason === "INVALID_PASSWORD" ? "Use a new password with 12 to 128 characters." : "Incorrect email or recovery code." }, { status: 400 });
  }
}
