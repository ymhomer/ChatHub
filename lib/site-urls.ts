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

export function backendFetch(path: string, init?: RequestInit) {
  return fetch(backendPath(path), standalone ? { ...init, credentials: "include" } : init);
}
