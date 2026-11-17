'use strict';
const express = require('express');
const db = require('../db');
const { requireAuth, requireRole, audit, notify, notifyAll } = require('../auth');
const { getTeamForUser } = require('./auctionRoutes');

const router = express.Router();

function canSeeRoom(user, matchId) {
  if (user.role === 'ADMIN' || user.role === 'MOD') return true;
  if (user.role === 'MANAGER') {
    const team = getTeamForUser(user.id);
    if (team && db.prepare('SELECT id FROM match_teams WHERE match_id = ? AND team_id = ?').get(matchId, team.id)) return true;
  }
  if (user.role === 'PLAYER') {
    const p = db.prepare('SELECT team_id FROM player_profiles WHERE user_id = ?').get(user.id);
    if (p && p.team_id && db.prepare('SELECT id FROM match_teams WHERE match_id = ? AND team_id = ?').get(matchId, p.team_id)) return true;
  }
  return false;
}

function serializeMatch(m, user) {
  const teams = db.prepare(`
    SELECT mt.team_id, t.name, t.logo FROM match_teams mt JOIN teams t ON t.id = mt.team_id
    WHERE mt.match_id = ? ORDER BY t.name`).all(m.id);
  const results = db.prepare(`
    SELECT mr.team_id, mr.kills, mr.position, t.name, t.logo FROM match_results mr
    JOIN teams t ON t.id = mr.team_id WHERE mr.match_id = ? ORDER BY mr.position, mr.kills DESC`).all(m.id);
  const authorized = !!(m.room_published && canSeeRoom(user, m.id));
  return {
    ...m,
    teams,
    results,
    my_registration: user && (user.role === 'MANAGER' || user.role === 'ADMIN')
      ? (() => { const team = getTeamForUser(user.id); return team ? teams.some((t) => t.team_id === team.id) : false; })()
      : null,
    room_access: authorized,
    room_id: authorized ? m.room_id : null,
    room_password: authorized ? m.room_password : null,
  };
}

router.get('/matches', requireAuth, (req, res) => {
  const { status } = req.query;
  let sql = 'SELECT * FROM matches';
  const args = [];
  if (status) { sql += ' WHERE status = ?'; args.push(status); }
  sql += ' ORDER BY match_date DESC, match_time DESC';
  const rows = db.prepare(sql).all(...args);
  res.json({ matches: rows.map((m) => serializeMatch(m, req.user)) });
});

router.get('/matches/:id', requireAuth, (req, res) => {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Match not found.' });
  res.json({ match: serializeMatch(m, req.user) });
});

router.post('/matches', requireRole('MOD', 'ADMIN'), (req, res) => {
  const { tournament_name, match_date, match_time, room_id, room_password, room_published } = req.body || {};
  if (!tournament_name || !match_date || !match_time) return res.status(400).json({ error: 'Tournament name, date and time are required.' });
  const id = db.prepare(`
    INSERT INTO matches (tournament_name, match_date, match_time, room_id, room_password, room_published, status, created_by)
    VALUES (?,?,?,?,?,?, 'upcoming', ?)`)
    .run(tournament_name, match_date, match_time, room_id || '', room_password || '', room_published ? 1 : 0, req.user.id).lastInsertRowid;
  audit(req.user.id, 'match_create', { id, tournament_name });
  notifyAll('match', 'New match scheduled', `${tournament_name} — ${match_date} at ${match_time}. Managers can register their teams.`);
  res.status(201).json({ message: 'Match created.', match_id: id });
});

