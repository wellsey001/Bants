<img src="assets/icon.png" width="96" alt="Bants logo">

# Bants server

Self-hosted backend for **Bants**, a WhatsApp-style messaging app. It runs as one small Docker container on Unraid and has **no npm dependencies**. It uses Node 22's built-in SQLite, HTTP server and crypto.

**Features:** accounts, usernames and friend codes, contact requests, 1:1 and group chats, real-time delivery over WebSocket, typing indicators, delivered/read receipts, online/last seen, photos/videos/files/voice notes, replies and reactions, GIFs and stickers, @mentions, link previews, disappearing messages, pinned and archived chats, message search, edit and delete for everyone, blocking, Android push notifications via Firebase, and an admin page.

> Messages are stored unencrypted in the database on your server (`/data/bants.db`). Traffic is encrypted in transit by HTTPS through Cloudflare Tunnel.

---

## 1. Put it on GitHub

1. The code lives at [wellsey001/Bants](https://github.com/wellsey001/Bants).
2. The **Build Docker image** action runs the tests, then publishes `ghcr.io/wellsey001/bants:latest`.
3. On GitHub, go to **your profile → Packages → bants → Package settings** and set visibility to **Public**. This lets Unraid pull the image without logging in. You can keep the repo itself private.

## 2. Run it on Unraid

**Option A: Docker Compose (recommended)**
1. Install the **Docker Compose Manager** plugin from Community Applications if you don't have it.
2. On the Docker tab, under Compose, click **Add New Stack** and name it `bants`.
3. Click the stack's cog → **Edit Stack** → **Compose File**, and paste in `compose.yml` from this repo.
4. Click the cog → **Edit Stack** → **ENV**, and paste `.env.example` with your own invite code.
5. Click **Compose Up**. Use **Update Stack** later to pull new versions.

From the Unraid terminal instead: put `compose.yml` and a `.env` in a folder, then run `docker compose up -d`.

To build from source on the server instead of pulling the image, swap `image:` for the `build:` line in `compose.yml` and run `docker compose up -d --build`.

**Option B: Unraid template**
1. Copy `unraid/bants-server.xml` to `/boot/config/plugins/dockerMan/templates-user/` on your Unraid flash drive.
2. In **Docker → Add Container**, choose **bants-server** from the Template dropdown.
3. Set an **Invite code**, then click **Apply**.

Check it's running by opening `http://YOUR-UNRAID-IP:42069/api/health`, which should show `{"ok":true}`.

Data is stored in `/mnt/user/appdata/bants-server`, which holds the database and a `media/` folder. Include it in your appdata backups.

## 3. Make it reachable outside your home (Cloudflare Tunnel)

1. In Cloudflare Zero Trust, go to **Networks → Tunnels** and create a tunnel. Install the `cloudflared` container on Unraid using the token it gives you.
2. Add a **Public hostname**, for example `chat.yourdomain.com`, pointing to **Service: HTTP**, `YOUR-UNRAID-IP:42069`.
3. WebSockets work through tunnels by default. The app then uses `https://chat.yourdomain.com` and `wss://chat.yourdomain.com/ws`.

## 4. Push notifications (optional, do this once the app exists)

1. Create a Firebase project and add an Android app with your app's package name.
2. Go to **Project settings → Service accounts → Generate new private key**, which downloads a JSON file.
3. Put the file at `/mnt/user/appdata/bants-server/firebase-service-account.json`.
4. Set the container variable `FCM_SERVICE_ACCOUNT=/data/firebase-service-account.json` and restart the container.

The server only sends a push when the user has no live WebSocket connection, which usually means the app is closed or in the background. Pushes are data-only, so the app decides how to show the notification.

## 5. GIFs (optional)

1. Sign up at [developers.giphy.com](https://developers.giphy.com), go to **Create an App**, choose **API** and copy the key.
2. Add `GIPHY_API_KEY=your-key` to the stack's ENV and click **Update Stack**.

The server talks to Giphy for the phones, so the key never leaves Unraid. Set `GIF_RATING` to `g`, `pg` or `pg-13` if `r` is too much.

## 6. Calls

Voice and video calls go straight between the two phones when they can. When they can't (very common on mobile data), the audio and video is relayed through **coturn**, which runs next to Bants in the same compose stack. Cloudflare Tunnel can't carry it, so it needs its own way in:

1. **Make a secret.** In the Unraid terminal run `openssl rand -hex 32` and copy the result.
2. **Add a DNS record.** In Cloudflare, add an `A` record named `turn` pointing at your home's public IP, with **Proxy status: DNS only** (grey cloud). If your home IP changes, run a DDNS updater (for example the `favonia/cloudflare-ddns` container) to keep it current.
3. **Forward ports on your router** to your Unraid server's LAN IP:
   - `3478` UDP and TCP
   - `49160–49200` UDP
4. **Update the stack.** Paste the latest `compose.yml` (it now includes the `coturn` service), then add to the stack's ENV:
   ```
   TURN_SECRET=the-secret-from-step-1
   TURN_HOST=turn.yourdomain.com
   ```
   Click **Update Stack**.
5. **Check it.** The admin page should show **Call relay: On**.

If your internet provider uses CGNAT (your router's WAN IP doesn't match what whatismyip.com shows), port forwarding won't work, and calls will only connect when the phones can reach each other directly.

## Admin page

Open `https://your-domain/admin` and log in with your Bants account. The first account made on the server is the admin, and admins can make others admins too.

From the admin page you can:
- See how many people, chats, messages and files the server has
- Turn sign-ups on or off and change the invite code (this overrides the container's settings)
- Reset someone's password (you get a temporary one to send them)
- Make or remove admins
- Delete accounts

## Settings

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `42069` | Port to listen on |
| `DATA_DIR` | `/data` | Database and media location |
| `INVITE_CODE` | *(blank)* | If set, required to register |
| `ALLOW_REGISTRATION` | `true` | `false` closes sign-ups |
| `MAX_UPLOAD_MB` | `50` | Upload size limit |
| `FCM_SERVICE_ACCOUNT` | *(blank)* | Firebase JSON path; push is off if blank |
| `GIPHY_API_KEY` | *(blank)* | Giphy key; GIF search is off if blank |
| `GIF_RATING` | `r` | Giphy rating: `g`, `pg`, `pg-13` or `r` |
| `TURN_SECRET` | *(blank)* | Shared secret with coturn, for calls |
| `TURN_HOST` | *(blank)* | Public hostname for coturn, e.g. `turn.yourdomain.com` |
| `TURN_PORT` | `3478` | coturn's port |
| `TRUST_PROXY` | `true` | Read real client IPs from Cloudflare headers |
| `LOG_REQUESTS` | `false` | Log every HTTP request |

## Running locally / tests

```
npm start          # needs Node 22.5+
npm test           # spins up a temp server and runs 28 end-to-end checks
```

---

# API reference

Every request except register, login, health and server info needs the header `Authorization: Bearer <token>`. You can also pass `?token=` in the URL, which is handy for image loaders. Errors look like `{ "error": "message", "code": "optional_code" }`.

### Auth
| | |
|---|---|
| `POST /api/auth/register` | `{ username, password, displayName?, inviteCode?, deviceName? }` → `{ token, user }` |
| `POST /api/auth/login` | `{ username, password, deviceName? }` → `{ token, user }` |
| `POST /api/auth/logout` | Ends this device's session |
| `GET /api/server` | `{ registration: "open" \| "invite" \| "closed", maxUploadBytes }`, which lets the app show or hide the invite field |

Usernames are 3–24 characters long, using letters, numbers, `_` and `.`. They're case-insensitive. Passwords must be at least 8 characters.

### Me
| | |
|---|---|
| `GET /api/me` | Your profile, including `friendCode` (e.g. `K7QX-M2PA`) |
| `PATCH /api/me` | `{ displayName?, about?, avatar?: mediaId \| null }` |
| `POST /api/me/password` | `{ currentPassword, newPassword }`, which signs out other devices |
| `POST /api/me/friend-code/reset` | Get a new friend code. The old one stops working. |
| `POST /api/me/push-token` | `{ token }` is the FCM token for this device; send `null` to clear it |
| `DELETE /api/me` | `{ password }` deletes the account |

### Finding people and contacts
| | |
|---|---|
| `GET /api/users/lookup?username=bob` or `?friendCode=K7QX-M2PA` | Exact match only. Nobody can browse the user list. |
| `GET /api/users/:id` | Public profile |
| `POST /api/contacts/requests` | `{ username }` sends a request the other person must accept. `{ friendCode }` connects straight away, because having someone's code means they shared it with you. Returns `{ status: "requested" \| "accepted", ... }`. |
| `GET /api/contacts/requests` | `{ incoming: [...], outgoing: [...] }` |
| `POST /api/contacts/requests/:id/accept` | Returns the new contact and their 1:1 conversation |
| `POST /api/contacts/requests/:id/decline` | Declines an incoming request or cancels your own |
| `GET /api/contacts` / `DELETE /api/contacts/:userId` | List or remove contacts |
| `GET /api/blocks`, `POST /api/blocks/:userId`, `DELETE /api/blocks/:userId` | Block list |

Friend codes ignore case, spaces and dashes, so `k7qx m2pa` works. Online status and last seen are only visible to contacts.

### Conversations
| | |
|---|---|
| `GET /api/conversations` | All chats, newest first, each with `lastMessage`, `unreadCount`, `members` and `muted` |
| `POST /api/conversations` | `{ type: "direct", userId }` or `{ type: "group", name, memberIds, avatar? }` |
| `GET /api/conversations/:id` | One chat |
| `PATCH /api/conversations/:id` | `{ muted }` (anyone), or `{ name, avatar }` (group admins) |
| `PATCH /api/conversations/:id` | Also takes `{ pinned, archived }` (just for you) and `{ disappearAfter: 0 \| 86400 \| 604800 \| 7776000 }` (seconds; admins only in groups) |
| `POST /api/conversations/:id/members` | `{ userIds }`, admins only |
| `DELETE /api/conversations/:id/members/:userId` | Remove someone (admin), or use your own id to leave |
| `POST /api/conversations/:id/admins/:userId` | `{ admin: true \| false }` |

### Messages
| | |
|---|---|
| `GET /api/conversations/:id/messages?before=ID&limit=50` | Older history, returned oldest→newest |
| `GET /api/conversations/:id/messages?after=ID` | Newer messages |
| `POST /api/conversations/:id/messages` | `{ clientId, body?, media?, replyTo? }` |
| `PATCH /api/messages/:id` | `{ body }`. Edits work for 15 minutes on text messages only. |
| `DELETE /api/messages/:id` | Unsend: removes your message for everyone, leaving no placeholder. Its text and attachment are wiped from the server. Connected phones get `message.removed` (with `unsent: true`); offline ones get an `unsend` push to clear any notification, and `GET …/messages?after=…&knownFrom=…` returns `removed` ids when they catch up. |
| `POST /api/messages/:id/react` | `{ emoji }`. Each person can have one reaction per message; sending the same emoji again removes it. |
| `POST /api/conversations/:id/receipts` | `{ delivered?: messageId, read?: messageId }` |
| `GET /api/sync?since=ID` | Everything new across all chats. Call this after reconnecting. |
| `GET /api/search?q=text` | Up to 60 matching messages across your chats, newest first |
| `GET /api/gifs?q=&offset=` | Giphy trending (no `q`) or search: `{ gifs: [{ id, title, preview, url, width, height }], nextOffset }` |
| `POST /api/conversations/:id/gif` | `{ url, clientId, replyTo? }` with a GIF's `url`. The server downloads it and sends it as a picture. |
| `GET /api/stickers`, `POST /api/stickers { media }`, `DELETE /api/stickers/:id` | Your sticker collection. Send one with `{ media, kind: "sticker" }`. |

**Mentions:** writing `@username` in a group records it in `meta.mentions`, and that person gets a push even if they muted the chat.

**Link previews:** the first link in a text message gets a preview a moment after sending (`meta.preview: { url, title, description, siteName, image }`), delivered as `message.updated`. The server refuses to fetch anything on your home network.

**Disappearing messages:** messages sent while a timer is on carry `expiresAt`. When it passes, the server deletes them and sends `message.removed { conversationId, ids }`.

`clientId` is a random ID the app generates, such as a UUID. If a send is retried with the same `clientId`, the server returns the original message instead of creating a duplicate.

Message object: `{ id, conversationId, senderId, clientId, kind: text|image|video|audio|file|system, body, media, mediaInfo: { mime, size, filename }, replyTo, reactions: [{ emoji, userIds }], createdAt, editedAt, deleted }`.

**Ticks:** each member has `lastDelivered` and `lastRead` message IDs. A message from you is ✓ when the server returns it, ✓✓ when every other member's `lastDelivered` ≥ its ID, and blue ✓✓ when every other member's `lastRead` ≥ its ID.

### Media
| | |
|---|---|
| `POST /api/media` | Raw file body with `Content-Type: image/jpeg` (etc.) and an optional `X-Filename` header → `{ id, mime, size }`. Then send a message with `media: id`. |
| `GET /api/media/:id` | Download. Supports `Range` for video seeking. Only chat members can download. |

---

## WebSocket: `wss://host/ws?token=<token>`

You can use an `Authorization` header instead of the query string. The server sends a ping every 30 seconds; standard WebSocket clients such as OkHttp answer it automatically.

**Server → app**
| `type` | Fields |
|---|---|
| `ready` | `user`, sent on connect. Call `/api/sync` now to catch up. |
| `message.new` | `message` |
| `message.updated` | `message`, for edits and deletes |
| `message.ack` | `clientId`, `message`, a reply to your `message.send` |
| `receipt` | `conversationId, userId, lastDelivered, lastRead` |
| `typing` | `conversationId, userId, typing` |
| `presence` | `userId, online, lastSeen` |
| `conversation.updated` / `conversation.removed` | `conversation` / `conversationId` |
| `contact.request` / `contact.request.removed` / `contact.added` | Request or contact details |
| `user.updated` | `user`, when a contact changes their name or picture |
| `message.removed` | `conversationId, ids`: disappearing messages that have expired |
| `error` | `error, code, clientId?` |

**App → server**
```json
{ "type": "message.send", "conversationId": 1, "clientId": "uuid", "body": "hi" }
{ "type": "typing", "conversationId": 1, "typing": true }
{ "type": "receipt", "conversationId": 1, "delivered": 42, "read": 42 }
{ "type": "ping" }
```

### Calls (1:1, over the same WebSocket)

| App → server | Server → app |
|---|---|
| `call.start { conversationId, video }` | `call.started { call }` to the caller; `call.incoming { call, caller }` to the other person (plus a push with `type: "call"`) |
| `call.accept { callId }` | `call.accepted { call }` to the caller; `call.joined` back; other ringing phones get `call.ended { reason: "answered_elsewhere" }` |
| `call.decline { callId }` | `call.ended { reason: "declined" }` |
| `call.end { callId }` | `call.ended { reason: "hangup" \| "cancelled" }` |
| `call.signal { callId, data }` | `call.signal { callId, data }` relayed to the other phone (SDP offers/answers and ICE candidates) |

Unanswered calls end after 40 seconds (`reason: "missed"`). Every call leaves a line in the chat ("📞 Voice call · 3:12", "Missed video call"). `GET /api/calls/ice` gives STUN/TURN servers with 12-hour coturn credentials; `GET /api/calls/:id` checks whether a call is still ringing.

**Push payload** (FCM data message): `type: "message"` with `conversationId, conversationType, conversationName, messageId, senderId, senderName, kind, body`, or `type: "contact_request"` or `type: "contact_accepted"`.
