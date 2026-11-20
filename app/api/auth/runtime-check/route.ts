import { checkPasswordRuntime, authRateAllowed } from "@/lib/server/auth";
import { authFailure } from "@/lib/server/auth-http";
export async function GET(request: Request) {
  try {
    if (!(await authRateAllowed(request, "runtime-check", 2, 60000))) return Response.json({ ready: false }, {status:429});
    return Response.json({ ready: await checkPasswordRuntime() }, {headers:{"Cache-Control":"no-store"}});
  } catch(error) { return authFailure(error); }
}
