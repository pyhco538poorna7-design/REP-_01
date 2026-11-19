'use strict';
const db = require('./db');
const bcrypt = require('bcryptjs');

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const rand = rng(20250117);
const ri = (min, max) => Math.floor(rand() * (max - min + 1)) + min;
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const TEAM_SEEDS = [
  ['Hydra Esports', '🐉'], ['Nova Strike', '⚡'], ['Iron Vanguard', '🛡️'], ['Crimson Reapers', '💀'],
  ['Ghost Squad', '👻'], ['Titan Rising', '🗿'], ['Vortex Gaming', '🌀'], ['Shadow Wolves', '🐺'],
  ['Blaze Kings', '🔥'], ['Frost Legion', '❄️'], ['Storm Riders', '🌪️'], ['Phoenix Force', '🦅'],
];

const HANDLE_A = ['Shadow', 'Toxic', 'Dark', 'Iron', 'Blaze', 'Frozen', 'Silent', 'Rapid', 'Savage', 'Elite', 'Crazy', 'Golden', 'Storm', 'Phantom', 'Venom', 'Turbo', 'Hyper', 'Lucky', 'Rebel', 'Wild'];
const HANDLE_B = ['Sniper', 'Killer', 'Ghost', 'Fury', 'Blade', 'Ace', 'Storm', 'Wolf', 'Viper', 'Dragon', 'Beast', 'King', 'Rusher', 'Legend', 'Hunter', 'Striker', 'Reaper', 'Ninja', 'Titan', 'Phoenix'];
const ROLE_POOL = ['Rusher', 'Support', 'Sniper', 'IGL', 'Entry Fragger', 'Assaulter'];
const TOURNAMENTS = ['FFWS Qualifiers', 'Clash Squad Cup', 'Booyah League S8', 'Continental Series', 'Pro Scrims Night', 'Rise Cup'];

