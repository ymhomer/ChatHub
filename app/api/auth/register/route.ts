import { authRateAllowed, registerEmail } from "@/lib/server/auth";

export async function POST(request: Request) {
  try {
    if (!(await authRateAllowed(request, "register", 5))) return Response.json({ error: "Too many attempts. Please try again later." }, { status: 429 });
    const { email, password } = await request.json() as { email?: string; password?: string };
    if (!email || !password) return Response.json({ error: "Enter your email and password." }, { status: 400 });
    const result = await registerEmail(email, password);
    return Response.json({ user: result.user, recoveryCodes: result.recoveryCodes }, { status: 201, headers: { "Set-Cookie": result.session.cookie } });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    const message = reason === "EMAIL_EXISTS" ? "This email is registered. Please sign in." : reason === "INVALID_EMAIL" ? "Enter a valid email address." : reason === "INVALID_PASSWORD" ? "Use a password with 12 to 128 characters." : "Unable to create an account right now. Try again later.";
    return Response.json({ error: message }, { status: reason === "EMAIL_EXISTS" ? 409 : 400 });
  }
}
