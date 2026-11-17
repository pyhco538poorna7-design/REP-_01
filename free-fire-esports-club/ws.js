'use strict';
const { WebSocketServer } = require('ws');
const { getSessionUser } = require('./auth');
const db = require('./db');

const wss = new WebSocketServer({ noServer: true });
// userId -> Set<ws>
const userSockets = new Map();

function handleUpgrade(request, socket, head) {
  wss.handleUpgrade(request, socket, head, (ws) => {
    const user = getSessionUser(request);
    if (!user) { ws.close(4001, 'Unauthorized'); return; }
    ws.userId = user.id;
    ws.role = user.role;
    ws.channels = new Set();
    if (!userSockets.has(ws.userId)) userSockets.set(ws.userId, new Set());
    userSockets.get(ws.userId).add(ws);
    ws.on('message', (raw) => onMessage(ws, raw));
    ws.on('close', () => {
      const set = userSockets.get(ws.userId);
      if (set) { set.delete(ws); if (!set.size) userSockets.delete(ws.userId); }
    });
    ws.send(JSON.stringify({ type: 'connected', user_id: ws.userId, role: ws.role }));
  });
}

function sendTo(ws, payload) {
  if (ws.readyState === 1) ws.send(JSON.stringify(payload));
}

function sendToUser(userId, payload) {
  const set = userSockets.get(userId);
  if (set) for (const ws of set) sendTo(ws, payload);
}

function broadcastToChannel(channel, payload) {
  wss.clients.forEach((ws) => {
    if (ws.channels && ws.channels.has(channel)) sendTo(ws, payload);
  });
}

function canJoinChannel(user, channel) {
  if (user.role === 'ADMIN') return true;
  const auctionMatch = channel.match(/^auction:(\d+)$/);
  if (auctionMatch) {
    if (user.role === 'MOD') return false;
    if (user.role === 'MANAGER') {
      return !!db.prepare(`
        SELECT at.id FROM auction_teams at
        JOIN teams t ON t.id = at.team_id
        WHERE at.auction_id = ? AND t.owner_user_id = ?`).get(auctionMatch[1], user.id);
    }
    if (user.role === 'PLAYER') {
      return !!db.prepare(`
        SELECT ar.id FROM auction_registrations ar
        WHERE ar.auction_id = ? AND ar.player_user_id = ? AND ar.status = 'approved'`)
        .get(auctionMatch[1], user.id);
    }
    return false;
  }
  const teamMatch = channel.match(/^team:(\d+)$/);
  if (teamMatch) {
    const teamId = Number(teamMatch[1]);
    if (user.role === 'MANAGER') {
      return !!db.prepare('SELECT id FROM teams WHERE id = ? AND owner_user_id = ?').get(teamId, user.id);
    }
    if (user.role === 'PLAYER') {
      return !!db.prepare('SELECT id FROM team_members WHERE team_id = ? AND player_user_id = ?').get(teamId, user.id);
    }
    return false;
  }
  return false;
}

function onMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (msg.type === 'join' && typeof msg.channel === 'string') {
    if (!canJoinChannel({ role: ws.role, id: ws.userId }, msg.channel)) {
      return sendTo(ws, { type: 'error', error: 'Not authorized to join this channel.' });
    }
    ws.channels.add(msg.channel);
    return sendTo(ws, { type: 'joined', channel: msg.channel });
  }
  if (msg.type === 'leave' && typeof msg.channel === 'string') {
    ws.channels.delete(msg.channel);
    return;
  }
  if (msg.type === 'chat' && typeof msg.teamId === 'number' && typeof msg.content === 'string') {
    const teamId = msg.teamId;
    const content = msg.content.trim().slice(0, 1000);
    if (!content) return;
    const allowed = canJoinChannel({ role: ws.role, id: ws.userId }, `team:${teamId}`);
    if (!allowed) return sendTo(ws, { type: 'error', error: 'Not authorized to chat in this team.' });
    const info = db.prepare('INSERT INTO messages (team_id, user_id, content) VALUES (?,?,?)').run(teamId, ws.userId, content);
    const user = db.prepare('SELECT username, display_name, role FROM users WHERE id = ?').get(ws.userId);
    const payload = {
      type: 'chat', teamId,
      message: {
        id: info.lastInsertRowid, team_id: teamId, user_id: ws.userId,
        username: user.username, display_name: user.display_name,
        role: user.role, content, created_at: new Date().toISOString(),
      },
    };
    return broadcastToChannel(`team:${teamId}`, payload);
  }
}

module.exports = { handleUpgrade, sendToUser, broadcastToChannel };