function main() {
  const userCount = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  if (userCount > 1) { console.log('Database already seeded.'); return; }

  const hash = (p) => bcrypt.hashSync(p, 10);
  const adminUsername = (process.env.ADMIN_USERNAME || 'admin').trim();
  const adminHash = hash(process.env.ADMIN_PASSWORD || 'admin123');
  const modHash = hash('mod123');
  const managerHash = hash('manager123');
  const playerHash = hash('player123');

  const insUser = db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?,?,?,?)');
  const insPlayer = db.prepare('INSERT INTO player_profiles (user_id, game_id, avatar, previous_team, roles, kills, booyahs, matches, team_id) VALUES (?,?,?,?,?,?,?,?,?)');
  const insManager = db.prepare('INSERT INTO manager_profiles (user_id, team_id, contact, approved) VALUES (?,?,?,1)');
  const insTeam = db.prepare('INSERT INTO teams (name, logo, owner_user_id) VALUES (?,?,?)');
  const insMember = db.prepare('INSERT INTO team_members (team_id, player_user_id, source) VALUES (?,?,?)');
  const insMatch = db.prepare('INSERT INTO matches (tournament_name, match_date, match_time, status, created_by) VALUES (?,?,?,?,?)');
  const insResult = db.prepare('INSERT INTO match_results (match_id, team_id, kills, position) VALUES (?,?,?,?)');
  const insMatchTeam = db.prepare('INSERT INTO match_teams (match_id, team_id) VALUES (?,?)');
  const insAnn = db.prepare('INSERT INTO announcements (author_id, title, body) VALUES (?,?,?)');
  const insAuction = db.prepare('INSERT INTO auctions (name, auction_date, start_time, starting_credits, status, created_by) VALUES (?,?,?,?,?,?)');
  const insReg = db.prepare('INSERT INTO auction_registrations (auction_id, player_user_id, status, roles, previous_team) VALUES (?,?,?,?,?)');

  const seedAll = db.transaction(() => {
    // ---- Admin & MOD ----
    const existingAdmin = db.prepare('SELECT id, role, status FROM users WHERE username = ?').get(adminUsername);
    const admin = existingAdmin && existingAdmin.role === 'ADMIN' && existingAdmin.status === 'active'
      ? existingAdmin.id
      : db.prepare("INSERT OR REPLACE INTO users (username, password_hash, role, display_name, status) VALUES (?,?,'ADMIN','Club Owner','active')").run(adminUsername, adminHash).lastInsertRowid;
    const mod = insUser.run('mod', modHash, 'MOD', 'Head Moderator').lastInsertRowid;

    // ---- Teams + Managers ----
    const teamIds = [];
    TEAM_SEEDS.forEach(([name, logo], i) => {
      const mId = insUser.run(`manager${i + 1}`, managerHash, 'MANAGER', name.split(' ')[0] + ' Manager').lastInsertRowid;
      const tId = insTeam.run(name, logo, mId).lastInsertRowid;
      insManager.run(mId, tId, `manager${i + 1}@ffclub.gg`);
      teamIds.push(tId);
    });

    // ---- Players ----
    const freeAgents = [];
    let n = 0;
    outer:
    for (const a of HANDLE_A) {
      for (const b of HANDLE_B) {
        if (n >= 120) break outer;
        n++;
        const uname = `player${String(n).padStart(3, '0')}`;
        const uid = insUser.run(uname, playerHash, 'PLAYER', `${a}${b}`).lastInsertRowid;
        const roleCount = ri(2, 3);
        const roles = [];
        while (roles.length < roleCount) {
          const r = pick(ROLE_POOL);
          if (!roles.includes(r)) roles.push(r);
        }
        insPlayer.run(uid, `FF${ri(10000000, 99999999)}`, '', '', JSON.stringify(roles), 0, 0, 0, null);
        freeAgents.push({ uid, uname, name: `${a}${b}`, roles, gameId: `FF${ri(10000000, 99999999)}` });
      }
    }

    // ---- Completed match history (drives official stats) ----
    const now = new Date();
    const day = (offset) => {
      const d = new Date(now.getTime() - offset * 86400000);
      return d.toISOString().slice(0, 10);
    };
    let matchNo = 0;
    const teamStats = new Map(teamIds.map((t) => [t, { kills: 0, booyahs: 0, matches: 0 }]));

    for (let m = 0; m < 36; m++) {
      matchNo++;
      const mid = insMatch.run(
        pick(TOURNAMENTS), day(ri(3, 90)), `${String(ri(18, 21)).padStart(2, '0')}:${pick(['00', '30'])}`,
        'completed', mod
      ).lastInsertRowid;
      const shuffled = [...teamIds].sort(() => rand() - 0.5);
      const participants = shuffled.slice(0, ri(4, 8));
      const results = participants.map((tid) => ({ tid, kills: ri(18, 62) }));
      results.sort((x, y) => y.kills - x.kills);
      results.forEach((r, idx) => {
        insMatchTeam.run(mid, r.tid);
        insResult.run(mid, r.tid, r.kills, idx === 0 ? 1 : idx + 1);
        const st = teamStats.get(r.tid);
        st.kills += r.kills;
        st.matches += 1;
        if (idx === 0) st.booyahs += 1;
      });
    }

    // ---- Assign players to teams, derive stats from match records ----
    const updPlayer = db.prepare('UPDATE player_profiles SET game_id=?, roles=?, kills=?, booyahs=?, matches=?, team_id=? WHERE user_id=?');
    let idx = 0;
    const perTeam = 8;
    teamIds.forEach((tid) => {
      for (let k = 0; k < perTeam; k++) {
        const p = freeAgents[idx++];
        const st = teamStats.get(tid);
        const share = Math.max(4, Math.round((st.kills / perTeam) * (0.6 + rand() * 0.8)));
        const booyahs = Math.round((st.booyahs / perTeam) * (0.3 + rand()));
        updPlayer.run(p.gameId, JSON.stringify(p.roles), share, booyahs, st.matches, tid, p.uid);
        insMember.run(tid, p.uid, 'draft');
      }
    });
    // Remaining players stay as free agents with their own record stats
    for (; idx < freeAgents.length; idx++) {
      const p = freeAgents[idx];
      updPlayer.run(p.gameId, JSON.stringify(p.roles), ri(20, 400), ri(0, 6), ri(30, 200), null, p.uid);
    }

    // ---- Upcoming matches ----
    const up1 = insMatch.run('FFWS Qualifiers Grand Final', day(-4), '19:00', 'upcoming', mod).lastInsertRowid;
    const up2 = insMatch.run('Clash Squad Cup Week 3', day(-7), '20:30', 'upcoming', mod).lastInsertRowid;
    insMatchTeam.run(up1, teamIds[0]); insMatchTeam.run(up1, teamIds[1]); insMatchTeam.run(up1, teamIds[2]);
    insMatchTeam.run(up2, teamIds[3]); insMatchTeam.run(up2, teamIds[4]);

    // ---- Upcoming auction with registrations ----
    const auctionId = insAuction.run('Season 8 Mega Auction', day(-5), '18:00', 5000, 'upcoming', admin).lastInsertRowid;
    for (let i = 0; i < 14; i++) {
      const p = freeAgents[96 + i];
      insReg.run(auctionId, p.uid, i < 9 ? 'approved' : 'pending', JSON.stringify(p.roles), '');
    }
    for (let i = 0; i < 4; i++) {
      const p = freeAgents[i * 9];
      insReg.run(auctionId, p.uid, 'pending', JSON.stringify(p.roles), TEAM_SEEDS[i][0]);
    }

    // ---- Announcements & notifications ----
    insAnn.run(admin, 'Welcome to Season 8', 'The Season 8 Mega Auction is coming. Managers, make sure your teams are registered. Players, submit your auction registrations now!');
    insAnn.run(mod, 'FFWS Qualifiers Grand Final', 'Room details for the Grand Final will be published 1 hour before match time. Registered teams: check your Team Center.');

    const insNotif = db.prepare('INSERT INTO notifications (user_id, type, title, body) VALUES (?,?,?,?)');
    const allUsers = db.prepare('SELECT id FROM users').all();
    for (const u of allUsers) {
      insNotif.run(u.id, 'announcement', 'Welcome to the Club', 'Season 8 is live. Check the dashboard for upcoming matches and auctions.');
    }
  });

  seedAll();
  const counts = {
    users: db.prepare('SELECT COUNT(*) c FROM users').get().c,
    players: db.prepare('SELECT COUNT(*) c FROM player_profiles').get().c,
    teams: db.prepare('SELECT COUNT(*) c FROM teams').get().c,
    matches: db.prepare('SELECT COUNT(*) c FROM matches').get().c,
    results: db.prepare('SELECT COUNT(*) c FROM match_results').get().c,
  };
  console.log('Seeded:', JSON.stringify(counts));
}

main();
