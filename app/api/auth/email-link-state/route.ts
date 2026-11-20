import { authRateAllowed, emailLinkState } from "@/lib/server/auth";
import { authFailure, authJson, requireSameOrigin, readAuthBody } from "@/lib/server/auth-http";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    if (!(await authRateAllowed(request, "email-link-state", 12))) return Response.json({ error: "Too many attempts. Please try again later." }, { status: 429 });
    const { email } = await readAuthBody(request);
    if (typeof email !== "string") throw new Error("INVALID_REQUEST");
    return authJson(await emailLinkState(email));
  } catch (error) { return authFailure(error); }
}
