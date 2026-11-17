'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole, audit, notify, notifyRole } = require('../auth');
const { getTeamForUser } = require('./auctionRoutes');

const router = express.Router();

// ---------- Leaderboards ----------
router.get('/leaderboards/kills', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.display_name AS player_name, u.username, p.game_id, p.avatar, p.kills,
      p.team_id, t.name AS team_name, t.logo AS team_logo
    FROM users u JOIN player_profiles p ON p.user_id = u.id
    LEFT JOIN teams t ON t.id = p.team_id
    WHERE u.role = 'PLAYER' AND u.status = 'active'
    ORDER BY p.kills DESC, u.display_name LIMIT 100`).all();
  rows.forEach((r, i) => { r.rank = i + 1; });
  res.json({ leaderboard: rows });
});

router.get('/leaderboards/teams', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT t.id, t.name, t.logo,
      COALESCE((SELECT SUM(mr.kills) FROM match_results mr WHERE mr.team_id = t.id), 0) AS total_kills,
      COALESCE((SELECT COUNT(*) FROM match_results mr WHERE mr.team_id = t.id AND mr.position = 1), 0) AS total_booyahs,
      (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id) AS member_count
    FROM teams t ORDER BY t.name`).all();
  rows.forEach((r) => { r.kill_points = r.total_kills + r.total_booyahs * 3; });
  rows.sort((a, b) => b.kill_points - a.kill_points || b.total_kills - a.total_kills);
  rows.forEach((r, i) => { r.rank = i + 1; });
  res.json({ leaderboard: rows });
});

router.get('/leaderboards/booyahs', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT t.id, t.name, t.logo,
      COALESCE((SELECT COUNT(*) FROM match_results mr WHERE mr.team_id = t.id AND mr.position = 1), 0) AS total_booyahs,
      COALESCE((SELECT SUM(mr.kills) FROM match_results mr WHERE mr.team_id = t.id), 0) AS total_kills
    FROM teams t ORDER BY t.name`).all();
  rows.sort((a, b) => b.total_booyahs - a.total_booyahs || b.total_kills - a.total_kills);
  rows.forEach((r, i) => { r.rank = i + 1; });
  res.json({ leaderboard: rows });
});

// ---------- Dashboard ----------
router.get('/dashboard', requireAuth, (req, res) => {
  const c = (sql) => db.prepare(sql).get().c;
  const latestResults = db.prepare(`
    SELECT mr.match_id, mr.team_id, mr.kills, mr.position, m.tournament_name, m.match_date,
      t.name AS team_name, t.logo AS team_logo
    FROM match_results mr JOIN matches m ON m.id = mr.match_id JOIN teams t ON t.id = mr.team_id
    WHERE m.status = 'completed'
    ORDER BY m.match_date DESC, m.id DESC, mr.position LIMIT 12`).all();
  const upcoming = db.prepare(`
    SELECT m.id, m.tournament_name, m.match_date, m.match_time, m.status,
      (SELECT COUNT(*) FROM match_teams mt WHERE mt.match_id = m.id) AS team_count
    FROM matches m WHERE m.status = 'upcoming' ORDER BY m.match_date LIMIT 5`).all();
  const auctions = db.prepare(`
    SELECT id, name, auction_date, start_time, status FROM auctions
    WHERE status IN ('upcoming','live','paused') ORDER BY id DESC LIMIT 5`).all();
  const announcements = db.prepare(`
    SELECT a.*, u.display_name AS author FROM announcements a
    LEFT JOIN users u ON u.id = a.author_id ORDER BY a.id DESC LIMIT 5`).all();
  res.json({
    stats: {
      players: c('SELECT COUNT(*) c FROM users WHERE role = \'PLAYER\''),
      teams: c('SELECT COUNT(*) c FROM teams'),
      matches: c('SELECT COUNT(*) c FROM matches'),
      upcoming_matches: c('SELECT COUNT(*) c FROM matches WHERE status = \'upcoming\''),
      live_auctions: c('SELECT COUNT(*) c FROM auctions WHERE status = \'live\''),
    },
    latest_results: latestResults,
    upcoming_matches: upcoming,
    auctions,
    announcements,
  });
});

// ---------- Announcements ----------
router.get('/announcements', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT a.*, u.display_name AS author, u.role AS author_role FROM announcements a
    LEFT JOIN users u ON u.id = a.author_id ORDER BY a.id DESC LIMIT 50`).all();
  res.json({ announcements: rows });
});

