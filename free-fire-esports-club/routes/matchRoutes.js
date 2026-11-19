'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, requireRole, audit, notify, notifyRole, notifyAll } = require('../auth');
const { getTeamForUser } = require('./auctionRoutes');

const router = express.Router();

const DATA_DIR = process.env.FF_DATA_DIR || path.join(__dirname, '..', 'data');

const MAX_SQUAD = 4;
const MAX_ROOM_TEAMS = 12;
const MAX_ROOM_PLAYERS = MAX_ROOM_TEAMS * MAX_SQUAD;
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });


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
    SELECT mt.team_id, t.name, t.logo, (SELECT COUNT(*) FROM team_members tm WHERE tm.team_id = mt.team_id) AS member_count FROM match_teams mt JOIN teams t ON t.id = mt.team_id
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
  const teamCount = db.prepare('SELECT COUNT(*) AS c FROM match_teams WHERE match_id = ?').get(m.id).c;
  if (teamCount >= MAX_ROOM_TEAMS) return res.status(409).json({ error: `Room is full — max ${MAX_ROOM_TEAMS} teams (${MAX_ROOM_PLAYERS} players) per match.` });
  const squadCount = db.prepare('SELECT COUNT(*) AS c FROM team_members WHERE team_id = ?').get(team.id).c;
  if (squadCount > MAX_SQUAD) return res.status(400).json({ error: `Your squad has ${squadCount} players — max ${MAX_SQUAD} per team in a room. Trim your lineup first.` });
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

// ---------- Fair-play video proof (winning team) ----------
function isMatchParticipant(user, matchId) {
  if (user.role === 'ADMIN' || user.role === 'MOD') return true;
  if (user.role === 'MANAGER') {
    const team = getTeamForUser(user.id);
    return !!(team && db.prepare('SELECT id FROM match_teams WHERE match_id = ? AND team_id = ?').get(matchId, team.id));
  }
  if (user.role === 'PLAYER') {
    const p = db.prepare('SELECT team_id FROM player_profiles WHERE user_id = ?').get(user.id);
    return !!(p && p.team_id && db.prepare('SELECT id FROM match_teams WHERE match_id = ? AND team_id = ?').get(matchId, p.team_id));
  }
  return false;
}

function serializeProof(pr) {
  const team = db.prepare('SELECT name, logo FROM teams WHERE id = ?').get(pr.team_id);
  const uploader = db.prepare('SELECT display_name FROM users WHERE id = ?').get(pr.uploaded_by);
  return {
    id: pr.id, match_id: pr.match_id, team_id: pr.team_id, team_name: team ? team.name : '?',
    team_logo: team ? team.logo : '', kind: pr.kind, url: pr.url,
    file_url: pr.file_path ? `/uploads/${path.basename(pr.file_path)}` : '',
    status: pr.status, uploaded_by_name: uploader ? uploader.display_name : '?', created_at: pr.created_at,
  };
}

