import { authRateAllowed, prepareAccountMerge } from "@/lib/server/auth";
import { authFailure, authJson, requireSameOrigin, readAuthBody } from "@/lib/server/auth-http";

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    if (!(await authRateAllowed(request, "prepare-account-merge", 5))) return Response.json({ error: "Too many attempts. Please try again later." }, { status: 429 });
    const { email, password, proofId } = await readAuthBody(request);
    if (typeof email !== "string" || typeof password !== "string" || (proofId !== undefined && typeof proofId !== "string")) throw new Error("INVALID_REQUEST");
    return authJson(await prepareAccountMerge(email, password, proofId));
  } catch (error) { return authFailure(error); }
}
