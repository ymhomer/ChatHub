import { answerFriend, inviteFriend, markChatRead, socialState } from '@/lib/server/social';
import { requireAppUser, saveChatAttachment } from '@/lib/server/chat';
import { readAuthBody, requireSameOrigin } from '@/lib/server/auth-http';

const headers = { 'Cache-Control': 'private, no-store' };

export async function GET() {
  try {
    const user = await requireAppUser();
    return Response.json(await socialState(user.id), { headers });
  } catch (error) {
    return failure(error);
  }
}

export async function POST(request: Request) {
  try {
    requireSameOrigin(request);
    const user = await requireAppUser();
    const body = await readAuthBody(request);
    switch (body.action) {
      case 'invite': await inviteFriend(user.id, body.code); break;
      case 'accept':
      case 'decline': await answerFriend(user.id, String(body.id ?? ''), body.action === 'accept'); break;
      case 'read': await markChatRead(user.id, String(body.chatId ?? ''), String(body.messageId ?? '')); break;
      case 'save': await saveChatAttachment(user.id, String(body.id ?? '')); break;
      default: return Response.json({ error: 'Invalid action.' }, { status: 400, headers });
    }
    return Response.json({ ok: true }, { headers });
  } catch (error) {
    return failure(error);
  }
}

function failure(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  if (message === 'UNAUTHENTICATED') return Response.json({ error: 'Please sign in.' }, { status: 401, headers });
  return Response.json({ error: /^(Enter a valid |This |A request )/.test(message) ? message : 'Unable to complete the request. Try again.' }, { status: 400, headers });
}
