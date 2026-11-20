import { deletePasskey } from "@/lib/server/auth";

export async function DELETE(_: Request, context: { params: Promise<{ credentialId: string }> }) {
  try {
    const { credentialId } = await context.params;
    await deletePasskey(credentialId);
    return Response.json({ ok: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : "";
    return Response.json({ error: reason === "LAST_SIGNIN_METHOD" ? "Add another sign-in method before removing this Passkey." : "Unable to remove this Passkey." }, { status: 400 });
  }
}
