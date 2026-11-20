import { env } from "cloudflare:workers";

const messages: Record<string, string> = {
  UNAUTHENTICATED: "Please sign in to ChatHub.",
  INVALID_EMAIL: "Enter a valid email address.",
  INVALID_PASSWORD: "Use a new password with 12 to 128 characters.",
  INVALID_LOGIN: "Incorrect email or password. Please try again.",
  EMAIL_EXISTS: "This email is registered. Go back and verify its existing password.",
  EMAIL_ALREADY_LINKED: "Email sign-in is already configured. Please refresh.",
  CHATGPT_SIGNIN_REQUIRED: "ChatGPT identity is unavailable. Please restart linking.",
  CHATGPT_ALREADY_LINKED: "Another ChatGPT identity is already linked and cannot be overwritten.",
  LINK_INTENT_REQUIRED: "The linking step expired. Choose Add ChatGPT sign-in again.",
  CHALLENGE_EXPIRED: "Verification expired or was already used. Restart the linking flow.",
  MERGE_UNSUPPORTED: "These accounts cannot be merged. Both must be active member accounts.",
  MERGE_CONFLICT: "An account already has another linked identity. Check that you signed in to the correct accounts.",
  MERGE_CHANGED: "Account details changed after verification. Verify again before merging.",
  INVALID_REQUEST: "Check your input and try again.",
  FORBIDDEN_ORIGIN: "Please perform this action from ChatHub.",
};

export function requireSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const frontend = (env as { CHATHUB_FRONTEND_ORIGIN?: string }).CHATHUB_FRONTEND_ORIGIN;
  if (!origin || (origin !== new URL(request.url).origin && origin !== frontend)) throw new Error("FORBIDDEN_ORIGIN");
}

export function authFailure(error: unknown) {
  const code = error instanceof Error ? error.message : "";
  if (!messages[code]) {
    const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : "";
    const safe = (value: string) => value.split("params:")[0].replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[email]").slice(0, 600);
    console.error("auth_unavailable", { name: error instanceof Error ? error.name : "unknown", message: safe(code), cause: safe(cause) });
  }
  const status = code === "UNAUTHENTICATED" || code === "CHATGPT_SIGNIN_REQUIRED" ? 401 : code === "FORBIDDEN_ORIGIN" ? 403 : code === "EMAIL_EXISTS" || code.startsWith("MERGE_") ? 409 : messages[code] ? 400 : 503;
  return Response.json({ code: messages[code] ? code : "UNAVAILABLE", error: messages[code] ?? "Unable to finish right now. Please try again later." }, { status, headers: { "Cache-Control": "no-store" } });
}

export function authJson(value: unknown, headers?: HeadersInit) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("Cache-Control", "no-store");
  return Response.json(value, { headers: responseHeaders });
}

export async function readAuthBody(request: Request): Promise<Record<string, unknown>> {
  let body: unknown;
  try { body = await request.json(); } catch { throw new Error("INVALID_REQUEST"); }
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("INVALID_REQUEST");
  return body as Record<string, unknown>;
}
