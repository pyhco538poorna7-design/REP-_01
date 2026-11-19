'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { requireAuth, requireRole, audit, notify } = require('../auth');

const router = express.Router();
const adminOnly = requireRole('ADMIN');

router.get('/users', requireRole('ADMIN', 'MOD'), (req, res) => {
  const { role, status, q } = req.query;
  let sql = `SELECT u.id, u.username, u.role, u.display_name, u.status, u.created_at, u.last_login,
    p.game_id, p.kills, p.booyahs, p.matches, p.team_id, t.name AS team_name,
    mp.approved AS manager_approved, mp.team_id AS manager_team_id, mt.name AS manager_team_name
    FROM users u
    LEFT JOIN player_profiles p ON p.user_id = u.id
    LEFT JOIN teams t ON t.id = p.team_id
    LEFT JOIN manager_profiles mp ON mp.user_id = u.id
    LEFT JOIN teams mt ON mt.id = mp.team_id
    WHERE 1=1`;
  const args = [];
  if (role) { sql += ' AND u.role = ?'; args.push(role); }
  if (status) { sql += ' AND u.status = ?'; args.push(status); }
  if (q) { sql += ' AND (u.username LIKE ? OR u.display_name LIKE ?)'; args.push(`%${q}%`, `%${q}%`); }
  sql += ' ORDER BY u.role, u.username';
  res.json({ users: db.prepare(sql).all(...args) });
});

router.post('/users', adminOnly, (req, res) => {
  const { username, password, role, display_name } = req.body || {};
  if (!username || !password || !role || !display_name) return res.status(400).json({ error: 'All fields are required.' });
  if (!['ADMIN', 'MOD', 'MANAGER', 'PLAYER'].includes(role)) return res.status(400).json({ error: 'Invalid role.' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return res.status(409).json({ error: 'Username already taken.' });
  const uid = db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?,?,?,?)')
    .run(username, bcrypt.hashSync(password, 10), role, display_name).lastInsertRowid;
  if (role === 'PLAYER') db.prepare('INSERT INTO player_profiles (user_id) VALUES (?)').run(uid);
  if (role === 'MANAGER') db.prepare('INSERT INTO manager_profiles (user_id, approved) VALUES (?,1)').run(uid);
  audit(req.user.id, 'user_create', { username, role });
  notify(uid, 'account', 'Account created', `Your ${role} account was created by an administrator.`);
  res.status(201).json({ message: 'User created.', user_id: uid });
});

router.patch('/users/:id', adminOnly, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  const { role, status, password, display_name } = req.body || {};
  const tx = db.transaction(() => {
    if (role && ['ADMIN', 'MOD', 'MANAGER', 'PLAYER'].includes(role) && role !== target.role) {
      db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, target.id);
      if (role === 'PLAYER' && !db.prepare('SELECT 1 FROM player_profiles WHERE user_id = ?').get(target.id)) {
        db.prepare('INSERT INTO player_profiles (user_id) VALUES (?)').run(target.id);
      }
      if (role === 'MANAGER' && !db.prepare('SELECT 1 FROM manager_profiles WHERE user_id = ?').get(target.id)) {
        db.prepare('INSERT INTO manager_profiles (user_id, approved) VALUES (?,1)').run(target.id);
      }
    }
    if (status && ['active', 'suspended'].includes(status)) {
      db.prepare('UPDATE users SET status = ? WHERE id = ?').run(status, target.id);
      if (status === 'suspended') db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    }
    if (password) {
      if (String(password).length < 6) throw new Error('Password must be at least 6 characters.');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), target.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(target.id);
    }
    if (display_name) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(String(display_name).slice(0, 60), target.id);
  });
  try { tx(); } catch (e) { return res.status(400).json({ error: e.message }); }
  audit(req.user.id, 'user_update', { target: target.username, changes: { role, status, password: !!password, display_name } });
  res.json({ message: 'User updated.' });
});

router.delete('/users/:id', adminOnly, (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
  db.prepare('DELETE FROM users WHERE id = ?').run(target.id);
  audit(req.user.id, 'user_delete', { username: target.username, role: target.role });
  res.json({ message: 'User removed.' });
});

