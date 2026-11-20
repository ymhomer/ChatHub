import { authRateAllowed, loginEmail } from "@/lib/server/auth";

export async function POST(request: Request) {
  try {
    if (!(await authRateAllowed(request, "login", 10))) return Response.json({ error: "Too many attempts. Try again in 15 minutes." }, { status: 429 });
    const { email, password } = await request.json() as { email?: string; password?: string };
    if (!email || !password) return Response.json({ error: "Enter your email and password." }, { status: 400 });
    const result = await loginEmail(email, password);
    return Response.json({ user: result.user }, { headers: { "Set-Cookie": result.session.cookie } });
  } catch {
    return Response.json({ error: "Incorrect email or password." }, { status: 401 });
  }
}
