import { confirmAccountMerge } from "@/lib/server/auth";
import { authFailure, authJson, requireSameOrigin, readAuthBody } from "@/lib/server/auth-http";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const { token, confirmed } = await readAuthBody(request);
    if (typeof token !== "string" || confirmed !== true) throw new Error("INVALID_REQUEST");
    const result = await confirmAccountMerge(token);
    return authJson({ merged: true }, { "Set-Cookie": result.session.cookie });
  } catch (error) { return authFailure(error); }
}
