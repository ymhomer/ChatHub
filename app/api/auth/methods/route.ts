import { authMethods } from "@/lib/server/auth";

export async function GET() {
  try { return Response.json(await authMethods()); }
  catch { return Response.json({ error: "Please sign in." }, { status: 401 }); }
}
