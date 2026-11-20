import { authMethods, getAppUser } from "@/lib/server/auth";

export async function GET() {
  try {
    const user = await getAppUser();
    if (!user) return Response.json({ signedIn: false });
    const methods = await authMethods();
    return Response.json({ signedIn: true, user, auth: { email: methods.email, hasPassword: methods.hasPassword, chatgptLinked: methods.chatgptLinked, passkeyCount: methods.passkeys.length } });
  } catch (error) {
    if (error instanceof Error && error.message === "ACCOUNT_LINK_REQUIRED") return Response.json({ signedIn: false, linkRequired: true, error: "This email is registered. Sign in with email, then link ChatGPT in account settings." });
    return Response.json({ signedIn: false });
  }
}