router.post('/announcements', requireRole('ADMIN', 'MOD'), (req, res) => {
  const { title, body, audience } = req.body || {};
  if (!title || !body) return res.status(400).json({ error: 'Title and body are required.' });
  const id = db.prepare('INSERT INTO announcements (author_id, title, body) VALUES (?,?,?)')
    .run(req.user.id, title, body).lastInsertRowid;
  audit(req.user.id, 'announcement_create', { title });
  if (audience === 'team') {
    notifyRole('MANAGER', 'announcement', 'Announcement', title);
    notifyRole('PLAYER', 'announcement', 'Announcement', title);
  } else {
    notifyRole('ADMIN', 'announcement', 'Announcement', title);
    notifyRole('MOD', 'announcement', 'Announcement', title);
    notifyRole('MANAGER', 'announcement', 'Announcement', title);
    notifyRole('PLAYER', 'announcement', 'Announcement', title);
  }
  res.status(201).json({ message: 'Announcement published.', announcement_id: id });
});

router.delete('/announcements/:id', requireRole('ADMIN'), (req, res) => {
  db.prepare('DELETE FROM announcements WHERE id = ?').run(req.params.id);
  audit(req.user.id, 'announcement_delete', { id: req.params.id });
  res.json({ message: 'Announcement deleted.' });
});

// ---------- Notifications ----------
router.get('/notifications', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT n.*, (SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND r.user_id = ?) AS is_read
    FROM notifications n WHERE n.user_id = ? ORDER BY n.id DESC LIMIT 100`).all(req.user.id, req.user.id);
  res.json({ notifications: rows, unread: rows.filter((r) => !r.is_read).length });
});

router.post('/notifications/read', requireAuth, (req, res) => {
  const ins = db.prepare('INSERT OR IGNORE INTO notification_reads (notification_id, user_id) VALUES (?,?)');
  const tx = db.transaction(() => {
    db.prepare('SELECT id FROM notifications WHERE user_id = ? AND id NOT IN (SELECT notification_id FROM notification_reads WHERE user_id = ?)')
      .all(req.user.id, req.user.id)
      .forEach((r) => ins.run(r.id, req.user.id));
  });
  tx();
  res.json({ message: 'All notifications marked as read.' });
});

// ---------- Team Center ----------
router.get('/teams/:id', requireAuth, (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found.' });
  const isOwner = team.owner_user_id === req.user.id;
  const isMember = req.user.role === 'PLAYER' && db.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND player_user_id = ?').get(team.id, req.user.id);
  if (!isOwner && !isMember && req.user.role !== 'ADMIN' && req.user.role !== 'MOD') {
    return res.status(403).json({ error: 'This Team Center is private.' });
  }
  const members = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.status, p.game_id, p.avatar, p.roles, p.kills, p.booyahs, p.matches, tm.source, tm.joined_at
    FROM team_members tm JOIN users u ON u.id = tm.player_user_id
    JOIN player_profiles p ON p.user_id = u.id
    WHERE tm.team_id = ? ORDER BY p.kills DESC`).all(team.id);
  members.forEach((m) => { try { m.roles = JSON.parse(m.roles || '[]'); } catch { m.roles = []; } });
  const totals = db.prepare(`
    SELECT COALESCE(SUM(kills), 0) AS total_kills, COALESCE(SUM(CASE WHEN position = 1 THEN 1 ELSE 0 END), 0) AS total_booyahs
    FROM match_results WHERE team_id = ?`).get(team.id);
  const upcomingMatches = db.prepare(`
    SELECT m.* FROM matches m JOIN match_teams mt ON mt.match_id = m.id
    WHERE mt.team_id = ? AND m.status = 'upcoming' ORDER BY m.match_date`).all(team.id);
  const pastMatches = db.prepare(`
    SELECT m.id, m.tournament_name, m.match_date, m.match_time, m.status, mr.kills, mr.position
    FROM matches m JOIN match_results mr ON mr.match_id = m.id AND mr.team_id = ?
    ORDER BY m.match_date DESC LIMIT 20`).all(team.id);
  const purchases = db.prepare(`
    SELECT ar.*, a.name AS auction_name, u.display_name AS player_name, p.game_id
    FROM auction_results ar JOIN auctions a ON a.id = ar.auction_id
    JOIN users u ON u.id = ar.player_user_id LEFT JOIN player_profiles p ON p.user_id = ar.player_user_id
    WHERE ar.team_id = ? AND ar.status = 'SOLD' ORDER BY ar.id DESC`).all(team.id);
  const activeAuction = db.prepare(`SELECT * FROM auctions WHERE status IN ('live','upcoming','paused') ORDER BY id DESC LIMIT 1`).get();
  let credits = null;
  if (activeAuction) {
    const at = db.prepare('SELECT * FROM auction_teams WHERE auction_id = ? AND team_id = ?').get(activeAuction.id, team.id);
    if (at) credits = { auction_id: activeAuction.id, auction_name: activeAuction.name, credits: at.credits, spent: at.spent, available: at.credits - at.spent };
  }
  const owner = team.owner_user_id ? db.prepare('SELECT username, display_name FROM users WHERE id = ?').get(team.owner_user_id) : null;
  res.json({
    team: { ...team, owner },
    members, totals, credits,
    upcoming_matches: upcomingMatches,
    past_matches: pastMatches,
    purchases,
    can_manage: isOwner || req.user.role === 'ADMIN',
  });
});

