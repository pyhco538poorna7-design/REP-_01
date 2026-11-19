'use strict';
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { createSession, destroySession, requireAuth, audit, notify, notifyRole } = require('../auth');

const router = express.Router();

function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, display_name: u.display_name, status: u.status };
}

function mePayload(userId) {
  const user = db.prepare('SELECT id, username, role, display_name, status, created_at, last_login FROM users WHERE id = ?').get(userId);
  if (!user) return null;
  const out = { ...user, avatar: user.avatar || (user.role === 'PLAYER' ? (db.prepare('SELECT avatar FROM player_profiles WHERE user_id = ?').get(userId) || {}).avatar || '' : '') };
  if (user.role === 'PLAYER') {
    out.player = db.prepare('SELECT * FROM player_profiles WHERE user_id = ?').get(userId) || null;
    if (out.player && out.player.team_id) {
      out.team = db.prepare('SELECT id, name, logo FROM teams WHERE id = ?').get(out.player.team_id) || null;
    }
  }
  if (user.role === 'MANAGER' || user.role === 'ADMIN') {
    out.manager = db.prepare('SELECT * FROM manager_profiles WHERE user_id = ?').get(userId) || null;
    if (out.manager && out.manager.team_id) {
      out.team = db.prepare('SELECT id, name, logo FROM teams WHERE id = ?').get(out.manager.team_id) || null;
    }
  }
  return out;
}

router.post('/register', (req, res) => {
  const { username, password, role, display_name, game_id, roles, team_name, team_logo, contact, avatar } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
  if (!/^[a-zA-Z0-9_.]{3,24}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-24 characters (letters, numbers, _ or .).' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (role !== 'PLAYER' && role !== 'MANAGER') return res.status(400).json({ error: 'Public registration is only available for Player and Manager accounts.' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return res.status(409).json({ error: 'Username already taken.' });
  const displayName = String(display_name || username).slice(0, 60) || username;

  let rolesJson = '[]';
  let logo = '';
  if (role === 'PLAYER') {
    if (!game_id) return res.status(400).json({ error: 'Free Fire game ID is required.' });
    const clean = Array.isArray(roles) ? roles.filter((r) => ['Rusher','Support','Sniper','IGL','Entry Fragger','Assaulter'].includes(r)) : [];
    if (clean.length < 2 || clean.length > 3) return res.status(400).json({ error: 'Select exactly 2 or 3 preferred roles.' });
    rolesJson = JSON.stringify(clean);
  } else {
    if (!team_name) return res.status(400).json({ error: 'Team name is required for manager registration.' });
    const tname = String(team_name).trim().slice(0, 60);
    if (!tname) return res.status(400).json({ error: 'Team name is required for manager registration.' });
    if (db.prepare('SELECT id FROM teams WHERE name = ?').get(tname)) return res.status(409).json({ error: 'A team with this name already exists.' });
    const logoStr = String(team_logo || '🛡️');
    const validLogo = logoStr.startsWith('data:image/') ? logoStr.length <= 900000 : logoStr.length <= 8;
    if (!validLogo) return res.status(400).json({ error: 'Team logo must be an image under 700 KB or a short emoji.' });
    logo = logoStr;
  }

  const loginAvatar = String(avatar || '');
  if (loginAvatar && !(loginAvatar.startsWith('data:image/') ? loginAvatar.length <= 700000 : loginAvatar.length <= 8)) {
    return res.status(400).json({ error: 'Profile picture must be an image under 512 KB or a short emoji.' });
  }

  const hash = bcrypt.hashSync(password, 10);
  let teamName = null;
  const tx = db.transaction(() => {
    const uid = db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?,?,?,?)')
      .run(username, hash, role, displayName).lastInsertRowid;
    if (loginAvatar) db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(loginAvatar, uid);
    if (role === 'PLAYER') {
      db.prepare('INSERT INTO player_profiles (user_id, game_id, avatar, roles) VALUES (?,?,?,?)')
        .run(uid, game_id, loginAvatar, rolesJson);
    } else {
      const tname = String(team_name).trim().slice(0, 60);
      const teamId = db.prepare('INSERT INTO teams (name, logo, owner_user_id) VALUES (?,?,?)').run(tname, logo || '🛡️', uid).lastInsertRowid;
      db.prepare('INSERT INTO manager_profiles (user_id, contact, approved, team_id) VALUES (?,?,1,?)').run(uid, contact || '', teamId);
      teamName = tname;
    }
    audit(uid, 'register', { username, role, team: teamName });
    return uid;
  });
  const uid = tx();
  notifyRole('ADMIN', 'registration', role === 'PLAYER' ? 'New player registration' : 'New manager registered',
    role === 'PLAYER'
      ? `${displayName} (@${username}) registered as PLAYER.`
      : `${displayName} (@${username}) registered as MANAGER — team "${teamName}" was created automatically.`);
  res.status(201).json({ message: 'Registration complete. You can now log in.', user_id: uid });
});