router.patch('/matches/:id', requireRole('MOD', 'ADMIN'), (req, res) => {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Match not found.' });
  const { tournament_name, match_date, match_time, room_id, room_password, room_published, status } = req.body || {};
  const wasPublished = m.room_published;
  if (tournament_name) db.prepare('UPDATE matches SET tournament_name = ? WHERE id = ?').run(tournament_name, m.id);
  if (match_date) db.prepare('UPDATE matches SET match_date = ? WHERE id = ?').run(match_date, m.id);
  if (match_time) db.prepare('UPDATE matches SET match_time = ? WHERE id = ?').run(match_time, m.id);
  if (room_id != null) db.prepare('UPDATE matches SET room_id = ? WHERE id = ?').run(room_id, m.id);
  if (room_password != null) db.prepare('UPDATE matches SET room_password = ? WHERE id = ?').run(room_password, m.id);
  if (room_published != null) db.prepare('UPDATE matches SET room_published = ? WHERE id = ?').run(room_published ? 1 : 0, m.id);
  if (status && ['upcoming', 'live', 'completed'].includes(status)) db.prepare('UPDATE matches SET status = ? WHERE id = ?').run(status, m.id);
  const updated = db.prepare('SELECT * FROM matches WHERE id = ?').get(m.id);
  audit(req.user.id, 'match_update', { id: m.id, changes: { tournament_name, match_date, match_time, status, room_published } });
  if (!wasPublished && updated.room_published && updated.room_id) {
    const teamIds = db.prepare('SELECT team_id FROM match_teams WHERE match_id = ?').all(m.id).map((r) => r.team_id);
    const memberIds = [];
    for (const tid of teamIds) {
      const owner = db.prepare('SELECT owner_user_id FROM teams WHERE id = ?').get(tid);
      if (owner && owner.owner_user_id) memberIds.push(owner.owner_user_id);
      db.prepare('SELECT player_user_id FROM team_members WHERE team_id = ?').all(tid)
        .forEach((r) => memberIds.push(r.player_user_id));
    }
    notify([...new Set(memberIds)], 'match', 'Match room details published',
      `Room ID and password for ${updated.tournament_name} (${updated.match_date} ${updated.match_time}) are now available in the match page.`);
  }
  if (status === 'live' && m.status !== 'live') {
    notifyAll('match', 'Match is LIVE', `${updated.tournament_name} is starting now.`);
  }
  res.json({ message: 'Match updated.' });
});

router.post('/matches/:id/register', requireRole('MANAGER', 'ADMIN'), (req, res) => {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Match not found.' });
  if (m.status !== 'upcoming') return res.status(400).json({ error: 'Registration is only open for upcoming matches.' });
  const team = getTeamForUser(req.user.id);
  if (!team) return res.status(403).json({ error: 'You do not manage a registered team.' });
  const existing = db.prepare('SELECT id FROM match_teams WHERE match_id = ? AND team_id = ?').get(m.id, team.id);
  if (existing) return res.status(409).json({ error: 'Your team is already registered for this match.' });
  db.prepare('INSERT INTO match_teams (match_id, team_id) VALUES (?,?)').run(m.id, team.id);
  audit(req.user.id, 'match_register', { match_id: m.id, team_id: team.id });
  notify(req.user.id, 'match', 'Match registration confirmed', `${team.name} is registered for ${m.tournament_name} (${m.match_date} ${m.match_time}).`);
  res.status(201).json({ message: `${team.name} registered for ${m.tournament_name}.` });
});

router.delete('/matches/:id/register', requireRole('MANAGER', 'ADMIN'), (req, res) => {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Match not found.' });
  const team = getTeamForUser(req.user.id);
  if (!team) return res.status(403).json({ error: 'You do not manage a team.' });
  const row = db.prepare('SELECT id FROM match_teams WHERE match_id = ? AND team_id = ?').get(m.id, team.id);
  if (!row) return res.status(404).json({ error: 'Your team is not registered for this match.' });
  db.prepare('DELETE FROM match_teams WHERE id = ?').run(row.id);
  audit(req.user.id, 'match_unregister', { match_id: m.id, team_id: team.id });
  res.json({ message: 'Registration withdrawn.' });
});

router.post('/matches/:id/results', requireRole('MOD', 'ADMIN'), (req, res) => {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Match not found.' });
  const { team_id, kills, position } = req.body || {};
  const team = db.prepare('SELECT * FROM teams WHERE id = ?').get(team_id);
  if (!team) return res.status(404).json({ error: 'Team not found.' });
  if (!db.prepare('SELECT id FROM match_teams WHERE match_id = ? AND team_id = ?').get(m.id, team.id)) {
    return res.status(400).json({ error: 'This team is not registered for the match.' });
  }
  const existing = db.prepare('SELECT id FROM match_results WHERE match_id = ? AND team_id = ?').get(m.id, team.id);
  const k = Math.max(0, parseInt(kills, 10) || 0);
  const pos = Math.max(0, parseInt(position, 10) || 0);
  if (existing) {
    db.prepare('UPDATE match_results SET kills = ?, position = ? WHERE id = ?').run(k, pos, existing.id);
  } else {
    db.prepare('INSERT INTO match_results (match_id, team_id, kills, position) VALUES (?,?,?,?)').run(m.id, team.id, k, pos);
  }
  audit(req.user.id, 'match_result', { match_id: m.id, team_id: team.id, kills: k, position: pos });
  res.json({ message: 'Match result recorded.' });
});

module.exports = { router };
