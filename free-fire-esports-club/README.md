# Free Fire Esports Club Management App

A real, full-stack Free Fire esports club management platform: authentication with 4 roles, live auction house with per-auction credit ledgers, three leaderboards, match schedules with protected room credentials, private Team Centers, real-time team chat, notifications, announcements and an audit log. Seeded with 134 users (120 players, 12 managers, a MOD and an ADMIN) and 12 teams.

## Stack

- **Backend**: Node.js + Express 4, SQLite (better-sqlite3, WAL), bcryptjs password hashing, custom session tokens (12-hour expiry, httpOnly cookie).
- **Real-time**: WebSocket (`ws`) on `/ws` — live auction bidding updates and private team chat channels.
- **Frontend**: vanilla JS single-page app served from `public/` (no build step).

## Quick start

```bash
npm install
npm run seed     # creates ./data/ffclub.db with demo data
npm start        # http://localhost:3000
```

Environment variables:

| Variable       | Default   | Purpose                          |
| -------------- | --------- | -------------------------------- |
| `PORT`         | `3000`    | HTTP port                        |
| `FF_DATA_DIR`  | `./data`  | Directory for the SQLite database|

## Default accounts (from seed)

| Role    | Username      | Password     |
| ------- | ------------- | ------------ |
| ADMIN   | `admin`       | `admin123`   |
| MOD     | `mod`         | `mod123`     |
| MANAGER | `manager1` … `manager12` | `manager123` |
| PLAYER  | `player001` … `player120` | `player123` |

Change these passwords before any real deployment.

## Features

### Roles & permissions
- **ADMIN** — full control: users, teams, registrations, auctions, bidding, matches, leaderboards, announcements, stats, suspensions, audit logs. Can also register an own manager profile and team and participate in auctions with the same 5,000-credit budget as everyone else.
- **MOD** — match schedules, custom room ID/password, match status and match announcements. Blocked from auctions, credits, user management, official stats and admin accounts.
- **MANAGER** — owns a team: Team Center, auction bidding, team member management, private team chat, match registration.
- **PLAYER** — auction registration with 2–3 preferred roles (Rusher, Support, Sniper, IGL, Entry Fragger, Assaulter), team info (view-only), team chat.

### Auction house
- Players register with name, game ID, profile picture, previous team, stats and roles; only admin-approved registrations appear in the auction.
- Admin creates, publishes, starts, pauses, resumes and closes auctions and approves/rejects registrations.
- Live bidding with real-time WebSocket updates, highest-bid display, minimum bid 100 and minimum increment 10, server-side validation (no outbidding yourself, no bids over available credits, no duplicate purchases, no bidding on own members).
- SOLD/UNSOLD marking; winners are auto-assigned to the winning team.

### Credits
- Exactly **5,000 credits per team per auction** (admin-configurable per auction via `starting_credits`).
- Separate ledger per auction — no carry-over; old auction records stay accessible.
- Credits deduct only on a successful purchase; losing bids never deduct.
- Held (winning) bids reduce available credits so managers cannot over-commit.
- Full transaction history per auction.

### Matches & room security
- MOD/ADMIN create matches (tournament, date, time, room ID, room password, status).
- Room credentials are visible **only** to participating teams' managers and members, plus ADMIN/MOD.

### Leaderboards
- **Top Kills** — player, game ID, total kills, team, rank.
- **Top Team** — combined member kills, kill points (kills + 3 × Booyahs), Booyahs, rank.
- **Top Team Booyah** — teams sorted by Booyah count.

### Automations & new tools
- **Automatic approvals** — player auction registrations and manager sign-ups are approved instantly; a new manager's team is created automatically with its own 5,000-credit ledger.
- **Managers leaderboard (admin panel)** — managers ranked by wins (Booyahs), then total kills, with team logo, member count and contact info.
- **Strict team-chat privacy** — team chats are visible only to that team's manager and members; even admins cannot read or join another team's chat.
- **Fair-play video proofs** — after results are announced, the winning team can upload a gameplay video (up to 25 MB, stored server-side) or a video link; admins verify or reject it from the Matches tab.
- **DC links (admin only)** — admin attaches a Discord invite link to each auction; it is visible only to participating managers, registered players and staff.
- **Profile pictures** — every account can upload a real profile picture at registration or later from the Profile page; it appears in the nav, leaderboards and auction cards.

### Other
- Private Team Center per manager (members, roles, credits, kills, Booyahs, purchases, matches).
- Real-time private team chat with history, timestamps and access control.
- In-app notifications for auctions, sales, match schedules, room publishes and more.
- Announcements and a full audit log of important actions.

## Tests

The end-to-end suite spawns a real server on an isolated temp database and exercises 120 checks across auth, RBAC, registration automation, auctions, credits, leaderboards, matches, video proofs, chat privacy, WebSockets, admin flows, notifications and scale:

```bash
npm test
```

## Project layout

```
db.js                  # SQLite schema + connection (run directly to seed)
seed.js                # deterministic demo data (134 users, 12 teams, 38 matches)
server.js              # Express app + WS upgrade
auth.js                # sessions, RBAC middleware, audit + notification helpers
ws.js                  # WebSocket channels + authorization
routes/                # auth, admin, auction, match, misc route modules
public/                # SPA frontend (index.html, styles.css, app.js)
tests/workflow.test.js # end-to-end workflow suite
```