router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Username and password are required.' });
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'Invalid username or password.' });
  }
  if (user.status !== 'active') return res.status(403).json({ error: 'This account is suspended. Contact an administrator.' });
  createSession(res, user.id);
  audit(user.id, 'login', { username: user.username });
  res.json({ message: 'Logged in.', user: mePayload(user.id) });
});

router.post('/logout', (req, res) => {
  destroySession(req, res);
  res.json({ message: 'Logged out.' });
});

router.get('/me', (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in.' });
  const me = mePayload(req.user.id);
  const unread = db.prepare('SELECT COUNT(*) c FROM notifications WHERE (user_id = ? ) AND id NOT IN (SELECT notification_id FROM notification_reads WHERE user_id = ?)').get(req.user.id, req.user.id).c;
  res.json({ user: me, unread_notifications: unread });
});

router.post('/change-password', requireAuth, (req, res) => {
  const { current_password, new_password } = req.body || {};
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!current_password || !bcrypt.compareSync(current_password, user.password_hash)) {
    return res.status(400).json({ error: 'Current password is incorrect.' });
  }
  if (!new_password || String(new_password).length < 6) return res.status(400).json({ error: 'New password must be at least 6 characters.' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(new_password, 10), req.user.id);
  audit(req.user.id, 'change_password', {});
  res.json({ message: 'Password updated.' });
});

router.put('/avatar', requireAuth, (req, res) => {
  const raw = String((req.body || {}).data || '').trim();
  if (!raw || !(raw.startsWith('data:image/') || raw.startsWith('http') || raw.startsWith('/uploads')) || raw.length > 700000) {
    return res.status(400).json({ error: 'Profile picture must be an image under 512 KB or an image link.' });
  }
  db.prepare('UPDATE users SET avatar = ? WHERE id = ?').run(raw, req.user.id);
  const p = db.prepare('SELECT user_id FROM player_profiles WHERE user_id = ?').get(req.user.id);
  if (p) db.prepare('UPDATE player_profiles SET avatar = ? WHERE user_id = ?').run(raw, req.user.id);
  audit(req.user.id, 'avatar_update', { user_id: req.user.id });
  res.json({ message: 'Profile picture updated.', avatar: raw, user: mePayload(req.user.id) });
});

router.put('/profile', requireAuth, (req, res) => {
  const { display_name, avatar, contact, previous_team } = req.body || {};
  if (display_name) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(String(display_name).slice(0, 60), req.user.id);
  if (req.user.role === 'PLAYER') {
    const p = db.prepare('SELECT * FROM player_profiles WHERE user_id = ?').get(req.user.id);
    if (p) db.prepare('UPDATE player_profiles SET avatar = COALESCE(?, avatar), previous_team = COALESCE(?, previous_team) WHERE user_id = ?')
      .run(avatar ?? null, previous_team ?? null, req.user.id);
  }
  if (req.user.role === 'MANAGER' && contact != null) {
    db.prepare('UPDATE manager_profiles SET contact = ? WHERE user_id = ?').run(String(contact).slice(0, 120), req.user.id);
  }
  res.json({ message: 'Profile updated.', user: mePayload(req.user.id) });
});

module.exports = { router, mePayload, publicUser };
