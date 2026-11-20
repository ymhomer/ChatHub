import { requireSameOrigin } from "@/lib/server/auth-http";
import { createMessage, listMessages, requireAppUser } from "@/lib/server/chat";

export async function GET(request: Request) {
  try {
    const conversationId = new URL(request.url).searchParams.get("conversation_id");
    if (!conversationId) return Response.json({ error: "conversation_id is required" }, { status: 400 });
    const user = await requireAppUser();
    return Response.json({ messages: await listMessages(user.id, conversationId) }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return Response.json({ error: error instanceof Error && error.message === "FORBIDDEN" ? "You do not have access to this space." : "Please sign in." }, { status: 401 }); }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const form = await request.formData();
    const conversationId = String(form.get("conversation_id") ?? "");
    const body = String(form.get("body") ?? "");
    const selected = form.get("file");
    const file = selected instanceof File ? selected : null;
    if (!conversationId) return Response.json({ error: "conversation_id is required" }, { status: 400 });
    const user = await requireAppUser();
    return Response.json(await createMessage(user.id, { conversationId, body, file, saveToSpace: form.get("save_to_space") === "1", caption: String(form.get("caption") ?? ""), tags: JSON.parse(String(form.get("tags") ?? "[]")) }), { status: 201 });
  } catch (error) {
    const known = error instanceof Error ? error.message : "";
    if (!["FILE_TOO_LARGE","EMPTY_MESSAGE","READ_ONLY_SPACE","USE_COMMAND_PREVIEW","TEXT_TOO_LONG","FORBIDDEN_ORIGIN"].includes(known)) {
      const safe=(text:string)=>text.split("params:")[0].replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,"[email]").slice(0,500);
      console.error("message_save_failed",{name:error instanceof Error?error.name:"unknown",message:safe(known),cause:error instanceof Error&&error.cause instanceof Error?safe(error.cause.message):""});
    }
    const message = known === "FILE_TOO_LARGE" ? "Each file must be 10 MB or smaller." : known === "EMPTY_MESSAGE" ? "Write a message or attach a file." : known === "READ_ONLY_SPACE" ? "This space is read-only. Add content in Inbox." : known === "USE_COMMAND_PREVIEW" ? "Run commands from the Inbox command menu." : known === "TEXT_TOO_LONG" ? "Message or caption is too long." : "Unable to send. Please retry.";
    return Response.json({ error: message }, { status: 400 });
  }
}
