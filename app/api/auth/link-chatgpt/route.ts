import { linkChatGPTIdentity } from "@/lib/server/auth";
import { authFailure, authJson, requireSameOrigin } from "@/lib/server/auth-http";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const result = await linkChatGPTIdentity();
    return authJson(result, { "Set-Cookie": "chathub_link_intent=; Path=/api/auth/link-chatgpt; HttpOnly; Secure; SameSite=Lax; Max-Age=0" });
  } catch (error) { return authFailure(error); }
}
