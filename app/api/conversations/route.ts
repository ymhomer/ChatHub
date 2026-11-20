import { createPrivateSpace, listConversations, requireAppUser } from "@/lib/server/chat";

export async function GET() {
  try { const user = await requireAppUser(); return Response.json({ conversations: await listConversations(user.id) }, { headers: { "Cache-Control": "private, no-store" } }); }
  catch { return Response.json({ error: "Please sign in." }, { status: 401 }); }
}

export async function POST() {
  try {
    const user = await requireAppUser();
    await createPrivateSpace(user.id);
    return Response.json({ conversations: await listConversations(user.id) }, { status: 201 });
  } catch { return Response.json({ error: "Unable to open Inbox." }, { status: 400 }); }
}
