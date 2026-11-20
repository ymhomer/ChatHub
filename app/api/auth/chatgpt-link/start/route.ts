import { authRateAllowed, beginChatGPTLink } from "@/lib/server/auth";
import { authFailure, authJson, requireSameOrigin } from "@/lib/server/auth-http";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    if (!(await authRateAllowed(request, "start-chatgpt-link", 10))) return Response.json({ error: "Too many attempts. Please try again later." }, { status: 429 });
    const result = await beginChatGPTLink();
    return authJson({ ready: true }, { "Set-Cookie": result.cookie });
  } catch (error) { return authFailure(error); }
}
