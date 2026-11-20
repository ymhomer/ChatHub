export async function POST() {
  return Response.json({ error: "The sign-in flow changed. Refresh account settings and choose Add email sign-in." }, { status: 410, headers: { "Cache-Control": "no-store" } });
}
