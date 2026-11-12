# Free Fire Auction App

A credits-only Free Fire player auction: one auctioneer (the app owner) posts auctions and runs the live room; team managers bid on players using credits; players register, get verified and press Participate.

**Open [`auction.html`](auction.html) in any browser to use it.**

## Quick start (demo)

- **Players / Managers** — log in with **Google** (email) or **Phone** (10-digit number + OTP). First time, you're asked your name, then you choose Player or Manager. *Demo note: the Google/OTP steps are simulated in the browser — no real Google popup or SMS yet; connect a backend (e.g. Firebase Auth) for the real thing.*
- **Auctioneer** — click "Auctioneer login", default passcode `owner123` (change it in the Dashboard).
- Flow: Auctioneer posts an auction → registered users press **Participate** → auctioneer starts players in the Live Room → managers bid before the timer ends → top bid wins.

## What's implemented (from [SPEC.md](SPEC.md))

- Roles: auctioneer (fixed, passcode-protected), players, team managers
- Player registration: in-game name, unique UID (8–12 digits), 1–4 roles from the 10-role list, auto-approval rules
- Manager registration: unique team name, delete registration (players return to the pool)
- Participation rounds: a join only counts for the current `postedAt`; new auction = everyone joins again; notification card with Participate / Withdraw
- Live room: start / random pick / sell to top bid / unsold / cancel, countdown timer, bid rules (base, min raise, balance, squad size, must have joined)
- Top bid tie-break: Priority Bid perk, then earliest bid
- Balances: credits − sold prices − perk costs
- Rewards: Priority Bid (80), Gold Badge (50), Spotlight (100), Team Color (30)
- Verification bot: upload a Free Fire profile screenshot; if you add an OpenAI-compatible API key (stored only in your browser), the bot reads name + UID and auto-verifies on exact UID match and fuzzy name match — otherwise the auctioneer verifies manually
- Screens: Dashboard, Post Auction (with WhatsApp message copy), Live Room, Players, Teams, My Team (squad + missing-role suggestions), Rewards, My Profile

## Important limitation

This build keeps all data in the browser's `localStorage` — great as a demo, but it is **not** a multi-device production system. For a real event, follow the "Notes for porting" section in [SPEC.md](SPEC.md): put the database and login on a server (e.g. Supabase/Firebase) and enforce balances, bids and verification server-side.
