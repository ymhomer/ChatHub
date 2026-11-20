import { authRateAllowed, linkEmailCredentials } from "@/lib/server/auth";
import { authFailure, authJson, requireSameOrigin, readAuthBody } from "@/lib/server/auth-http";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    if (!(await authRateAllowed(request, "link-email", 5))) return Response.json({ error: "Too many attempts. Please try again later." }, { status: 429 });
    const { email, password } = await readAuthBody(request);
    if (typeof email !== "string" || typeof password !== "string") throw new Error("INVALID_REQUEST");
    return authJson(await linkEmailCredentials(email, password));
  } catch (error) { return authFailure(error); }
}
