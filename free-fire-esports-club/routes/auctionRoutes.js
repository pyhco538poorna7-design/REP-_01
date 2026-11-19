'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole, audit, notify, notifyAll, notifyRole } = require('../auth');
const { broadcastToChannel } = require('../ws');

const router = express.Router();
const MIN_BID = 100;
const MIN_INCREMENT = 10;
const MAX_SQUAD = 4;
const VALID_ROLES = ['Rusher', 'Support', 'Sniper', 'IGL', 'Entry Fragger', 'Assaulter'];

function getTeamForUser(userId) {
  return db.prepare(`
    SELECT t.*, mp.approved AS manager_approved FROM teams t
    JOIN manager_profiles mp ON mp.team_id = t.id
    WHERE mp.user_id = ?`).get(userId) || null;
}

function highestBid(auctionId, playerId) {
  return db.prepare(`
    SELECT b.*, t.name AS team_name, t.logo AS team_logo FROM bids b
    JOIN teams t ON t.id = b.team_id
    WHERE b.auction_id = ? AND b.player_user_id = ?
    ORDER BY b.amount DESC, b.id DESC LIMIT 1`).get(auctionId, playerId) || null;
}

function outstandingBids(teamId, auctionId, excludePlayerId) {
  const rows = db.prepare(`
    SELECT b.player_user_id, b.amount FROM bids b
    WHERE b.auction_id = ? AND b.team_id = ? AND b.player_user_id != ?
      AND NOT EXISTS (
        SELECT 1 FROM auction_results ar
        WHERE ar.auction_id = b.auction_id AND ar.player_user_id = b.player_user_id
      )`).all(auctionId, teamId, excludePlayerId || 0);
  let total = 0;
  for (const r of rows) {
    const top = highestBid(auctionId, r.player_user_id);
    if (top && top.team_id === teamId) total += top.amount;
  }
  return total;
}

function auctionState(auctionId, forUser) {
  const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(auctionId);
  if (!auction) return null;
  const players = db.prepare(`
    SELECT ar.id AS registration_id, ar.status AS reg_status, ar.roles, ar.previous_team,
      u.id AS player_id, u.display_name AS player_name, u.username,
      p.game_id, p.avatar, p.kills, p.booyahs, p.matches
    FROM auction_registrations ar
    JOIN users u ON u.id = ar.player_user_id
    JOIN player_profiles p ON p.user_id = u.id
    WHERE ar.auction_id = ?
    ORDER BY u.display_name`).all(auctionId);
  const results = db.prepare('SELECT * FROM auction_results WHERE auction_id = ?').all(auctionId);
  const resultMap = new Map(results.map((r) => [r.player_user_id, r]));
  const enriched = players.map((p) => {
    const top = highestBid(auctionId, p.player_id);
    const result = resultMap.get(p.player_id) || null;
    return {
      ...p,
      roles: JSON.parse(p.roles || '[]'),
      current_bid: top ? top.amount : null,
      current_bid_team: top ? { id: top.team_id, name: top.team_name, logo: top.team_logo } : null,
      bid_count: db.prepare('SELECT COUNT(*) c FROM bids WHERE auction_id = ? AND player_user_id = ?').get(auctionId, p.player_id).c,
      result: result ? { status: result.status, price: result.price, team_id: result.team_id } : null,
    };
  });
  const teams = db.prepare(`
    SELECT at.auction_id, at.team_id, at.credits, at.spent, t.name, t.logo,
      u.display_name AS owner_name, u.username AS owner_username
    FROM auction_teams at JOIN teams t ON t.id = at.team_id
    LEFT JOIN users u ON u.id = t.owner_user_id
    WHERE at.auction_id = ? ORDER BY t.name`).all(auctionId);
  const state = { auction, players: enriched, teams };
  if (forUser) {
    const team = getTeamForUser(forUser.id);
    if (team) {
      const at = db.prepare('SELECT * FROM auction_teams WHERE auction_id = ? AND team_id = ?').get(auctionId, team.id);
      if (at) {
        const outstanding = outstandingBids(team.id, auctionId, null);
        state.my_team = {
          id: team.id, name: team.name, logo: team.logo,
          credits: at.credits, spent: at.spent,
          available: at.credits - at.spent - outstanding,
        };
      }
    }
  }
  return state;
}

