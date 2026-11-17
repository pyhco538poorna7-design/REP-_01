'use strict';
const crypto = require('crypto');
const db = require('./db');

const SESSION_TTL_HOURS = 12;
const COOKIE_NAME = 'ff_session';

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach((part) => {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  });
  return out;
}

function createSession(res, userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000);
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,?)')
    .run(token, userId, expires.toISOString());
  db.prepare('UPDATE users SET last_login = datetime(\'now\') WHERE id = ?').run(userId);
  res.setHeader('Set-Cookie',
    `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax; Expires=${expires.toUTCString()}`);
  return token;
}

function destroySession(req, res) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  res.setHeader('Set-Cookie', `${COOKIE_NAME}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
}

function getSessionUser(req) {
  const token = parseCookies(req)[COOKIE_NAME];
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.id, u.username, u.role, u.display_name, u.status, s.expires_at
    FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ?`).get(token);
  if (!row) return null;
  if (new Date(row.expires_at) < new Date()) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  if (row.status !== 'active') return null;
  return { id: row.id, username: row.username, role: row.role, display_name: row.display_name };
}

function attachUser(req, res, next) {
  req.user = getSessionUser(req);
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required. Please log in.' });
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'Authentication required. Please log in.' });
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'You are not authorized to perform this action.' });
    }
    next();
  };
}

function audit(actorId, action, details) {
  db.prepare('INSERT INTO audit_logs (actor_id, action, details) VALUES (?,?,?)')
    .run(actorId || null, action, typeof details === 'string' ? details : JSON.stringify(details || {}));
}

function notify(userIds, type, title, body) {
  const ins = db.prepare('INSERT INTO notifications (user_id, type, title, body) VALUES (?,?,?,?)');
  const ids = Array.isArray(userIds) ? userIds : [userIds];
  const created = [];
  for (const uid of ids) {
    if (uid == null) continue;
    const info = ins.run(uid, type, title, body);
    created.push({ id: info.lastInsertRowid, user_id: uid, type, title, body });
  }
  return created;
}

function notifyRole(role, type, title, body) {
  const ids = db.prepare('SELECT id FROM users WHERE role = ? AND status = \'active\'').all(role).map((r) => r.id);
  return notify(ids, type, title, body);
}

function notifyAll(type, title, body) {
  const ids = db.prepare('SELECT id FROM users WHERE status = \'active\'').all().map((r) => r.id);
  return notify(ids, type, title, body);
}

module.exports = {
  COOKIE_NAME, parseCookies, createSession, destroySession, getSessionUser,
  attachUser, requireAuth, requireRole, audit, notify, notifyRole, notifyAll,
};
