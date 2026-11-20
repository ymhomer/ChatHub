export type FriendRequest = { id: string; name: string; incoming: boolean };
export type DirectChat = {
  id: string; name: string; unread: number;
  latestId: string | null; latestSender: string | null; summary: string | null;
};
export type SocialState = { code: string; requests: FriendRequest[]; chats: DirectChat[] };
