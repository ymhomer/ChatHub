declare const __CHATHUB_API_ORIGIN__: string;
declare const __CHATHUB_BASE__: string;

const apiOrigin = typeof __CHATHUB_API_ORIGIN__ === "string" ? __CHATHUB_API_ORIGIN__ : "";
const base = typeof __CHATHUB_BASE__ === "string" ? __CHATHUB_BASE__ : "/";
export const standalone = Boolean(apiOrigin);

export function appPath(path: string) {
  return base + path.replace(/^\//, "");
}

export function backendPath(path: string) {
  return path.startsWith("/") ? apiOrigin + path : path;
}

const sessionKey = "chathub-pages-session";

export function sessionToken() {
  return standalone ? sessionStorage.getItem(sessionKey) : null;
}

export async function backendFetch(path: string, init?: RequestInit) {
  const url = backendPath(path);
  if (!standalone || !url.startsWith(apiOrigin + "/")) return fetch(url, init);
  const headers = new Headers(init?.headers);
  const token = sessionToken();
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(url, { ...init, headers, credentials: "omit", redirect: "error" });
  const session = response.headers.get("X-ChatHub-Session");
  if (session === "clear") sessionStorage.removeItem(sessionKey);
  else if (session) sessionStorage.setItem(sessionKey, session);
  return response;
}