// ---------- Database backup / restore (protects data across platform resets) ----------
const BACKUP_TABLES = ['users', 'teams', 'player_profiles', 'manager_profiles', 'team_members', 'auctions',
  'auction_registrations', 'auction_teams', 'bids', 'auction_results', 'credit_transactions',
  'matches', 'match_teams', 'match_results', 'messages', 'notifications', 'notification_reads',
  'announcements', 'audit_logs', 'match_proofs'];

router.get('/backup', adminOnly, (req, res) => {
  const dump = { exported_at: new Date().toISOString(), version: 1 };
  for (const t of BACKUP_TABLES) dump[t] = db.prepare(`SELECT * FROM ${t}`).all();
  res.setHeader('Content-Disposition', `attachment; filename="ffclub-backup-${new Date().toISOString().slice(0, 10)}.json"`);
  res.json(dump);
});

router.post('/restore', adminOnly, (req, res) => {
  const dump = req.body || {};
  if (!Array.isArray(dump.users) || !Array.isArray(dump.teams)) {
    return res.status(400).json({ error: 'Not a valid backup file (missing users/teams).' });
  }
  const restored = {};
  db.pragma('foreign_keys = OFF');
  const tx = db.transaction(() => {
    for (const t of [...BACKUP_TABLES].reverse()) db.prepare(`DELETE FROM ${t}`).run();
    for (const t of BACKUP_TABLES) {
      const rows = dump[t] || [];
      if (!rows.length) { restored[t] = 0; continue; }
      const cols = Object.keys(rows[0]).filter((c) => c !== 'sessions');
      const ins = db.prepare(`INSERT OR REPLACE INTO ${t} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      for (const row of rows) ins.run(...cols.map((c) => row[c]));
      restored[t] = rows.length;
    }
  });
  try {
    tx();
  } finally {
    db.pragma('foreign_keys = ON');
  }
  audit(req.user.id, 'db_restore', restored);
  res.json({ message: 'Database restored. All members are back.', restored });
});

// Manager registration approvals
router.get('/managers', adminOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.status, u.role, mp.contact, mp.approved, u.created_at,
      t.id AS team_id, t.name AS team_name, t.logo AS team_logo,
      (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id) AS members,
      COALESCE((SELECT SUM(CASE WHEN mr.position = 1 THEN 1 ELSE 0 END) FROM match_results mr WHERE mr.team_id = t.id), 0) AS wins,
      COALESCE((SELECT SUM(mr.kills) FROM match_results mr WHERE mr.team_id = t.id), 0) AS total_kills
    FROM users u JOIN manager_profiles mp ON mp.user_id = u.id
    JOIN teams t ON t.id = mp.team_id
    ORDER BY wins DESC, total_kills DESC, u.username ASC`).all();
  res.json({ managers: rows });
});

router.get('/manager-registrations', adminOnly, (req, res) => {
  const rows = db.prepare(`
    SELECT u.id, u.username, u.display_name, u.status, mp.contact, mp.approved, mp.team_id, t.name AS team_name
    FROM users u JOIN manager_profiles mp ON mp.user_id = u.id
    LEFT JOIN teams t ON t.id = mp.team_id
    WHERE mp.approved = 0 ORDER BY u.created_at DESC`).all();
  res.json({ registrations: rows });
});

router.post('/manager-registrations/:userId/approve', adminOnly, (req, res) => {
  const mp = db.prepare('SELECT * FROM manager_profiles WHERE user_id = ?').get(req.params.userId);
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.params.userId);
  if (!mp || !user) return res.status(404).json({ error: 'Manager registration not found.' });
  if (mp.approved) return res.status(400).json({ error: 'Already approved.' });
  const { team_name, team_logo } = req.body || {};
  const name = team_name || `${user.display_name}'s Team`;
  const tx = db.transaction(() => {
    const existing = db.prepare('SELECT id FROM teams WHERE name = ?').get(name);
    const teamId = existing ? existing.id
      : db.prepare('INSERT INTO teams (name, logo, owner_user_id) VALUES (?,?,?)').run(name, team_logo || '🛡️', user.id).lastInsertRowid;
    db.prepare('UPDATE manager_profiles SET approved = 1, team_id = ? WHERE user_id = ?').run(teamId, user.id);
    return teamId;
  });
  tx();
  audit(req.user.id, 'manager_approve', { username: user.username });
  notify(user.id, 'account', 'Manager approved', 'Your manager registration was approved. Visit your Team Center to get started.');
  res.json({ message: 'Manager approved.' });
});

router.post('/manager-registrations/:userId/reject', adminOnly, (req, res) => {
  const mp = db.prepare('SELECT * FROM manager_profiles WHERE user_id = ?').get(req.params.userId);
  if (!mp) return res.status(404).json({ error: 'Manager registration not found.' });
  db.prepare('DELETE FROM manager_profiles WHERE user_id = ?').run(req.params.userId);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.userId);
  audit(req.user.id, 'manager_reject', { userId: req.params.userId });
  res.json({ message: 'Manager registration rejected and removed.' });
});

// Player statistics (official) — ADMIN only
router.patch('/players/:userId/stats', adminOnly, (req, res) => {
  const p = db.prepare('SELECT * FROM player_profiles WHERE user_id = ?').get(req.params.userId);
  if (!p) return res.status(404).json({ error: 'Player profile not found.' });
  const { kills, booyahs, matches } = req.body || {};
  const k = kills != null ? Math.max(0, parseInt(kills, 10)) : p.kills;
  const b = booyahs != null ? Math.max(0, parseInt(booyahs, 10)) : p.booyahs;
  const m = matches != null ? Math.max(0, parseInt(matches, 10)) : p.matches;
  db.prepare('UPDATE player_profiles SET kills = ?, booyahs = ?, matches = ? WHERE user_id = ?').run(k, b, m, p.user_id);
  audit(req.user.id, 'player_stats_update', { user_id: p.user_id, kills: k, booyahs: b, matches: m });
  res.json({ message: 'Player statistics updated.' });
});

// Teams management
router.get('/teams', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT t.*, u.display_name AS owner_name, u.username AS owner_username,
      COALESCE((SELECT SUM(mr.kills) FROM match_results mr WHERE mr.team_id = t.id), 0) AS total_kills,
      COALESCE((SELECT COUNT(*) FROM match_results mr WHERE mr.team_id = t.id AND mr.position = 1), 0) AS total_booyahs,
      (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = t.id) AS member_count
    FROM teams t LEFT JOIN users u ON u.id = t.owner_user_id
    ORDER BY t.name`).all();
  rows.forEach((r) => { r.kill_points = r.total_kills + r.total_booyahs * 3; });
  res.json({ teams: rows });
});

router.post('/teams', adminOnly, (req, res) => {
  const { name, logo, owner_user_id } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Team name is required.' });
  if (db.prepare('SELECT id FROM teams WHERE name = ?').get(name)) return res.status(409).json({ error: 'Team name already exists.' });
  const tid = db.prepare('INSERT INTO teams (name, logo, owner_user_id) VALUES (?,?,?)')
    .run(name, logo || '🛡️', owner_user_id || null).lastInsertRowid;
  if (owner_user_id) {
    db.prepare('INSERT OR IGNORE INTO manager_profiles (user_id, approved) VALUES (?,1)').run(owner_user_id);
    db.prepare('UPDATE manager_profiles SET team_id = ?, approved = 1 WHERE user_id = ?').run(tid, owner_user_id);
  }
  audit(req.user.id, 'team_create', { name });
  res.status(201).json({ message: 'Team created.', team_id: tid });
});

router.patch('/teams/:id', requireAuth, (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found.' });
  const isOwner = team.owner_user_id === req.user.id;
  if (!isOwner && req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Only the team manager or an admin can edit this team.' });
  const { name, logo } = req.body || {};
  if (name && name !== team.name) {
    if (db.prepare('SELECT id FROM teams WHERE name = ? AND id != ?').get(name, team.id)) return res.status(409).json({ error: 'Team name already exists.' });
    db.prepare('UPDATE teams SET name = ? WHERE id = ?').run(name, team.id);
  }
  if (logo) db.prepare('UPDATE teams SET logo = ? WHERE id = ?').run(String(logo).slice(0, 16), team.id);
  audit(req.user.id, 'team_update', { team_id: team.id, name, logo });
  res.json({ message: 'Team updated.' });
});

router.post('/teams/:id/members', requireRole('ADMIN'), (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found.' });
  const { player_user_id } = req.body || {};
  const player = db.prepare(`SELECT u.id, u.display_name, p.team_id FROM users u JOIN player_profiles p ON p.user_id = u.id WHERE u.id = ? AND u.role = 'PLAYER'`).get(player_user_id);
  if (!player) return res.status(404).json({ error: 'Player not found.' });
  if (player.team_id) return res.status(409).json({ error: 'Player is already on a team.' });
  if (db.prepare('SELECT COUNT(*) AS c FROM team_members WHERE team_id = ?').get(team.id).c >= 4) return res.status(409).json({ error: 'Team roster is full (4 players max).' });
  db.prepare('INSERT INTO team_members (team_id, player_user_id, source) VALUES (?,?,?)').run(team.id, player.id, 'admin');
  db.prepare('UPDATE player_profiles SET team_id = ? WHERE user_id = ?').run(team.id, player.id);
  audit(req.user.id, 'team_member_add', { team: team.name, player: player.display_name });
  notify(player.id, 'team', 'Team assignment', `You were added to ${team.name}.`);
  res.json({ message: 'Player added to team.' });
});

router.delete('/teams/:id/members/:playerId', requireAuth, (req, res) => {
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(req.params.id);
  if (!team) return res.status(404).json({ error: 'Team not found.' });
  const isOwner = team.owner_user_id === req.user.id;
  if (!isOwner && req.user.role !== 'ADMIN') return res.status(403).json({ error: 'Only the team manager or an admin can remove members.' });
  const row = db.prepare('SELECT * FROM team_members WHERE team_id = ? AND player_user_id = ?').get(team.id, req.params.playerId);
  if (!row) return res.status(404).json({ error: 'Player is not a member of this team.' });
  db.prepare('DELETE FROM team_members WHERE id = ?').run(row.id);
  db.prepare('UPDATE player_profiles SET team_id = NULL WHERE user_id = ?').run(req.params.playerId);
  audit(req.user.id, 'team_member_remove', { team: team.name, player_user_id: req.params.playerId });
  notify(Number(req.params.playerId), 'team', 'Team update', `You were removed from ${team.name}.`);
  res.json({ message: 'Player removed from team.' });
});

// Admin overview + audit logs
router.get('/overview', requireRole('ADMIN', 'MOD'), (req, res) => {
  const c = (sql) => db.prepare(sql).get().c;
  res.json({
    players: c('SELECT COUNT(*) c FROM users WHERE role = \'PLAYER\''),
    managers: c('SELECT COUNT(*) c FROM users WHERE role = \'MANAGER\''),
    mods: c('SELECT COUNT(*) c FROM users WHERE role = \'MOD\''),
    teams: c('SELECT COUNT(*) c FROM teams'),
    auctions: c('SELECT COUNT(*) c FROM auctions'),
    live_auctions: c('SELECT COUNT(*) c FROM auctions WHERE status = \'live\''),
    matches: c('SELECT COUNT(*) c FROM matches'),
    upcoming_matches: c('SELECT COUNT(*) c FROM matches WHERE status = \'upcoming\''),
    pending_player_regs: c('SELECT COUNT(*) c FROM auction_registrations WHERE status = \'pending\''),
    pending_manager_regs: c('SELECT COUNT(*) c FROM manager_profiles WHERE approved = 0'),
  });
});

router.get('/audit-logs', requireRole('ADMIN'), (req, res) => {
  const limit = Math.min(parseInt(req.query.limit || '200', 10), 500);
  const rows = db.prepare(`
    SELECT a.*, u.username AS actor_username FROM audit_logs a
    LEFT JOIN users u ON u.id = a.actor_id
    ORDER BY a.id DESC LIMIT ?`).all(limit);
  res.json({ logs: rows });
});

module.exports = { router };
