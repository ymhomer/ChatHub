export const TYPE_LABELS = { video: "Videos", picture: "Pictures", url: "Web links", file: "Files" } as const;
export type ContentType = keyof typeof TYPE_LABELS;
export const aliases: Record<string, ContentType | "all"> = { all: "all", video: "video", pic: "picture", picture: "picture", url: "url", web: "url", file: "file" };
export type ChatMessage = {
  id: string; conversationId: string; spaceTitle: string; body: string; caption: string; tags: string[];
  typeTags: ContentType[]; createdAt: string; senderId: string; senderName: string;
  canManageFile: boolean; attachmentId: string | null; filename: string | null; contentType: string | null; bytes: number | null;
};
export type Space = { id: string; title: string; kind: "default" | ContentType | "archive"; count: number; role: string };
export function contentTypes(contentType: string | null, body: string, caption = ""): ContentType[] {
  const types: ContentType[] = [];
  if (contentType) types.push(contentType.startsWith("video/") ? "video" : contentType.startsWith("image/") ? "picture" : "file");
  if (/https?:\/\/[^\s<>]+/i.test(body + " " + caption)) types.push("url");
  return types;
}
export function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 20 || value.some(t => typeof t !== "string" || t.trim().length > 40 || t.includes(","))) throw new Error("Use up to 20 tags, each at most 40 characters, without commas.");
  return [...new Set(value.map(t => t.trim().toLocaleLowerCase()).filter(Boolean))];
}
export function parseCommand(value: string) {
  const text = value.trim();
  if (!text.startsWith("/")) return null;
  if (/^\/clear$/i.test(text)) return { action: "clear" as const };
  const move = text.match(/^\/move\s+(\S+)$/i);
  if (move && aliases[move[1].toLowerCase()]) return { action: "move" as const, type: aliases[move[1].toLowerCase()] };
  const search = text.match(/^\/search(?:\s+([\s\S]*))?$/i);
  if (search) return { action: "search" as const, query: search[1]?.trim() ?? "" };
  throw new Error("Unknown command. Use /clear, /move all|video|pic|url|file, or /search keywords.");
}
export type CommandPreview = { token: string; action: "move" | "clear"; count: number; files: number; remaining: number; groups: Partial<Record<ContentType, number>> };
