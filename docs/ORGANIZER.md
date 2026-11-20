# Inbox organizer

Only Inbox accepts new messages and commands. One existing private space is adopted without modifying its messages. Other existing spaces remain readable saved spaces. Type spaces are created on the first move. User content is not translated; interface strings are English.

- `/move all` sends each message to a single destination: attachment MIME type first (video, image, other file), then HTTP(S) links in text/caption. Plain text stays in Inbox.
- `/move video`, `/move pic` or `/move picture`, `/move url` or `/move web`, `/move file` move whole matching messages. A mixed image/link retains both automatic type labels, whichever destination is requested.
- `/clear` previews a snapshot. Confirmation deletes only those Inbox messages and their attachment records. New arrivals and all other spaces are excluded. The dialog offers sorting first, then a separate confirmation of what remains.
- `/search keywords` opens in-place search across authorized spaces. Keywords match saved text, captions, filenames, URLs and tags; media contents are not AI indexed. Type and custom-tag filters are available without additional command syntax. Results page in batches of 50.
- Captions are optional (2,000 characters). Up to 20 comma-separated custom tags, 40 characters each, are trimmed, case-normalized and editable per item. Clicking a tag searches across spaces.
- Files of any MIME type up to 10 MB can be stored. Downloads require membership and use attachment disposition with nosniff; uploaded HTML is not served inline.

## Data safety

Organizer tables are created idempotently at runtime on the existing D1 binding; the existing user, message, membership and attachment tables are retained. Actions are scoped to the authenticated user's Inbox. Confirmation tokens expire in 5 minutes. Batches include a unique execution receipt and snapshot guard so duplicate requests cannot repeat a clear or move. Stale overlapping actions abort atomically. Message IDs, timestamps, annotation records and R2 object keys survive moves.

On clearing, an R2 deletion queue is committed with database changes. Object deletion happens afterward and failed deletions remain queued for retry on the next command. Deleted content immediately becomes unavailable through the attachment API. Very large previews take the first 1,000 matching items per command, show the remaining count, and can be repeated without getting stuck.

Account merges retain existing conversations and their annotations. The retained account keeps its Inbox/type mapping; source spaces remain accessible through inherited membership as saved spaces. No content is silently combined or deleted.

## Validation

`node --test tests/organizer.test.mjs tests/chat-sync.test.mjs` exercises the production command/search functions on Miniflare with real D1 and R2, plus synchronization scheduling. It covers legacy adoption, aliases, mixed types, upload metadata, private search, authorization, moves, duplicate confirmation, stale confirmation rollback, snapshot clear, bytes deletion, pagination and multi-chunk actions. Account tests remain `npm run test:auth`.

Browser checks use a temporary, synthetic fixture, removed before packaging: English desktop and 390px embedded viewport, command picker, clear → sort first → remaining preview, read-only type spaces, caption editing and cross-space search. These are UI checks; Worker tests validate actual database/storage behavior separately.

## Upload regression verification

Vinext checks multipart POST bodies against experimental.serverActions.bodySizeLimit before dispatching API handlers. The default 1 MB caused production 413 responses for approximately 2 MB attachments. The framework limit is now 12 MB to allow multipart overhead; the application still enforces a 10 MB file cap.

Run node --test tests/upload.test.mjs after building. It tests the actual built Worker with authenticated multipart HTTP requests and real D1/R2: 2 MB and 10 MB succeed; 11 MB is rejected by the file validator. Client transport tests cover progress, saving, confirmed success, plain-text 413, gateway errors and network failure.

A separate temporary mobile UI fixture verifies long filenames at 390 px without horizontal overflow, upload feedback, preserved input after failure and successful retry. The screenshot uses synthetic preview data. The fixture is removed before publication.