function broadcastAuction(auctionId) {
  broadcastToChannel(`auction:${auctionId}`, { type: 'auction_update', auction_id: auctionId, state: auctionState(auctionId) });
}

router.get('/auctions', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, u.display_name AS created_by_name,
      (SELECT COUNT(*) FROM auction_registrations ar WHERE ar.auction_id = a.id AND ar.status = 'approved') AS approved_players,
      (SELECT COUNT(*) FROM auction_registrations ar WHERE ar.auction_id = a.id AND ar.status = 'pending') AS pending_players,
      (SELECT COUNT(*) FROM auction_results r WHERE r.auction_id = a.id AND r.status = 'SOLD') AS sold_players,
      (SELECT COUNT(*) FROM auction_teams at WHERE at.auction_id = a.id) AS participating_teams
    FROM auctions a LEFT JOIN users u ON u.id = a.created_by
    ORDER BY a.id DESC`).all();
  if (req.user.role !== 'ADMIN' && req.user.role !== 'MOD') rows.forEach((r) => { r.dc_link = ''; });
  if (req.user.role === 'PLAYER') {
    const mine = db.prepare('SELECT auction_id, status FROM auction_registrations WHERE player_user_id = ?').all(req.user.id);
    const map = new Map(mine.map((m) => [m.auction_id, m.status]));
    rows.forEach((r) => { r.my_registration = map.get(r.id) || 'none'; });
  }
  res.json({ auctions: rows });
});

router.post('/auctions', requireRole('ADMIN'), (req, res) => {
  const { name, auction_date, start_time, starting_credits, venue } = req.body || {};
  if (!name || !auction_date || !start_time) return res.status(400).json({ error: 'Auction name, date and starting time are required.' });
  const credits = parseInt(starting_credits, 10) || 5000;
  if (credits < 100) return res.status(400).json({ error: 'Starting credits must be at least 100.' });
  const venueName = String(venue || 'DC').trim() || 'DC';
  const dcLink = String(req.body && req.body.dc_link || '').trim();
  if (dcLink && !/^https?:\/\//.test(dcLink)) return res.status(400).json({ error: 'DC link must be a valid URL starting with http.' });
  const id = db.prepare('INSERT INTO auctions (name, auction_date, start_time, venue, starting_credits, dc_link, status, created_by) VALUES (?,?,?,?,?,?,?,?)')
    .run(name, auction_date, start_time, venueName, credits, dcLink.slice(0, 500), 'upcoming', req.user.id).lastInsertRowid;
  audit(req.user.id, 'auction_create', { id, name, credits, venue: venueName });
  notifyAll('auction', 'New auction announced', `${name} — ${auction_date} at ${start_time} (Venue: ${venueName}). Starting budget: ${credits} credits per team.`);
  broadcastToChannel('auctions', { type: 'auctions_changed' });
  res.status(201).json({ message: 'Auction created.', auction_id: id });
});

function canSeeDcLink(user, auctionId) {
  if (user.role === 'ADMIN' || user.role === 'MOD') return true;
  if (user.role === 'MANAGER') {
    return !!db.prepare('SELECT at.id FROM auction_teams at JOIN teams t ON t.id = at.team_id WHERE at.auction_id = ? AND t.owner_user_id = ?').get(auctionId, user.id);
  }
  if (user.role === 'PLAYER') {
    return !!db.prepare("SELECT ar.id FROM auction_registrations ar WHERE ar.auction_id = ? AND ar.player_user_id = ? AND ar.status = 'approved'").get(auctionId, user.id);
  }
  return false;
}

router.patch('/auctions/:id/dc-link', requireRole('ADMIN'), (req, res) => {
  const auction = db.prepare('SELECT id FROM auctions WHERE id = ?').get(req.params.id);
  if (!auction) return res.status(404).json({ error: 'Auction not found.' });
  const dcLink = String(req.body && req.body.dc_link || '').trim();
  if (dcLink && !/^https?:\/\//.test(dcLink)) return res.status(400).json({ error: 'DC link must be a valid URL starting with http.' });
  db.prepare('UPDATE auctions SET dc_link = ? WHERE id = ?').run(dcLink.slice(0, 500), auction.id);
  audit(req.user.id, 'auction_dc_link', { auction_id: auction.id });
  broadcastAuction(auction.id);
  res.json({ message: dcLink ? 'DC link set.' : 'DC link removed.' });
});

router.post('/auctions/:id/start', requireRole('ADMIN'), (req, res) => {
  const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(req.params.id);
  if (!auction) return res.status(404).json({ error: 'Auction not found.' });
  if (auction.status !== 'upcoming' && auction.status !== 'paused') return res.status(400).json({ error: `Cannot start an auction in status ${auction.status}.` });
  const tx = db.transaction(() => {
    if (auction.status === 'upcoming') {
      const teams = db.prepare('SELECT id FROM teams WHERE owner_user_id IS NOT NULL').all();
      const insAT = db.prepare('INSERT INTO auction_teams (auction_id, team_id, credits) VALUES (?,?,?)');
      const insCT = db.prepare('INSERT INTO credit_transactions (auction_id, team_id, amount, type, description) VALUES (?,?,?,?,?)');
      for (const t of teams) {
        const existing = db.prepare('SELECT id FROM auction_teams WHERE auction_id = ? AND team_id = ?').get(auction.id, t.id);
        if (!existing) {
          insAT.run(auction.id, t.id, auction.starting_credits);
          insCT.run(auction.id, t.id, auction.starting_credits, 'allocation', `Starting budget for ${auction.name}`);
        }
      }
    }
    db.prepare('UPDATE auctions SET status = \'live\' WHERE id = ?').run(auction.id);
  });
  tx();
  audit(req.user.id, 'auction_start', { id: auction.id, name: auction.name });
  notifyAll('auction', 'Auction started', `${auction.name} is now LIVE. Managers can place bids now.`);
  broadcastAuction(auction.id);
  res.json({ message: 'Auction started.' });
});

router.post('/auctions/:id/pause', requireRole('ADMIN'), (req, res) => {
  const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(req.params.id);
  if (!auction) return res.status(404).json({ error: 'Auction not found.' });
  if (auction.status !== 'live') return res.status(400).json({ error: 'Only a live auction can be paused.' });
  db.prepare('UPDATE auctions SET status = \'paused\' WHERE id = ?').run(auction.id);
  audit(req.user.id, 'auction_pause', { id: auction.id });
  broadcastAuction(auction.id);
  res.json({ message: 'Auction paused.' });
});

router.post('/auctions/:id/resume', requireRole('ADMIN'), (req, res) => {
  const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(req.params.id);
  if (!auction) return res.status(404).json({ error: 'Auction not found.' });
  if (auction.status !== 'paused') return res.status(400).json({ error: 'Only a paused auction can be resumed.' });
  db.prepare('UPDATE auctions SET status = \'live\' WHERE id = ?').run(auction.id);
  audit(req.user.id, 'auction_resume', { id: auction.id });
  broadcastAuction(auction.id);
  res.json({ message: 'Auction resumed.' });
});

router.post('/auctions/:id/close', requireRole('ADMIN'), (req, res) => {
  const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(req.params.id);
  if (!auction) return res.status(404).json({ error: 'Auction not found.' });
  if (auction.status === 'closed') return res.status(400).json({ error: 'Auction is already closed.' });
  const tx = db.transaction(() => {
    const approved = db.prepare(`
      SELECT ar.player_user_id FROM auction_registrations ar
      WHERE ar.auction_id = ? AND ar.status = 'approved'`).all(auction.id);
    const insResult = db.prepare('INSERT OR IGNORE INTO auction_results (auction_id, player_user_id, team_id, price, status) VALUES (?,?,?,?,?)');
    for (const row of approved) {
      const result = db.prepare('SELECT * FROM auction_results WHERE auction_id = ? AND player_user_id = ?').get(auction.id, row.player_user_id);
      if (!result) insResult.run(auction.id, row.player_user_id, null, 0, 'UNSOLD');
    }
    db.prepare('UPDATE auctions SET status = \'closed\' WHERE id = ?').run(auction.id);
  });
  tx();
  audit(req.user.id, 'auction_close', { id: auction.id });
  notifyAll('auction', 'Auction completed', `${auction.name} has closed. Check the auction page for final results.`);
  broadcastAuction(auction.id);
  res.json({ message: 'Auction closed.' });
});

router.get('/auctions/:id', requireAuth, (req, res) => {
  const state = auctionState(Number(req.params.id), req.user.role === 'MOD' ? null : req.user);
  if (!state) return res.status(404).json({ error: 'Auction not found.' });
  if (req.user.role === 'MOD') {
    state.players = state.players.map((p) => ({ ...p, current_bid: null, current_bid_team: null }));
  }
  if (!canSeeDcLink(req.user, state.auction.id)) state.auction = { ...state.auction, dc_link: '' };
  res.json(state);
});

// Player registration for an auction
router.post('/auctions/:id/register', requireRole('PLAYER'), (req, res) => {
  const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(req.params.id);
  if (!auction) return res.status(404).json({ error: 'Auction not found.' });
  if (auction.status === 'closed') return res.status(400).json({ error: 'This auction is closed.' });
  const existing = db.prepare('SELECT * FROM auction_registrations WHERE auction_id = ? AND player_user_id = ?').get(auction.id, req.user.id);
  if (existing) return res.status(409).json({ error: `You already registered for this auction (status: ${existing.status}).` });
  const profile = db.prepare('SELECT * FROM player_profiles WHERE user_id = ?').get(req.user.id);
  let roles = [];
  try { roles = JSON.parse(profile.roles || '[]'); } catch { roles = []; }
  if (!Array.isArray(roles) || roles.length < 2) return res.status(400).json({ error: 'Set 2-3 preferred roles on your profile before registering.' });
  db.prepare('INSERT INTO auction_registrations (auction_id, player_user_id, status, roles, previous_team) VALUES (?,?,?,?,?)')
    .run(auction.id, req.user.id, 'approved', JSON.stringify(roles), profile.previous_team || '');
  audit(req.user.id, 'auction_register', { auction_id: auction.id });
  notifyRole('ADMIN', 'auction', 'Auction registration', `${req.user.display_name} (@${req.user.username}) registered for ${auction.name}.`);
  notify(req.user.id, 'auction', 'Auction registration approved', `You are approved for ${auction.name}. Good luck!`);
  broadcastAuction(auction.id);
  res.status(201).json({ message: 'Registration approved automatically. You are in the auction!' });
});

router.post('/auctions/:id/registrations/:regId/approve', requireRole('ADMIN'), (req, res) => {
  const reg = db.prepare('SELECT * FROM auction_registrations WHERE id = ? AND auction_id = ?').get(req.params.regId, req.params.id);
  if (!reg) return res.status(404).json({ error: 'Registration not found.' });
  db.prepare('UPDATE auction_registrations SET status = \'approved\' WHERE id = ?').run(reg.id);
  const auction = db.prepare('SELECT name FROM auctions WHERE id = ?').get(req.params.id);
  audit(req.user.id, 'auction_reg_approve', { registration_id: reg.id });
  notify(reg.player_user_id, 'auction', 'Auction registration approved', `You are approved for ${auction.name}. Good luck!`);
  broadcastAuction(Number(req.params.id));
  res.json({ message: 'Registration approved.' });
});

router.post('/auctions/:id/registrations/:regId/reject', requireRole('ADMIN'), (req, res) => {
  const reg = db.prepare('SELECT * FROM auction_registrations WHERE id = ? AND auction_id = ?').get(req.params.regId, req.params.id);
  if (!reg) return res.status(404).json({ error: 'Registration not found.' });
  db.prepare('UPDATE auction_registrations SET status = \'rejected\' WHERE id = ?').run(reg.id);
  audit(req.user.id, 'auction_reg_reject', { registration_id: reg.id });
  notify(reg.player_user_id, 'auction', 'Auction registration rejected', 'Your auction registration was rejected by an administrator.');
  res.json({ message: 'Registration rejected.' });
});

// Live bidding — server-side validated
router.post('/auctions/:id/bid', requireRole('MANAGER', 'ADMIN'), (req, res) => {
  const { player_id, amount } = req.body || {};
  const team = getTeamForUser(req.user.id);
  if (!team) return res.status(403).json({ error: 'You do not manage a registered team.' });
  const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(req.params.id);
  if (!auction) return res.status(404).json({ error: 'Auction not found.' });
  if (auction.status !== 'live') return res.status(400).json({ error: 'Bidding is not active (auction is ' + auction.status + ').' });

  const reg = db.prepare(`
    SELECT ar.* FROM auction_registrations ar
    WHERE ar.auction_id = ? AND ar.player_user_id = ? AND ar.status = 'approved'`).get(auction.id, player_id);
  if (!reg) return res.status(400).json({ error: 'This player is not an approved participant in this auction.' });

  const result = db.prepare('SELECT * FROM auction_results WHERE auction_id = ? AND player_user_id = ?').get(auction.id, player_id);
  if (result) return res.status(409).json({ error: `Bidding closed: this player is already marked ${result.status}.` });

  const profile = db.prepare('SELECT team_id FROM player_profiles WHERE user_id = ?').get(player_id);
  if (profile && profile.team_id === team.id) return res.status(400).json({ error: 'This player is already on your team.' });

  const value = parseInt(amount, 10);
  if (!Number.isInteger(value) || value < MIN_BID) return res.status(400).json({ error: `Bid must be at least ${MIN_BID} credits.` });

  const at = db.prepare('SELECT * FROM auction_teams WHERE auction_id = ? AND team_id = ?').get(auction.id, team.id);
  if (!at) return res.status(403).json({ error: 'Your team has no budget ledger for this auction.' });
  const rosterCount = db.prepare('SELECT COUNT(*) AS c FROM team_members WHERE team_id = ?').get(team.id).c;
  if (rosterCount >= MAX_SQUAD) return res.status(400).json({ error: `Your squad is full (max ${MAX_SQUAD} players). Release a player before bidding again.` });

  const top = highestBid(auction.id, player_id);
  if (top && top.team_id === team.id) return res.status(400).json({ error: 'You already hold the highest bid.' });
  const minAllowed = top ? top.amount + MIN_INCREMENT : MIN_BID;
  if (value < minAllowed) return res.status(400).json({ error: `Bid must be at least ${minAllowed} credits (min increment ${MIN_INCREMENT}).` });

  const outstanding = outstandingBids(team.id, auction.id, player_id);
  const myCurrentOnThis = top && top.team_id === team.id ? top.amount : 0;
  const available = at.credits - at.spent - outstanding + myCurrentOnThis;
  if (value > available) return res.status(400).json({ error: `Bid exceeds your available credits (${available}).` });

  db.prepare('INSERT INTO bids (auction_id, player_user_id, team_id, amount) VALUES (?,?,?,?)')
    .run(auction.id, player_id, team.id, value);
  audit(req.user.id, 'bid', { auction_id: auction.id, player_id, amount: value });
  broadcastAuction(auction.id);
  res.status(201).json({ message: 'Bid placed.', amount: value });
});

// Admin controls bidding outcome
router.post('/auctions/:id/sold', requireRole('ADMIN'), (req, res) => {
  const { player_id } = req.body || {};
  const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(req.params.id);
  if (!auction) return res.status(404).json({ error: 'Auction not found.' });
  if (auction.status !== 'live' && auction.status !== 'paused') return res.status(400).json({ error: 'Auction is not active.' });
  const reg = db.prepare('SELECT * FROM auction_registrations WHERE auction_id = ? AND player_user_id = ? AND status = \'approved\'').get(auction.id, player_id);
  if (!reg) return res.status(404).json({ error: 'Approved registration not found.' });
  const existing = db.prepare('SELECT * FROM auction_results WHERE auction_id = ? AND player_user_id = ?').get(auction.id, player_id);
  if (existing) return res.status(409).json({ error: `Player already marked ${existing.status}.` });
  const top = highestBid(auction.id, player_id);
  if (!top) return res.status(400).json({ error: 'No bids placed on this player. Mark them UNSOLD instead.' });

  const player = db.prepare('SELECT display_name FROM users WHERE id = ?').get(player_id);
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(top.team_id);
  if (db.prepare('SELECT COUNT(*) AS c FROM team_members WHERE team_id = ?').get(team.id).c >= MAX_SQUAD) {
    return res.status(400).json({ error: `${team.name} squad is full (max ${MAX_SQUAD} players).` });
  }
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO auction_results (auction_id, player_user_id, team_id, price, status) VALUES (?,?,?,?,?)')
      .run(auction.id, player_id, team.id, top.amount, 'SOLD');
    db.prepare('UPDATE auction_teams SET spent = spent + ? WHERE auction_id = ? AND team_id = ?').run(top.amount, auction.id, team.id);
    db.prepare('INSERT INTO credit_transactions (auction_id, team_id, amount, type, description) VALUES (?,?,?,?,?)')
      .run(auction.id, team.id, -top.amount, 'purchase', `Signed ${player.display_name} for ${top.amount} credits`);
    db.prepare('DELETE FROM team_members WHERE player_user_id = ?').run(player_id);
    db.prepare('INSERT INTO team_members (team_id, player_user_id, source) VALUES (?,?,?)').run(team.id, player_id, 'auction');
    db.prepare('UPDATE player_profiles SET team_id = ? WHERE user_id = ?').run(team.id, player_id);
  });
  tx();
  audit(req.user.id, 'auction_sold', { auction_id: auction.id, player_id, team_id: team.id, price: top.amount });
  notifyAll('auction', 'Player SOLD', `${player.display_name} sold to ${team.name} for ${top.amount} credits.`);
  notify(player_id, 'auction', 'You were sold!', `Congratulations! ${team.name} signed you for ${top.amount} credits.`);
  broadcastAuction(auction.id);
  res.json({ message: `${player.display_name} SOLD to ${team.name} for ${top.amount} credits.` });
});

router.post('/auctions/:id/unsold', requireRole('ADMIN'), (req, res) => {
  const { player_id } = req.body || {};
  const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(req.params.id);
  if (!auction) return res.status(404).json({ error: 'Auction not found.' });
  const existing = db.prepare('SELECT * FROM auction_results WHERE auction_id = ? AND player_user_id = ?').get(auction.id, player_id);
  if (existing) return res.status(409).json({ error: `Player already marked ${existing.status}.` });
  db.prepare('INSERT INTO auction_results (auction_id, player_user_id, team_id, price, status) VALUES (?,?,?,?,?)')
    .run(auction.id, player_id, null, 0, 'UNSOLD');
  audit(req.user.id, 'auction_unsold', { auction_id: auction.id, player_id });
  broadcastAuction(auction.id);
  res.json({ message: 'Player marked UNSOLD.' });
});

router.get('/auctions/:id/transactions', requireAuth, (req, res) => {
  const auctionId = Number(req.params.id);
  const auction = db.prepare('SELECT * FROM auctions WHERE id = ?').get(auctionId);
  if (!auction) return res.status(404).json({ error: 'Auction not found.' });
  let rows;
  if (req.user.role === 'ADMIN') {
    rows = db.prepare(`
      SELECT ct.*, t.name AS team_name FROM credit_transactions ct
      JOIN teams t ON t.id = ct.team_id WHERE ct.auction_id = ? ORDER BY ct.id DESC`).all(auctionId);
  } else {
    const team = getTeamForUser(req.user.id);
    if (!team) return res.json({ transactions: [] });
    rows = db.prepare(`
      SELECT ct.*, t.name AS team_name FROM credit_transactions ct
      JOIN teams t ON t.id = ct.team_id
      WHERE ct.auction_id = ? AND ct.team_id = ? ORDER BY ct.id DESC`).all(auctionId, team.id);
  }
  res.json({ transactions: rows });
});

router.get('/my/purchases', requireRole('MANAGER', 'ADMIN'), (req, res) => {
  const team = getTeamForUser(req.user.id);
  if (!team) return res.json({ purchases: [] });
  const purchases = db.prepare(`
    SELECT ar.*, a.name AS auction_name, u.display_name AS player_name, p.game_id, p.avatar
    FROM auction_results ar JOIN auctions a ON a.id = ar.auction_id
    JOIN users u ON u.id = ar.player_user_id
    LEFT JOIN player_profiles p ON p.user_id = ar.player_user_id
    WHERE ar.team_id = ? AND ar.status = 'SOLD' ORDER BY ar.id DESC`).all(team.id);
  res.json({ purchases });
});

module.exports = { router, getTeamForUser, auctionState };
