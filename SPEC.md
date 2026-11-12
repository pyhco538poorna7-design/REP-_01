# Free Fire Auction App: spec for moving to another tool

Credits only, no real money. One auctioneer (the owner). Team managers bid on players using credits.

## Roles
- **Auctioneer (admin):** one fixed account (the app owner). Posts auctions, verifies players, runs the live room. Cannot register as player or manager.
- **Player:** registers any time with in-game name, UID, 1 to 4 roles. Must be verified, then press Participate for each auction.
- **Team manager:** registers any time with name and team name. Stays a manager until they delete their registration. Press Participate for each auction to bid.

Player roles: IGL, Rusher, Supporter, Sniper, Secondary Rusher, Zone Survivor, Clutcher, Anchor, Flanker, Assaulter.

## Data model (collections, document id in brackets)
| Collection | Doc id | Fields | Who writes |
|---|---|---|---|
| config | `main` | title, auctioneer, when (datetime), venue, credits (1000), base (50), minRaise (10), timer (30 sec), squad (5), regOpen (participation open), verifiedOnly (true), bot (true), postedAt (ms timestamp, new round) | auctioneer |
| players | user id | ign, uid (8 to 12 digits, unique), roles[1..4], status "approved", verified (bool), by ("bot" or "owner"), locked (bool, set when the auctioneer unverifies), ts | the player (own doc), auctioneer (all) |
| managers | user id | name, team (unique), perks[] (ids), color (hex), ts | the manager (own doc), auctioneer (all) |
| joins | user id | role, round (= config.postedAt), ts | the user (own doc), auctioneer |
| live | `state` | player (player id or null), endsAt (ms), note | auctioneer |
| bids | user id (manager) | playerId, amount, ts | the manager (own doc) |
| sold | player id | mgr (manager id), price, ts | auctioneer |

## Logic
- **Participation round:** a join counts only if `join.round == config.postedAt`. Posting a new auction sets a new postedAt, so everyone must join again.
- **Participation open:** `postedAt` exists AND regOpen is not false AND now is before `config.when`.
- **Registration** is always open (not tied to the auction time).
- **Player auto-approval rules:** name 3+ chars, UID matches `^\d{8,12}$` and is unique, 1 to 4 roles. Names may repeat; UID is the identity.
- **Pool for the auction:** players not yet sold, joined this round, and verified (when verifiedOnly is on).
- **Manager balance:** `config.credits` minus sum of `sold.price` for that manager minus sum of perk costs.
- **Bid rules:** must have joined, bidding window open (`now < live.endsAt`), `amount >= base` for the first bid or `topBid + minRaise`, `amount <= balance`, squad not full.
- **Top bid:** highest amount; tie-break by Priority Bid perk, then earliest ts. Bids for another player are ignored.
- **End of timer:** the auctioneer's client writes `sold/<playerId>` with the top bid, or marks the player unsold, then sets `live.player = null`. Do this on a server in the new tool.
- **Manager removed:** their sold records are deleted so players return to the pool.

## Rewards (spend credits)
- Priority Bid, 80: wins tie-breaks
- Gold Badge, 50: badge beside team name
- Spotlight, 100: team pinned first on the Teams page
- Team Color, 30: choose banner color

## Verification bot
The player uploads a screenshot of their Free Fire profile. An AI vision call returns JSON `{"name","uid","is_free_fire_profile"}`. Auto-verify when the UID matches exactly and the name matches after lowercasing and removing non-letters/digits (equal or one contains the other). Otherwise the auctioneer verifies manually. Prompt used: "This is a screenshot of a Free Fire player profile. Read the player nickname and the numeric UID exactly as shown. Reply with only JSON: {"name":"","uid":"","is_free_fire_profile":true}".

## Screens
- Auctioneer: Dashboard, Post Auction (settings, post and notify, copy WhatsApp message), Live Room (start, random, sell now, cancel), Players (verify/remove), Teams.
- Manager: Live Room (bid), My Team (squad, missing roles suggestion, color, delete), Rewards, Teams.
- Player: My Profile (status, bot verification, delete), Live Room, Teams.
- New user: Join (registration with "what you need" and "how it works"), Live Room, Teams.
- A "New auction" notification card with Participate / Withdraw shows at the top for registered users.

## Notes for porting
- The current page is one HTML file that talks to Claude's built-in database through `claude.use("db")`, `claude.use("user")` and `claude.use("sample")`. These do not exist outside claude.ai, so replace them with your own login, database and AI call.
- Enforce the write rules on the server (for example Supabase row-level security or Firebase rules). In the current app the bot result and credits are written from the browser, so a technical friend could cheat. Do balance, bids and verification on the server in a real build.
- Notifications are in-app only. Add email, push or WhatsApp in your new tool.
