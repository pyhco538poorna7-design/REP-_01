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
  const out = { ...user };
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
  const { username, password, role, display_name, game_id, roles, team_name, team_logo, contact } = req.body || {};
  if (!username || !password || !display_name) return res.status(400).json({ error: 'Username, password and display name are required.' });
  if (!/^[a-zA-Z0-9_.]{3,24}$/.test(username)) return res.status(400).json({ error: 'Username must be 3-24 characters (letters, numbers, _ or .).' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  if (role !== 'PLAYER' && role !== 'MANAGER') return res.status(400).json({ error: 'Public registration is only available for Player and Manager accounts.' });
  if (db.prepare('SELECT id FROM users WHERE username = ?').get(username)) return res.status(409).json({ error: 'Username already taken.' });

  let rolesJson = '[]';
  if (role === 'PLAYER') {
    if (!game_id) return res.status(400).json({ error: 'Free Fire game ID is required.' });
    const clean = Array.isArray(roles) ? roles.filter((r) => ['Rusher','Support','Sniper','IGL','Entry Fragger','Assaulter'].includes(r)) : [];
    if (clean.length < 2 || clean.length > 3) return res.status(400).json({ error: 'Select exactly 2 or 3 preferred roles.' });
    rolesJson = JSON.stringify(clean);
  } else if (!team_name) {
    return res.status(400).json({ error: 'Team name is required for manager registration.' });
  }

  const hash = bcrypt.hashSync(password, 10);
  const tx = db.transaction(() => {
    const uid = db.prepare('INSERT INTO users (username, password_hash, role, display_name) VALUES (?,?,?,?)')
      .run(username, hash, role, display_name).lastInsertRowid;
    if (role === 'PLAYER') {
      db.prepare('INSERT INTO player_profiles (user_id, game_id, avatar, roles) VALUES (?,?,?,?)')
        .run(uid, game_id, '', rolesJson);
    } else {
      db.prepare('INSERT INTO manager_profiles (user_id, contact, approved) VALUES (?,?,0)').run(uid, contact || '');
    }
    audit(uid, 'register', { username, role });
    return uid;
  });
  const uid = tx();
  notifyRole('ADMIN', 'registration', role === 'PLAYER' ? 'New player registration' : 'New manager registration',
    `${display_name} (@${username}) registered as ${role} and is awaiting approval.`);
  res.status(201).json({ message: 'Registration submitted. You can now log in.', user_id: uid });
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