// Free agents (players without a team) — for managers/admins
router.get('/free-agents', requireRole('MANAGER', 'ADMIN'), (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.display_name, u.username, p.game_id, p.avatar, p.roles, p.kills, p.booyahs, p.matches, p.previous_team
    FROM users u JOIN player_profiles p ON p.user_id = u.id
    WHERE u.role = 'PLAYER' AND u.status = 'active' AND p.team_id IS NULL
    ORDER BY p.kills DESC`).all();
  rows.forEach((r) => { try { r.roles = JSON.parse(r.roles || '[]'); } catch { r.roles = []; } });
  res.json({ players: rows });
});

// ---------- Team chat REST fallback ----------
router.get('/chat/:teamId', requireAuth, (req, res) => {
  const teamId = Number(req.params.teamId);
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  if (!team) return res.status(404).json({ error: 'Team not found.' });
  const isOwner = team.owner_user_id === req.user.id;
  const isMember = db.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND player_user_id = ?').get(teamId, req.user.id);
  if (!isOwner && !isMember && req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'This chat is private to the team.' });
  }
  const messages = db.prepare(`
    SELECT m.*, u.username, u.display_name, u.role FROM messages m
    JOIN users u ON u.id = m.user_id WHERE m.team_id = ? ORDER BY m.id ASC LIMIT 200`).all(teamId);
  res.json({ messages });
});

router.post('/chat/:teamId', requireAuth, (req, res) => {
  const teamId = Number(req.params.teamId);
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(teamId);
  if (!team) return res.status(404).json({ error: 'Team not found.' });
  const isOwner = team.owner_user_id === req.user.id;
  const isMember = db.prepare('SELECT 1 FROM team_members WHERE team_id = ? AND player_user_id = ?').get(teamId, req.user.id);
  if (!isOwner && !isMember && req.user.role !== 'ADMIN') {
    return res.status(403).json({ error: 'This chat is private to the team.' });
  }
  const content = String(req.body && req.body.content || '').trim().slice(0, 1000);
  if (!content) return res.status(400).json({ error: 'Message cannot be empty.' });
  const info = db.prepare('INSERT INTO messages (team_id, user_id, content) VALUES (?,?,?)').run(teamId, req.user.id, content);
  const message = db.prepare(`
    SELECT m.*, u.username, u.display_name, u.role FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?`).get(info.lastInsertRowid);
  res.status(201).json({ message });
});

// ---------- Players directory ----------
router.get('/players', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.status, p.game_id, p.avatar, p.roles, p.kills, p.booyahs, p.matches,
      p.team_id, t.name AS team_name, t.logo AS team_logo
    FROM users u JOIN player_profiles p ON p.user_id = u.id
    LEFT JOIN teams t ON t.id = p.team_id
    WHERE u.role = 'PLAYER' ORDER BY p.kills DESC`).all();
  rows.forEach((r) => { try { r.roles = JSON.parse(r.roles || '[]'); } catch { r.roles = []; } });
  res.json({ players: rows });
});

module.exports = { router };