router.post('/matches/:id/proof', requireAuth, (req, res) => {
  const m = db.prepare('SELECT * FROM matches WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Match not found.' });
  const team = getTeamForUser(req.user.id);
  if (!team) return res.status(403).json({ error: 'Only team managers can upload proof.' });
  const win = db.prepare('SELECT * FROM match_results WHERE match_id = ? AND team_id = ?').get(m.id, team.id);
  if (!win || win.position !== 1) return res.status(403).json({ error: 'Only the winning team can upload proof for this match.' });
  const exists = db.prepare("SELECT id FROM match_proofs WHERE match_id = ? AND team_id = ? AND status IN ('pending','verified')").get(m.id, team.id);
  if (exists) return res.status(409).json({ error: 'Proof already uploaded for this match. Ask an admin to remove it first.' });

  const body = req.body || {};
  let kind, url = '', filePath = '';
  if (body.data) {
    const dataUrl = String(body.data);
    const match = /^data:(video\/(mp4|webm|quicktime|x-matroska)|image\/gif);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
    if (!match) return res.status(400).json({ error: 'Video must be an mp4/webm/gif data URL.' });
    const buf = Buffer.from(match[3], 'base64');
    const maxBytes = 25 * 1024 * 1024;
    if (buf.length > maxBytes) return res.status(400).json({ error: 'Video must be under 25 MB.' });
    if (buf.length < 1024) return res.status(400).json({ error: 'Video file looks empty.' });
    const ext = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-matroska': '.mkv', 'image/gif': '.gif' }[match[1]] || '.bin';
    filePath = path.join(UPLOAD_DIR, `proof-${m.id}-${crypto.randomBytes(6).toString('hex')}${ext}`);
    fs.writeFileSync(filePath, buf);
    kind = 'file';
  } else if (body.url) {
    url = String(body.url).trim();
    if (!/^https?:\/\//.test(url) || url.length > 600) return res.status(400).json({ error: 'Proof link must be a valid URL.' });
    kind = 'link';
  } else {
    return res.status(400).json({ error: 'Attach a video file or a video link.' });
  }

  const info = db.prepare('INSERT INTO match_proofs (match_id, team_id, uploaded_by, kind, url, file_path) VALUES (?,?,?,?,?,?)')
    .run(m.id, team.id, req.user.id, kind, url, filePath);
  audit(req.user.id, 'proof_upload', { match_id: m.id, team_id: team.id, kind });
  notifyRole('ADMIN', 'match', 'Match proof uploaded', `${team.name} uploaded fair-play proof for ${m.tournament_name}. Verify it in the Matches tab.`);
  const proof = db.prepare('SELECT * FROM match_proofs WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ message: 'Proof uploaded. An admin will verify it.', proof: serializeProof(proof) });
});

router.get('/matches/:id/proof', requireAuth, (req, res) => {
  const m = db.prepare('SELECT id FROM matches WHERE id = ?').get(req.params.id);
  if (!m) return res.status(404).json({ error: 'Match not found.' });
  if (!isMatchParticipant(req.user, m.id)) return res.status(403).json({ error: 'You are not part of this match.' });
  const rows = db.prepare('SELECT * FROM match_proofs WHERE match_id = ? ORDER BY id DESC').all(m.id);
  res.json({ proofs: rows.map(serializeProof) });
});

router.post('/matches/:id/proof/:proofId/verify', requireRole('ADMIN'), (req, res) => {
  const pr = db.prepare('SELECT * FROM match_proofs WHERE id = ? AND match_id = ?').get(req.params.proofId, req.params.id);
  if (!pr) return res.status(404).json({ error: 'Proof not found.' });
  db.prepare("UPDATE match_proofs SET status = 'verified' WHERE id = ?").run(pr.id);
  audit(req.user.id, 'proof_verify', { proof_id: pr.id });
  notify(pr.uploaded_by, 'match', 'Proof verified ✅', 'An admin verified your fair-play video. GG!');
  res.json({ message: 'Proof verified.' });
});

router.post('/matches/:id/proof/:proofId/reject', requireRole('ADMIN'), (req, res) => {
  const pr = db.prepare('SELECT * FROM match_proofs WHERE id = ? AND match_id = ?').get(req.params.proofId, req.params.id);
  if (!pr) return res.status(404).json({ error: 'Proof not found.' });
  if (pr.file_path && fs.existsSync(pr.file_path)) fs.unlinkSync(pr.file_path);
  db.prepare("UPDATE match_proofs SET status = 'rejected', file_path = '' WHERE id = ?").run(pr.id);
  audit(req.user.id, 'proof_reject', { proof_id: pr.id });
  notify(pr.uploaded_by, 'match', 'Proof rejected', 'Your fair-play proof was rejected. Contact an admin if you think this is a mistake.');
  res.json({ message: 'Proof rejected.' });
});

module.exports = { router };
