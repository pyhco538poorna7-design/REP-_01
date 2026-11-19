'use strict';

/* ================= helpers ================= */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const isImageLogo = (v) => typeof v === 'string' && (v.startsWith('data:image/') || v.startsWith('http') || v.startsWith('/uploads'));
function logoChip(logo, size) {
  const v = logo || '🛡️';
  if (isImageLogo(v)) return `<span class="team-logo img"><img src="${esc(v)}" alt=""></span>`;
  return `<span class="team-logo"${size ? ` style="font-size:${size}"` : ''}>${esc(v)}</span>`;
}
function readLogoFile(file, maxBytes = 512 * 1024) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    if (!file.type.startsWith('image/')) return reject(new Error('Logo must be an image file (png/jpg/webp).'));
    if (file.size > maxBytes) return reject(new Error('Logo image must be under 512 KB.'));
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the logo file.'));
    reader.readAsDataURL(file);
  });
}
function readVideoFile(file) {
  return new Promise((resolve, reject) => {
    if (!file) return resolve(null);
    const okType = ['video/mp4', 'video/webm', 'video/quicktime', 'video/x-matroska'].includes(file.type) || file.type.startsWith('image/');
    const okName = /\.(mp4|webm|mov|mkv|gif)$/i.test(file.name || '');
    if (!okType && !okName) return reject(new Error('Proof must be an MP4 / WEBM / MOV / MKV video or a GIF.'));
    if (file.size > 25 * 1024 * 1024) return reject(new Error('Proof video must be under 25 MB.'));
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('Could not read the video file.'));
    reader.readAsDataURL(file);
  });
}
const fmtDate = (d) => d ? d.split('-').reverse().join('/') : '';
const fmtTime = (t) => t || '';
const fmtDateTime = (s) => s ? s.replace('T', ' ').slice(0, 16) : '';

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function toast(msg, kind = '') {
  const el = document.createElement('div');
  el.className = `toast ${kind}`;
  el.textContent = msg;
  $('#toast-container').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(() => el.remove(), 400); }, 3600);
}

function avatarHtml(name, avatarUrl, cls = 'avatar-sm') {
  const initial = (name || '?').trim().charAt(0).toUpperCase();
  if (avatarUrl) return `<span class="${cls}"><img src="${esc(avatarUrl)}" alt="" onerror="this.parentNode.textContent='${initial}'"></span>`;
  return `<span class="${cls}">${esc(initial)}</span>`;
}
const roleTag = (r) => `<span class="badge-tag tag-role">${esc(r)}</span>`;
const statusTag = (s) => `<span class="badge-tag tag-${esc(String(s).toLowerCase())}">${esc(String(s).toUpperCase())}</span>`;
const roleBadge = (role) => `<span class="badge-tag tag-${esc(role.toLowerCase())}">${esc(role)}</span>`;

/* ================= state ================= */
let ME = null;
let WS = null;
let unreadCount = 0;

/* ================= websocket ================= */
function wsConnect() {
  if (WS) { try { WS.close(); } catch {} }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  WS = new WebSocket(`${proto}://${location.host}/ws`);
  WS.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'chat') onChatMessage(msg);
    if (msg.type === 'auction_update') onAuctionUpdate(msg);
    if (msg.type === 'error') toast(msg.error, 'error');
  };
  WS.onclose = () => { if (ME) setTimeout(wsConnect, 3000); };
}
function wsJoin(channel) { if (WS && WS.readyState === 1) WS.send(JSON.stringify({ type: 'join', channel })); }
function wsSend(obj) { if (WS && WS.readyState === 1) WS.send(JSON.stringify(obj)); }

function onChatMessage(msg) {
  const box = $('#chat-messages');
  if (box && Number(box.dataset.teamId) === msg.teamId) {
    box.insertAdjacentHTML('beforeend', chatMsgHtml(msg.message, msg.message.user_id === ME.id));
    box.scrollTop = box.scrollHeight;
  }
}
function onAuctionUpdate(msg) {
  if (location.hash.startsWith(`#/auction/${msg.auction_id}`)) renderAuctionDetail(msg.auction_id, true);
}

/* ================= auth screen ================= */
const ALL_ROLES = ['Rusher', 'Support', 'Sniper', 'IGL', 'Entry Fragger', 'Assaulter'];
let pickedRoles = [];
let regTeamLogo = null;
let regAvatar = null;

function initAuthScreen() {
  $('#roles-picker').innerHTML = ALL_ROLES.map((r) => `<span class="role-chip" data-role="${r}">${r}</span>`).join('');
  $$('#roles-picker .role-chip').forEach((chip) => chip.addEventListener('click', () => {
    const r = chip.dataset.role;
    if (pickedRoles.includes(r)) { pickedRoles = pickedRoles.filter((x) => x !== r); chip.classList.remove('on'); }
    else if (pickedRoles.length < 3) { pickedRoles.push(r); chip.classList.add('on'); }
    else toast('You can pick at most 3 roles', 'error');
  }));
  const avaBox = $('#avatar-upload-box');
  if (avaBox) {
    avaBox.addEventListener('click', () => $('#avatar-file').click());
    $('#avatar-file').addEventListener('change', async () => {
      try {
        const durl = await readLogoFile($('#avatar-file').files[0]);
        if (durl) {
          regAvatar = durl;
          avaBox.innerHTML = `<img src="${esc(durl)}" alt="">`;
          avaBox.classList.add('has-logo');
        }
      } catch (err) { toast(err.message, 'error'); }
    });
  }
  const logoBox = $('#logo-upload-box');
  if (logoBox) {
    logoBox.addEventListener('click', () => $('#team-logo-file').click());
    $('#team-logo-file').addEventListener('change', async () => {
      try {
        const durl = await readLogoFile($('#team-logo-file').files[0]);
        if (durl) {
          regTeamLogo = durl;
          logoBox.innerHTML = `<img src="${esc(durl)}" alt="">`;
          logoBox.classList.add('has-logo');
        }
      } catch (err) { toast(err.message, 'error'); }
    });
  }
  $$('.role-btn').forEach((b) => b.addEventListener('click', () => {
    $$('.role-btn').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    const isPlayer = b.dataset.role === 'PLAYER';
    $('#player-fields').classList.toggle('hidden', !isPlayer);
    $('#manager-fields').classList.toggle('hidden', isPlayer);
  }));
  $('#tab-login').addEventListener('click', () => switchAuthTab(true));
  $('#tab-register').addEventListener('click', () => switchAuthTab(false));

  $('#login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const data = await api('/api/auth/login', { method: 'POST', body: { username: fd.get('username'), password: fd.get('password') } });
      enterApp(data.user);
    } catch (err) { $('#login-error').textContent = err.message; }
  });

  $('#register-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const role = $('.role-btn.active').dataset.role;
    const body = {
      username: fd.get('username'), password: fd.get('password'), role, avatar: regAvatar || '',
    };
    if (role === 'PLAYER') { body.game_id = fd.get('game_id'); body.roles = pickedRoles; }
    else { body.team_name = fd.get('team_name'); body.team_logo = regTeamLogo || ''; body.contact = fd.get('contact'); }
    try {
      const data = await api('/api/auth/register', { method: 'POST', body });
      toast(data.message, 'success');
      switchAuthTab(true);
      $('#login-form [name=username]').value = body.username;
    } catch (err) { $('#register-error').textContent = err.message; }
  });
}

function switchAuthTab(login) {
  $('#tab-login').classList.toggle('active', login);
  $('#tab-register').classList.toggle('active', !login);
  $('#login-form').classList.toggle('hidden', !login);
  $('#register-form').classList.toggle('hidden', login);
}

/* ================= app shell ================= */
const NAV_ITEMS = [
  { hash: '#/dashboard', label: 'DASHBOARD', icon: '🏠', roles: ['ADMIN', 'MOD', 'MANAGER', 'PLAYER'] },
  { hash: '#/leaderboards', label: 'LEADERBOARDS', icon: '🏆', roles: ['ADMIN', 'MOD', 'MANAGER', 'PLAYER'] },
  { hash: '#/auction', label: 'AUCTION', icon: '🔨', roles: ['ADMIN', 'MOD', 'MANAGER', 'PLAYER'] },
  { hash: '#/matches', label: 'MATCHES', icon: '⚔️', roles: ['ADMIN', 'MOD', 'MANAGER', 'PLAYER'] },
  { hash: '#/team', label: 'TEAM CENTER', icon: '🛡️', roles: ['ADMIN', 'MANAGER', 'PLAYER'], needsTeam: true },
  { hash: '#/chat', label: 'TEAM CHAT', icon: '💬', roles: ['ADMIN', 'MANAGER', 'PLAYER'], needsTeam: true },
  { hash: '#/announcements', label: 'NEWS', icon: '📢', roles: ['ADMIN', 'MOD', 'MANAGER', 'PLAYER'] },
  { hash: '#/admin', label: 'ADMIN PANEL', icon: '👑', roles: ['ADMIN'] },
  { hash: '#/mod', label: 'MOD CONSOLE', icon: '🛰️', roles: ['MOD'] },
  { hash: '#/profile', label: 'PROFILE', icon: '👤', roles: ['ADMIN', 'MOD', 'MANAGER', 'PLAYER'] },
];

function visibleNav() {
  return NAV_ITEMS.filter((n) => {
    if (!n.roles.includes(ME.role)) return false;
    if (n.needsTeam && !ME.team) return false;
    return true;
  });
}

function renderNav() {
  const items = visibleNav();
  $('#main-nav').innerHTML = items.map((n) =>
    `<button class="nav-tab" data-hash="${n.hash}">${n.icon} ${n.label}</button>`).join('');
  $('#mobile-nav').innerHTML = items.slice(0, 5).map((n) =>
    `<button class="nav-tab" data-hash="${n.hash}"><span style="font-size:1.1rem">${n.icon}</span>${n.label}</button>`).join('');
  $$('.nav-tab').forEach((b) => b.addEventListener('click', () => { location.hash = b.dataset.hash; }));
  $('#user-name').textContent = ME.display_name;
  $('#user-role').textContent = ME.role;
  const myAvatar = ME.avatar || (ME.player && ME.player.avatar);
  $('#user-avatar').innerHTML = myAvatar
    ? `<img src="${esc(myAvatar)}" alt="">` : esc((ME.display_name || '?')[0].toUpperCase());
}

function enterApp(user) {
  ME = user;
  $('#auth-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  renderNav();
  wsConnect();
  refreshUnread();
  setInterval(refreshUnread, 30000);
  if (!location.hash || location.hash === '#/') location.hash = '#/dashboard';
  route();
}

async function refreshUnread() {
  try {
    const data = await api('/api/notifications');
    unreadCount = data.unread;
    const badge = $('#notif-badge');
    badge.textContent = unreadCount;
    badge.classList.toggle('hidden', unreadCount === 0);
  } catch {}
}

async function boot() {
  try {
    const data = await api('/api/auth/me');
    enterApp(data.user);
  } catch {
    $('#auth-screen').classList.remove('hidden');
  }
}

/* ================= router ================= */
async function route() {
  if (!ME) return;
  const hash = location.hash || '#/dashboard';
  renderNav();
  $$('.nav-tab').forEach((b) => b.classList.toggle('active', hash.startsWith(b.dataset.hash)));
  const view = $('#view');
  const parts = hash.slice(2).split('/');
  try {
    if (hash.startsWith('#/dashboard')) return await viewDashboard(view);
    if (hash.startsWith('#/leaderboards')) return await viewLeaderboards(view, parts[1] || 'kills');
    if (hash.startsWith('#/auction/')) return await renderAuctionDetail(view, Number(parts[1]));
    if (hash.startsWith('#/auction')) return await viewAuctions(view);
    if (hash.startsWith('#/matches')) return await viewMatches(view);
    if (hash.startsWith('#/team/')) return await renderTeamCenter(view, Number(parts[1]));
    if (hash.startsWith('#/team')) return await viewMyTeam(view);
    if (hash.startsWith('#/chat')) return await viewChat(view);
    if (hash.startsWith('#/announcements')) return await viewAnnouncements(view);
    if (hash.startsWith('#/admin')) return await viewAdmin(view, parts[1] || 'overview');
    if (hash.startsWith('#/mod')) return await viewAdmin(view, parts[1] || 'matches');
    if (hash.startsWith('#/profile')) return await viewProfile(view);
    location.hash = '#/dashboard';
  } catch (err) {
    view.innerHTML = `<div class="card"><div class="empty-state"><div class="big">⚠️</div>${esc(err.message)}</div></div>`;
  }
}
window.addEventListener('hashchange', route);

/* ================= dashboard ================= */
async function viewDashboard(view) {
  const [dash, lb] = await Promise.all([api('/api/dashboard'), api('/api/leaderboards/teams')]);
  const s = dash.stats;
  const top5 = lb.leaderboard.slice(0, 5);
  view.innerHTML = `
    <div class="page-head"><h2 class="page-title">COMMAND <span class="accent">CENTER</span></h2>
      <div style="color:var(--text-dim)">Welcome back, <strong style="color:var(--orange-2)">${esc(ME.display_name)}</strong> ${roleBadge(ME.role)}</div></div>
    <div class="grid grid-4" style="margin-bottom:1.2rem">
      <div class="stat-tile"><div class="stat-icon">🎮</div><div class="stat-value">${s.players}</div><div class="stat-label">Registered Players</div></div>
      <div class="stat-tile"><div class="stat-icon">🛡️</div><div class="stat-value">${s.teams}</div><div class="stat-label">Total Teams</div></div>
      <div class="stat-tile"><div class="stat-icon">⚔️</div><div class="stat-value">${s.upcoming_matches}</div><div class="stat-label">Upcoming Matches</div></div>
      <div class="stat-tile"><div class="stat-icon">🔨</div><div class="stat-value">${s.live_auctions}</div><div class="stat-label">Live Auctions</div></div>
    </div>
    <div class="grid grid-2">
      <div class="card"><div class="card-title">🏆 Top Teams</div>
        ${top5.map((t) => `
          <div style="display:flex;align-items:center;gap:.7rem;padding:.5rem 0;border-bottom:1px solid var(--border)">
            <span class="rank-cell rank-${t.rank}">#${t.rank}</span>
            ${logoChip(t.logo)}
            <div style="flex:1"><strong>${esc(t.name)}</strong><div class="hint">${t.total_kills} kills · ${t.total_booyahs} booyahs</div></div>
            <span class="bid-amount">${t.kill_points} pts</span>
          </div>`).join('') || '<div class="empty-state">No teams yet</div>'}
        <button class="btn btn-ghost btn-sm" style="margin-top:.8rem" onclick="location.hash='#/leaderboards'">FULL LEADERBOARDS →</button>
      </div>
      <div class="card"><div class="card-title">⚔️ Upcoming Matches</div>
        ${dash.upcoming_matches.map((m) => `
          <div style="padding:.55rem 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;gap:.6rem;align-items:center">
            <div><strong>${esc(m.tournament_name)}</strong><div class="hint">${fmtDate(m.match_date)} · ${fmtTime(m.match_time)} · ${m.team_count} teams</div></div>
            <button class="btn btn-ghost btn-sm" onclick="location.hash='#/matches'">VIEW</button>
          </div>`).join('') || '<div class="empty-state">No upcoming matches</div>'}
        <button class="btn btn-ghost btn-sm" style="margin-top:.8rem" onclick="location.hash='#/matches'">ALL MATCHES →</button>
      </div>
      <div class="card"><div class="card-title">🔨 Auctions</div>
        ${dash.auctions.map((a) => `
          <div style="padding:.55rem 0;border-bottom:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;gap:.6rem">
            <div><strong>${esc(a.name)}</strong><div class="hint">${fmtDate(a.auction_date)} · ${fmtTime(a.start_time)}</div></div>
            ${statusTag(a.status)}
          </div>`).join('') || '<div class="empty-state">No active auctions</div>'}
        <button class="btn btn-ghost btn-sm" style="margin-top:.8rem" onclick="location.hash='#/auction'">AUCTION HOUSE →</button>
      </div>
      <div class="card"><div class="card-title">📢 Announcements</div>
        ${dash.announcements.map((a) => `
          <div style="padding:.55rem 0;border-bottom:1px solid var(--border)">
            <strong style="color:var(--gold)">${esc(a.title)}</strong>
            <div class="hint" style="margin-top:.2rem">${esc(a.body).slice(0, 140)}</div>
            <div class="hint" style="margin-top:.2rem">— ${esc(a.author || 'Staff')} · ${fmtDateTime(a.created_at)}</div>
          </div>`).join('') || '<div class="empty-state">No announcements</div>'}
      </div>
      <div class="card" style="grid-column:1/-1"><div class="card-title">📊 Latest Match Results</div>
        <div class="table-wrap"><table><thead><tr><th>Match</th><th>Date</th><th>Team</th><th>Kills</th><th>Position</th></tr></thead>
        <tbody>${dash.latest_results.map((r) => `
          <tr><td>${esc(r.tournament_name)}</td><td>${fmtDate(r.match_date)}</td>
          <td>${logoChip(r.team_logo)}${esc(r.team_name)}</td>
          <td class="rank-cell">${r.kills}</td><td>${r.position === 1 ? '🏆 <strong style="color:var(--gold)">BOOYAH</strong>' : '#' + r.position}</td></tr>`).join('')}
        </tbody></table></div>
      </div>
    </div>`;
}

/* ================= leaderboards ================= */
async function viewLeaderboards(view, tab) {
  view.innerHTML = `
    <div class="page-head"><h2 class="page-title">🏆 <span class="accent">LEADERBOARDS</span></h2></div>
    <div class="subtabs">
      <button class="subtab ${tab === 'kills' ? 'active' : ''}" onclick="location.hash='#/leaderboards/kills'">🎯 TOP KILLS</button>
      <button class="subtab ${tab === 'teams' ? 'active' : ''}" onclick="location.hash='#/leaderboards/teams'">🛡️ TOP TEAM</button>
      <button class="subtab ${tab === 'booyahs' ? 'active' : ''}" onclick="location.hash='#/leaderboards/booyahs'">🏁 TOP TEAM BOOYAH</button>
    </div>
    <div id="lb-content"><div class="empty-state">Loading…</div></div>`;
  const el = $('#lb-content');
  if (tab === 'kills') {
    const { leaderboard } = await api('/api/leaderboards/kills');
    el.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>RANK</th><th>PLAYER</th><th>GAME ID</th><th>TOTAL KILLS</th><th>CURRENT TEAM</th></tr></thead>
      <tbody>${leaderboard.map((p) => `
        <tr><td class="rank-cell rank-${p.rank <= 3 ? p.rank : ''}">#${p.rank}</td>
        <td>${avatarHtml(p.player_name, p.avatar)}<strong>${esc(p.player_name)}</strong> <span class="hint">@${esc(p.username)}</span></td>
        <td class="mono">${esc(p.game_id)}</td>
        <td class="rank-cell" style="color:var(--red)">${p.kills}</td>
        <td>${p.team_name ? `${logoChip(p.team_logo)}${esc(p.team_name)}` : '<span class="hint">Free Agent</span>'}</td></tr>`).join('')}
      </tbody></table></div>`;
  } else if (tab === 'teams') {
    const { leaderboard } = await api('/api/leaderboards/teams');
    el.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>RANK</th><th>TEAM</th><th>COMBINED KILLS</th><th>KILL POINTS</th><th>BOOYAHS</th><th>MEMBERS</th></tr></thead>
      <tbody>${leaderboard.map((t) => `
        <tr><td class="rank-cell rank-${t.rank <= 3 ? t.rank : ''}">#${t.rank}</td>
        <td>${logoChip(t.logo)}<strong>${esc(t.name)}</strong></td>
        <td class="rank-cell" style="color:var(--red)">${t.total_kills}</td>
        <td class="rank-cell" style="color:var(--gold)">${t.kill_points}</td>
        <td>🏆 ${t.total_booyahs}</td><td>${t.member_count}</td></tr>`).join('')}
      </tbody></table></div>
      <p class="hint" style="margin-top:.6rem">Kill points = total kills + 3 points per Booyah. Combined kills are calculated from all registered team members' official statistics.</p>`;
  } else {
    const { leaderboard } = await api('/api/leaderboards/booyahs');
    el.innerHTML = `<div class="table-wrap"><table>
      <thead><tr><th>RANK</th><th>TEAM</th><th>TOTAL BOOYAHS</th><th>TOTAL KILLS</th></tr></thead>
      <tbody>${leaderboard.map((t) => `
        <tr><td class="rank-cell rank-${t.rank <= 3 ? t.rank : ''}">#${t.rank}</td>
        <td>${logoChip(t.logo)}<strong>${esc(t.name)}</strong></td>
        <td class="rank-cell" style="color:var(--gold)">🏆 ${t.total_booyahs}</td>
        <td>${t.total_kills}</td></tr>`).join('')}
      </tbody></table></div>`;
  }
}

/* ================= auction house ================= */
async function viewAuctions(view) {
  const { auctions } = await api('/api/auctions');
  const isPlayer = ME.role === 'PLAYER';
  view.innerHTML = `
    <div class="page-head"><h2 class="page-title">🔨 AUCTION <span class="accent">HOUSE</span></h2>
      ${ME.role === 'ADMIN' ? '<button class="btn btn-primary" onclick="showCreateAuction()">+ CREATE AUCTION</button>' : ''}</div>
    <div id="create-auction-wrap"></div>
    <div class="grid grid-3">
      ${auctions.map((a) => `
        <div class="card hover">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:.5rem">
            <h3 style="font-size:1rem">${esc(a.name)}</h3>${statusTag(a.status)}
          </div>
          <div class="hint" style="margin:.5rem 0">📅 ${fmtDate(a.auction_date)} · 🕕 ${fmtTime(a.start_time)} · 💰 ${a.starting_credits} credits/team</div>
          <div class="hint">📍 Venue: ${esc(a.venue || 'DC')}</div>
          <div class="hint">${a.approved_players} approved players · ${a.participating_teams} teams · ${a.sold_players} sold</div>
          <div style="display:flex;gap:.5rem;margin-top:.9rem;flex-wrap:wrap">
            <button class="btn btn-primary btn-sm" onclick="location.hash='#/auction/${a.id}'">OPEN AUCTION ROOM</button>
            ${isPlayer && a.status !== 'closed' && a.my_registration === 'none'
              ? `<button class="btn btn-gold btn-sm" data-reg="${a.id}">REGISTER FOR AUCTION</button>` : ''}
          </div>
          ${isPlayer && a.my_registration !== 'none' ? `<div style="margin-top:.7rem">Your registration: ${statusTag(a.my_registration)}</div>` : ''}
        </div>`).join('') || '<div class="empty-state">No auctions yet</div>'}
    </div>`;
  $$('button[data-reg]', view).forEach((b) => b.addEventListener('click', async () => {
    try {
      const data = await api(`/api/auctions/${b.dataset.reg}/register`, { method: 'POST' });
      toast(data.message, 'success');
      viewAuctions(view);
    } catch (err) { toast(err.message, 'error'); }
  }));
}

function showCreateAuction() {
  const wrap = $('#create-auction-wrap');
  if (wrap.innerHTML) { wrap.innerHTML = ''; return; }
  const today = new Date().toISOString().slice(0, 10);
  wrap.innerHTML = `<div class="card" style="margin-bottom:1rem">
    <div class="card-title">Create New Auction</div>
    <div class="form-grid">
      <div><label>AUCTION NAME</label><input id="auc-name" placeholder="Season 9 Mega Auction"></div>
      <div><label>DATE</label><input id="auc-date" type="date" value="${today}"></div>
      <div><label>STARTING TIME</label><input id="auc-time" type="time" value="18:00"></div>
      <div><label>STARTING CREDITS</label><input id="auc-credits" type="number" value="5000"></div>
      <button class="btn btn-primary" id="auc-create-btn">PUBLISH AUCTION</button>
    </div></div>`;
  $('#auc-create-btn').addEventListener('click', async () => {
    try {
      const data = await api('/api/auctions', { method: 'POST', body: {
        name: $('#auc-name').value, auction_date: $('#auc-date').value,
        start_time: $('#auc-time').value, starting_credits: Number($('#auc-credits').value),
      } });
      toast(data.message, 'success');
      route();
    } catch (err) { toast(err.message, 'error'); }
  });
}

/* ================= auction room (detail) ================= */
async function renderAuctionDetail(view, id, silent) {
  const state = await api(`/api/auctions/${id}`);
  const a = state.auction;
  const isAdmin = ME.role === 'ADMIN';
  const canBid = (ME.role === 'MANAGER' || ME.role === 'ADMIN') && state.my_team && a.status === 'live';
  const myTeamId = state.my_team ? state.my_team.id : null;

  const playerCard = (p) => {
    const sold = p.result && p.result.status === 'SOLD';
    const unsold = p.result && p.result.status === 'UNSOLD';
    const isMine = myTeamId && p.current_bid_team && p.current_bid_team.id === myTeamId;
    const minNext = p.current_bid ? p.current_bid + 10 : 100;
    return `
      <div class="auction-player-card ${p.current_bid ? 'hot' : ''} ${sold || unsold ? 'sold' : ''}">
        <div style="display:flex;gap:.8rem;align-items:flex-start">
          ${avatarHtml(p.player_name, p.avatar, 'avatar-sm')}
          <div style="flex:1">
            <strong>${esc(p.player_name)}</strong> <span class="hint">@${esc(p.username)}</span>
            <div class="hint mono">${esc(p.game_id)}</div>
            <div style="margin:.4rem 0">${p.roles.map(roleTag).join(' ')}</div>
            <div class="hint">🎯 ${p.kills} kills · 🏆 ${p.booyahs} booyahs · ${p.matches} matches${p.previous_team ? ` · prev: ${esc(p.previous_team)}` : ''}</div>
          </div>
          <div style="text-align:right">
            ${sold ? statusTag('SOLD') : unsold ? statusTag('UNSOLD') : ''}
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin-top:.8rem;gap:.5rem;flex-wrap:wrap">
          <div>
            <div class="hint">CURRENT BID</div>
            ${p.current_bid ? `<span class="bid-amount">💰 ${p.current_bid}</span> <span class="hint">${logoChip(p.current_bid_team.logo)} ${esc(p.current_bid_team.name)}${isMine ? ' (you)' : ''}</span>`
              : '<span class="hint">No bids yet</span>'}
          </div>
          <div class="inline-actions">
            ${canBid && !sold && !unsold && p.reg_status === 'approved' && (!p.current_bid_team || !isMine) ? `
              <input class="bid-input" type="number" min="${minNext}" step="10" placeholder="≥ ${minNext}" data-bid-player="${p.player_id}">
              <button class="btn btn-gold btn-sm" data-bid-btn="${p.player_id}">BID</button>` : ''}
            ${isAdmin && a.status !== 'closed' && p.reg_status === 'approved' && !p.result ? `
              <button class="btn btn-danger btn-sm" data-sold="${p.player_id}" ${p.current_bid ? '' : 'disabled'}>SOLD</button>
              <button class="btn btn-ghost btn-sm" data-unsold="${p.player_id}">UNSOLD</button>` : ''}
          </div>
        </div>
        ${p.reg_status === 'pending' && isAdmin ? `
          <div class="inline-actions" style="margin-top:.6rem">
            <button class="btn btn-primary btn-sm" data-approve="${p.registration_id}">APPROVE REGISTRATION</button>
            <button class="btn btn-ghost btn-sm" data-reject="${p.registration_id}">REJECT</button>
          </div>` : ''}
      </div>`;
  };

  view.innerHTML = `
    <div class="page-head">
      <div><h2 class="page-title">🔨 <span class="accent">${esc(a.name)}</span></h2>
        <div class="hint">📍 Venue: ${esc(a.venue || 'DC')} · 📅 ${fmtDate(a.auction_date)} · 🕕 ${fmtTime(a.start_time)}</div></div>
      <button class="btn btn-ghost btn-sm" onclick="location.hash='#/auction'">← ALL AUCTIONS</button>
    </div>
    ${a.status === 'live' ? `<div class="auction-live-banner"><h2>🔴 LIVE BIDDING IN PROGRESS</h2><div>${isAdmin ? `
        <button class="btn btn-ghost btn-sm" data-auction-ctl="pause">⏸ PAUSE</button>
        <button class="btn btn-ghost btn-sm" data-auction-ctl="close">⏹ CLOSE AUCTION</button>` : ''}
      </div></div>` : ''}
    ${a.status === 'paused' ? `<div class="auction-live-banner" style="background:linear-gradient(135deg,#2b5aa8,#4da3ff)"><h2>⏸ AUCTION PAUSED</h2>
      ${isAdmin ? '<button class="btn btn-ghost btn-sm" data-auction-ctl="resume">▶ RESUME</button>' : ''}</div>` : ''}
    ${(a.dc_link || isAdmin) ? `
      <div class="card" style="margin-bottom:1rem;border:1px solid rgba(88,101,242,.5);background:rgba(88,101,242,.07)">
        <div class="card-title">💬 DC LINK</div>
        ${a.dc_link ? `<p style="margin:.2rem 0">Auction venue is <strong>DC</strong> — everyone joins here: <a href="${esc(a.dc_link)}" target="_blank" rel="noopener"><strong class="accent">OPEN DC LINK →</strong></a></p>` : '<p class="hint">No DC link set for this auction yet.</p>'}
        ${isAdmin ? `<div class="inline-actions" style="margin-top:.5rem">
          <input id="dc-link-input" placeholder="https://discord.gg/your-invite" value="${esc(a.dc_link || '')}" style="flex:1;min-width:220px;padding:.5rem .7rem;background:var(--bg-1);border:1px solid var(--border-lit);border-radius:8px;color:var(--text)">
          <button class="btn btn-primary btn-sm" id="dc-save">SAVE DC LINK</button></div>` : ''}
      </div>` : ''}
    <div class="grid" style="grid-template-columns: 2fr 1fr; align-items:start">
      <div>
        ${state.players.filter((p) => p.reg_status === 'approved').map(playerCard).join('')
          || '<div class="card"><div class="empty-state"><div class="big">🔨</div>No approved players in this auction yet.</div></div>'}
        ${isAdmin && state.players.some((p) => p.reg_status === 'pending') ? `
          <div class="card" style="margin-top:1rem"><div class="card-title">⏳ Pending Registrations</div>
          <div class="grid grid-2">${state.players.filter((p) => p.reg_status === 'pending').map(playerCard).join('')}</div></div>` : ''}
      </div>
      <div style="display:flex;flex-direction:column;gap:1rem">
        ${state.my_team ? `
          <div class="card"><div class="card-title">💰 Your Team Budget</div>
            <div style="display:flex;align-items:center;gap:.6rem">${logoChip(state.my_team.logo, '1.6rem')}
              <div><strong>${esc(state.my_team.name)}</strong><div class="hint">per-auction ledger</div></div></div>
            <div class="credits-bar" style="margin-top:.8rem"><span class="credits-value">${state.my_team.available}</span><span class="hint">available credits</span></div>
            <div class="hint" style="margin-top:.3rem">Budget: ${state.my_team.credits} · Spent: ${state.my_team.spent} · Held in live bids: ${state.my_team.credits - state.my_team.spent - state.my_team.available}</div>
          </div>` : ''}
        <div class="card"><div class="card-title">🏛️ Participating Teams</div>
          ${state.teams.map((t) => `
            <div style="display:flex;justify-content:space-between;padding:.45rem 0;border-bottom:1px solid var(--border)">
              <div>${logoChip(t.logo)}<strong>${esc(t.name)}</strong><div class="hint">@${esc(t.owner_username || '—')}</div></div>
              <div style="text-align:right"><span class="bid-amount">${t.credits - t.spent}</span><div class="hint">of ${t.credits}</div></div>
            </div>`).join('') || '<div class="empty-state">Teams get their credit ledger when the auction starts.</div>'}
        </div>
        ${isAdmin || ME.role === 'MANAGER' ? `
          <div class="card"><div class="card-title">🧾 Credit Transactions</div>
            <div id="auc-transactions" class="hint">Loading…</div></div>` : ''}
      </div>
    </div>`;

  wsJoin(`auction:${id}`);
  if (!silent) window.scrollTo(0, 0);

  $$('button[data-bid-btn]', view).forEach((b) => b.addEventListener('click', async () => {
    const pid = b.dataset.bidBtn;
    const input = $(`input[data-bid-player="${pid}"]`, view);
    try {
      const data = await api(`/api/auctions/${id}/bid`, { method: 'POST', body: { player_id: Number(pid), amount: Number(input.value) } });
      toast(data.message, 'success');
    } catch (err) { toast(err.message, 'error'); }
  }));
  $$('button[data-sold]', view).forEach((b) => b.addEventListener('click', async () => {
    try {
      const data = await api(`/api/auctions/${id}/sold`, { method: 'POST', body: { player_id: Number(b.dataset.sold) } });
      toast(data.message, 'success');
    } catch (err) { toast(err.message, 'error'); }
  }));
  $$('button[data-unsold]', view).forEach((b) => b.addEventListener('click', async () => {
    try {
      const data = await api(`/api/auctions/${id}/unsold`, { method: 'POST', body: { player_id: Number(b.dataset.unsold) } });
      toast(data.message, 'success');
    } catch (err) { toast(err.message, 'error'); }
  }));
  $$('button[data-approve]', view).forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/api/auctions/${id}/registrations/${b.dataset.approve}/approve`, { method: 'POST' });
      toast('Registration approved.', 'success');
      renderAuctionDetail(view, id);
    } catch (err) { toast(err.message, 'error'); }
  }));
  $$('button[data-reject]', view).forEach((b) => b.addEventListener('click', async () => {
    try {
      await api(`/api/auctions/${id}/registrations/${b.dataset.reject}/reject`, { method: 'POST' });
      toast('Registration rejected.');
      renderAuctionDetail(view, id);
    } catch (err) { toast(err.message, 'error'); }
  }));
  const dcSave = $('#dc-save', view);
  if (dcSave) dcSave.addEventListener('click', async () => {
    try {
      const d = await api(`/api/auctions/${id}/dc-link`, { method: 'PATCH', body: { dc_link: $('#dc-link-input', view).value.trim() } });
      toast(d.message, 'success');
      renderAuctionDetail(view, id);
    } catch (err) { toast(err.message, 'error'); }
  });
  $$('button[data-auction-ctl]', view).forEach((b) => b.addEventListener('click', async () => {
    try {
      const data = await api(`/api/auctions/${id}/${b.dataset.auctionCtl}`, { method: 'POST' });
      toast(data.message, 'success');
      renderAuctionDetail(view, id);
    } catch (err) { toast(err.message, 'error'); }
  }));
  const txEl = $('#auc-transactions', view);
  if (txEl) {
    try {
      const { transactions } = await api(`/api/auctions/${id}/transactions`);
      txEl.innerHTML = transactions.slice(0, 12).map((t) => `
        <div style="display:flex;justify-content:space-between;padding:.3rem 0">
          <span>${esc(t.team_name)} — ${esc(t.description)}</span>
          <span class="ledger ${t.amount >= 0 ? 'in' : 'out'}">${t.amount >= 0 ? '+' : ''}${t.amount}</span>
        </div>`).join('') || 'No transactions yet.';
    } catch { txEl.textContent = '—'; }
  }
}

/* ================= matches ================= */
async function viewMatches(view) {
  const { matches } = await api('/api/matches');
  const isManager = ME.role === 'MANAGER' || (ME.role === 'ADMIN' && ME.team);
  const canModerate = ME.role === 'MOD' || ME.role === 'ADMIN';
  const myTeamId = ME.team ? ME.team.id : null;
  const proofsMap = {};
  await Promise.all(matches.filter((m) => m.results && m.results.length).map(async (m) => {
    try { proofsMap[m.id] = (await api(`/api/matches/${m.id}/proof`)).proofs; } catch { proofsMap[m.id] = []; }
  }));
  const upcoming = matches.filter((m) => m.status === 'upcoming');
  const others = matches.filter((m) => m.status !== 'upcoming');

  const proofBlock = (m) => {
    const proofs = proofsMap[m.id] || [];
    const iWon = m.results && m.results.length && myTeamId && m.results.some((r) => r.position === 1 && r.team_id === myTeamId);
    const goAround = proofs.length || iWon;
    if (!goAround) return '';
    return `
      <div style="margin-top:.8rem;border-top:1px solid var(--border);padding-top:.7rem">
        <div class="hint" style="color:var(--gold)">🎥 FAIR-PLAY PROOF</div>
        ${proofs.map((p) => `
          <div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;padding:.4rem 0;flex-wrap:wrap">
            <span>${logoChip(p.team_logo)}${esc(p.team_name)} · ${p.kind === 'link' ? '🔗 video link' : '🎞 video file'}
              <span class="tag-tint">${esc(p.uploaded_by_name)}</span></span>
            <span class="inline-actions">
              <span class="badge-tag tag-${p.status}">${p.status.toUpperCase()}</span>
              ${p.kind === 'link' ? `<a class="btn btn-ghost btn-sm" href="${esc(p.url)}" target="_blank" rel="noopener">WATCH</a>` : `<a class="btn btn-ghost btn-sm" href="${esc(p.file_url)}" target="_blank" rel="noopener">WATCH</a>`}
              ${ME.role === 'ADMIN' && p.status !== 'verified' ? `<button class="btn btn-primary btn-sm" data-pverify="${p.id}" data-mid="${m.id}">✔ VERIFY</button>
                <button class="btn btn-danger btn-sm" data-preject="${p.id}" data-mid="${m.id}">✖ REJECT</button>` : ''}
            </span>
          </div>`).join('')}
        ${iWon && !proofs.some((p) => p.status === 'pending' || p.status === 'verified') ? `
          <div class="inline-actions" style="margin-top:.5rem;flex-wrap:wrap">
            <input type="file" id="proof-file-${m.id}" accept="video/mp4,video/webm,video/quicktime,video/x-matroska,image/gif" hidden>
            <label for="proof-file-${m.id}" class="logo-upload-box" style="cursor:pointer">🎞 choose proof video (max 25 MB)</label>
            <span class="hint">or</span>
            <input id="proof-link-${m.id}" placeholder="paste video link (drive/yt/dc)" style="min-width:200px;padding:.45rem .6rem;background:var(--bg-1);border:1px solid var(--border-lit);border-radius:8px;color:var(--text)">
            <button class="btn btn-gold btn-sm" data-proofup="${m.id}">UPLOAD PROOF</button>
          </div>
          <div class="hint" style="margin-top:.3rem">You won this match 🏆 — upload your gameplay video to prove fair play. An admin will verify it.</div>` : ''}
      </div>`;
  };

  const matchCard = (m) => `
    <div class="card hover">
      <div style="display:flex;justify-content:space-between;gap:.6rem;align-items:flex-start;flex-wrap:wrap">
        <div><h3 style="font-size:1rem">${esc(m.tournament_name)}</h3>
          <div class="hint">📅 ${fmtDate(m.match_date)} · 🕕 ${fmtTime(m.match_time)}</div></div>
        ${statusTag(m.status)}
      </div>
      <div style="margin:.7rem 0"><span class="hint">PARTICIPATING TEAMS:</span>
        <div style="margin-top:.3rem">${m.teams.map((t) => `${logoChip(t.logo)}<span style="margin-right:.8rem">${esc(t.name)}</span>`).join('') || '<span class="hint">No teams registered yet</span>'}</div>
      </div>
      ${m.results.length ? `<div class="hint">RESULTS:</div>${m.results.map((r) => `
        <div style="display:flex;justify-content:space-between;padding:.2rem 0">
          <span>${r.position === 1 ? '🏆' : '#' + r.position} ${logoChip(r.logo)}${esc(r.name)}</span>
          <span class="rank-cell">${r.kills} kills</span></div>`).join('')}` : ''}
      ${proofBlock(m)}
      ${m.room_access && m.room_id ? `
        <div style="margin-top:.7rem;padding:.7rem;background:rgba(77,163,255,.06);border:1px solid rgba(77,163,255,.35);border-radius:10px">
          <div class="hint" style="color:var(--blue)">🔒 ROOM CREDENTIALS (authorized only)</div>
          <div style="margin-top:.3rem">Room ID: <strong class="mono">${esc(m.room_id)}</strong></div>
          <div>Password: <strong class="mono">${esc(m.room_password || '—')}</strong></div>
        </div>` : m.room_published ? '<div class="hint" style="margin-top:.6rem">🔒 Room details are restricted to participating teams.</div>' : ''}
      <div class="inline-actions" style="margin-top:.9rem">
        ${isManager && m.status === 'upcoming' ? (m.my_registration
          ? `<button class="btn btn-ghost btn-sm" data-unreg="${m.id}">WITHDRAW TEAM</button>`
          : `<button class="btn btn-primary btn-sm" data-reg="${m.id}">REGISTER MY TEAM</button>`) : ''}
        ${canModerate ? `<button class="btn btn-ghost btn-sm" data-manage="${m.id}">⚙ MANAGE</button>` : ''}
      </div>
      <div id="manage-${m.id}" class="hidden" style="margin-top:.8rem;border-top:1px solid var(--border);padding-top:.8rem"></div>
    </div>`;

  view.innerHTML = `
    <div class="page-head"><h2 class="page-title">⚔️ ESPORTS <span class="accent">MATCHES</span></h2>
      ${canModerate ? '<button class="btn btn-primary" id="new-match-btn">+ SCHEDULE MATCH</button>' : ''}</div>
    <div id="new-match-wrap"></div>
    <div class="card-title" style="margin:.5rem 0 .8rem">📅 UPCOMING</div>
    <div class="grid grid-2">${upcoming.map(matchCard).join('') || '<div class="empty-state">No upcoming matches scheduled.</div>'}</div>
    <div class="card-title" style="margin:1.4rem 0 .8rem">🏁 COMPLETED &amp; LIVE</div>
    <div class="grid grid-2">${others.map(matchCard).join('') || '<div class="empty-state">No completed matches yet.</div>'}</div>`;

  $$('button[data-reg]', view).forEach((b) => b.addEventListener('click', async () => {
    try { const d = await api(`/api/matches/${b.dataset.reg}/register`, { method: 'POST' }); toast(d.message, 'success'); viewMatches(view); }
    catch (err) { toast(err.message, 'error'); }
  }));
  $$('button[data-unreg]', view).forEach((b) => b.addEventListener('click', async () => {
    try { const d = await api(`/api/matches/${b.dataset.unreg}/register`, { method: 'DELETE' }); toast(d.message, 'success'); viewMatches(view); }
    catch (err) { toast(err.message, 'error'); }
  }));
  $$('button[data-manage]', view).forEach((b) => b.addEventListener('click', () => toggleMatchManage(view, Number(b.dataset.manage), matches)));
  $$('button[data-pverify]', view).forEach((b) => b.addEventListener('click', async () => {
    try { const d = await api(`/api/matches/${b.dataset.mid}/proof/${b.dataset.pverify}/verify`, { method: 'POST' }); toast(d.message, 'success'); viewMatches(view); }
    catch (err) { toast(err.message, 'error'); }
  }));
  $$('button[data-preject]', view).forEach((b) => b.addEventListener('click', async () => {
    try { const d = await api(`/api/matches/${b.dataset.mid}/proof/${b.dataset.preject}/reject`, { method: 'POST' }); toast(d.message); viewMatches(view); }
    catch (err) { toast(err.message, 'error'); }
  }));
  $$('button[data-proofup]', view).forEach((b) => b.addEventListener('click', async () => {
    const mid = b.dataset.proofup;
    const linkEl = $(`#proof-link-${mid}`, view);
    const fileEl = $(`#proof-file-${mid}`, view);
    try {
      let body;
      if (fileEl && fileEl.files[0]) {
        body = { data: await readVideoFile(fileEl.files[0]) };
      } else if (linkEl && linkEl.value.trim()) {
        body = { url: linkEl.value.trim() };
      } else { toast('Pick a video file or paste a link first.', 'error'); return; }
      const d = await api(`/api/matches/${mid}/proof`, { method: 'POST', body });
      toast(d.message, 'success');
      viewMatches(view);
    } catch (err) { toast(err.message, 'error'); }
  }));
  const nb = $('#new-match-btn', view);
  if (nb) nb.addEventListener('click', () => {
    const wrap = $('#new-match-wrap');
    if (wrap.innerHTML) { wrap.innerHTML = ''; return; }
    const today = new Date().toISOString().slice(0, 10);
    wrap.innerHTML = `<div class="card" style="margin-bottom:1rem"><div class="card-title">Schedule New Match</div>
      <div class="form-grid">
        <div><label>TOURNAMENT NAME</label><input id="m-tour" placeholder="FFWS Qualifiers"></div>
        <div><label>DATE</label><input id="m-date" type="date" value="${today}"></div>
        <div><label>TIME</label><input id="m-time" type="time" value="19:00"></div>
        <div><label>CUSTOM ROOM ID</label><input id="m-room" placeholder="enter room id"></div>
        <div><label>ROOM PASSWORD</label><input id="m-pass" placeholder="enter password"></div>
        <div style="display:flex;align-items:center;gap:.4rem;padding-bottom:.4rem">
          <input type="checkbox" id="m-pub" style="width:auto"> <label style="margin:0">PUBLISH ROOM DETAILS NOW</label></div>
        <button class="btn btn-primary" id="m-create">PUBLISH MATCH</button>
      </div></div>`;
    $('#m-create').addEventListener('click', async () => {
      try {
        const d = await api('/api/matches', { method: 'POST', body: {
          tournament_name: $('#m-tour').value, match_date: $('#m-date').value, match_time: $('#m-time').value,
          room_id: $('#m-room').value, room_password: $('#m-pass').value, room_published: $('#m-pub').checked,
        } });
        toast(d.message, 'success');
        viewMatches(view);
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

async function toggleMatchManage(view, matchId, matches) {
  const panel = $(`#manage-${matchId}`, view);
  if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
  const m = matches.find((x) => x.id === matchId);
  panel.classList.remove('hidden');
  panel.innerHTML = `
    <div class="form-grid">
      <div><label>TOURNAMENT</label><input id="em-tour" value="${esc(m.tournament_name)}"></div>
      <div><label>DATE</label><input id="em-date" type="date" value="${esc(m.match_date)}"></div>
      <div><label>TIME</label><input id="em-time" type="time" value="${esc(m.match_time)}"></div>
      <div><label>ROOM ID</label><input id="em-room" value="${esc(m.room_id || '')}"></div>
      <div><label>ROOM PASSWORD</label><input id="em-pass" value="${esc(m.room_password || '')}"></div>
      <div><label>STATUS</label>
        <select id="em-status">${['upcoming', 'live', 'completed'].map((s) => `<option value="${s}" ${m.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select></div>
      <div style="display:flex;align-items:center;gap:.4rem;padding-bottom:.4rem">
        <input type="checkbox" id="em-pub" style="width:auto" ${m.room_published ? 'checked' : ''}>
        <label style="margin:0">PUBLISH ROOM DETAILS</label></div>
      <button class="btn btn-primary btn-sm" id="em-save">SAVE MATCH</button>
    </div>
    <div class="card-title" style="margin-top:1rem">Record Results</div>
    <div class="form-grid">
      <div><label>TEAM</label><select id="mr-team">${m.teams.map((t) => `<option value="${t.team_id}">${esc(t.name)}</option>`).join('') || '<option value="">No registered teams</option>'}</select></div>
      <div><label>KILLS</label><input id="mr-kills" type="number" value="0"></div>
      <div><label>POSITION (1 = BOOYAH)</label><input id="mr-pos" type="number" value="1" min="1"></div>
      <button class="btn btn-gold btn-sm" id="mr-save">SAVE RESULT</button>
    </div>`;
  $('#em-save').addEventListener('click', async () => {
    try {
      const d = await api(`/api/matches/${matchId}`, { method: 'PATCH', body: {
        tournament_name: $('#em-tour').value, match_date: $('#em-date').value, match_time: $('#em-time').value,
        room_id: $('#em-room').value, room_password: $('#em-pass').value,
        room_published: $('#em-pub').checked, status: $('#em-status').value,
      } });
      toast(d.message, 'success');
      viewMatches(view);
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#mr-save').addEventListener('click', async () => {
    try {
      const d = await api(`/api/matches/${matchId}/results`, { method: 'POST', body: {
        team_id: Number($('#mr-team').value), kills: Number($('#mr-kills').value), position: Number($('#mr-pos').value),
      } });
      toast(d.message, 'success');
      viewMatches(view);
    } catch (err) { toast(err.message, 'error'); }
  });
}

/* ================= team center ================= */
async function viewMyTeam(view) {
  if (!ME.team) { view.innerHTML = '<div class="card"><div class="empty-state">You are not part of a team yet.</div></div>'; return; }
  return renderTeamCenter(view, ME.team.id);
}

async function renderTeamCenter(view, teamId) {
  const data = await api(`/api/teams/${teamId}`);
  const t = data.team;
  view.innerHTML = `
    <div class="page-head">
      <h2 class="page-title">${logoChip(t.logo, '1.6rem')} <span class="accent">${esc(t.name)}</span></h2>
      ${data.can_manage ? '<button class="btn btn-ghost btn-sm" id="edit-team-btn">✎ EDIT TEAM</button>' : ''}
    </div>
    <div id="edit-team-wrap"></div>
    <div class="hint" style="margin-bottom:1rem">Manager: ${esc(t.owner ? t.owner.display_name : 'Unassigned')} (@${esc(t.owner ? t.owner.username : '—')})</div>
    <div class="grid grid-4" style="margin-bottom:1.2rem">
      <div class="stat-tile"><div class="stat-icon">👥</div><div class="stat-value">${data.members.length}</div><div class="stat-label">Team Members</div></div>
      <div class="stat-tile"><div class="stat-icon">🎯</div><div class="stat-value">${data.totals.total_kills}</div><div class="stat-label">Total Team Kills</div></div>
      <div class="stat-tile"><div class="stat-icon">🏆</div><div class="stat-value">${data.totals.total_booyahs}</div><div class="stat-label">Total Booyahs</div></div>
      <div class="stat-tile"><div class="stat-icon">💰</div><div class="stat-value" style="color:var(--gold)">${data.credits ? data.credits.available : '—'}</div>
        <div class="stat-label">${data.credits ? `Credits · ${esc(data.credits.auction_name)}` : 'No active auction'}</div></div>
    </div>
    <div class="grid grid-2">
      <div class="card"><div class="card-title">👥 Players &amp; Roles</div>
        <div class="table-wrap"><table style="min-width:480px"><thead><tr><th>PLAYER</th><th>GAME ID</th><th>ROLES</th><th>KILLS</th><th>BOOYAHS</th>${data.can_manage ? '<th></th>' : ''}</tr></thead>
        <tbody>${data.members.map((m) => `
          <tr><td>${avatarHtml(m.display_name, m.avatar)}<strong>${esc(m.display_name)}</strong></td>
          <td class="mono">${esc(m.game_id)}</td><td>${m.roles.map(roleTag).join(' ')}</td>
          <td class="rank-cell">${m.kills}</td><td>${m.booyahs}</td>
          ${data.can_manage ? `<td><button class="btn btn-ghost btn-sm" data-remove="${m.id}" data-team="${t.id}">REMOVE</button></td>` : ''}</tr>`).join('')
          || '<tr><td colspan="6" class="empty-state">No players yet. Sign players in the auction!</td></tr>'}</tbody></table></div>
      </div>
      <div style="display:flex;flex-direction:column;gap:1rem">
        <div class="card"><div class="card-title">🔨 Auction Purchase History</div>
          ${data.purchases.map((p) => `
            <div style="display:flex;justify-content:space-between;padding:.45rem 0;border-bottom:1px solid var(--border)">
              <div><strong>${esc(p.player_name)}</strong> <span class="hint mono">${esc(p.game_id || '')}</span><div class="hint">${esc(p.auction_name)}</div></div>
              <span class="bid-amount">-${p.price}</span></div>`).join('') || '<div class="empty-state">No purchases yet</div>'}
        </div>
        <div class="card"><div class="card-title">⚔️ Upcoming Matches</div>
          ${data.upcoming_matches.map((m) => `
            <div style="padding:.45rem 0;border-bottom:1px solid var(--border)"><strong>${esc(m.tournament_name)}</strong>
            <div class="hint">${fmtDate(m.match_date)} · ${fmtTime(m.match_time)} · ${statusTag(m.status)}</div></div>`).join('')
            || '<div class="empty-state">No upcoming matches</div>'}
        </div>
        <div class="card"><div class="card-title">📊 Previous Results</div>
          ${data.past_matches.map((m) => `
            <div style="display:flex;justify-content:space-between;padding:.4rem 0;border-bottom:1px solid var(--border)">
              <div><strong>${esc(m.tournament_name)}</strong><div class="hint">${fmtDate(m.match_date)}</div></div>
              <div style="text-align:right">${m.position === 1 ? '🏆 <strong style="color:var(--gold)">BOOYAH</strong>' : `#${m.position}`}<div class="hint">${m.kills} kills</div></div>
            </div>`).join('') || '<div class="empty-state">No results yet</div>'}
        </div>
      </div>
    </div>`;
  const eb = $('#edit-team-btn', view);
  if (eb) eb.addEventListener('click', () => {
    const wrap = $('#edit-team-wrap');
    if (wrap.innerHTML) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = `<div class="card" style="margin-bottom:1rem"><div class="card-title">Edit Team</div>
      <div class="form-grid">
        <div><label>TEAM NAME</label><input id="et-name" value="${esc(t.name)}"></div>
        <div><label>TEAM LOGO</label><input type="file" id="et-logo-file" accept="image/png,image/jpeg,image/webp" hidden><div class="logo-upload-box" id="et-logo-box"><span>📁 click to upload new logo</span></div></div>
        <button class="btn btn-primary btn-sm" id="et-save">SAVE</button>
      </div></div>`;
    $('#et-logo-box').addEventListener('click', () => $('#et-logo-file').click());
    $('#et-logo-file').addEventListener('change', async () => {
      try {
        const durl = await readLogoFile($('#et-logo-file').files[0]);
        if (durl) { $('#et-logo-box').innerHTML = `<img src="${esc(durl)}" alt="">`; $('#et-logo-box').classList.add('has-logo'); }
      } catch (err) { toast(err.message, 'error'); }
    });
    $('#et-save').addEventListener('click', async () => {
      try {
        const etLogo = await readLogoFile($('#et-logo-file').files[0]);
        const etBody = { name: $('#et-name').value };
        if (etLogo) etBody.logo = etLogo;
        const d = await api(`/api/teams/${t.id}`, { method: 'PATCH', body: etBody });
        toast(d.message, 'success');
        const me = await api('/api/auth/me');
        ME = me.user;
        renderNav();
        renderTeamCenter(view, teamId);
      } catch (err) { toast(err.message, 'error'); }
    });
  });
  $$('button[data-remove]', view).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Remove this player from the team?')) return;
    try {
      const d = await api(`/api/teams/${b.dataset.team}/members/${b.dataset.remove}`, { method: 'DELETE' });
      toast(d.message, 'success');
      renderTeamCenter(view, teamId);
    } catch (err) { toast(err.message, 'error'); }
  }));
}

/* ================= team chat ================= */
async function viewChat(view) {
  let teamId = ME.team ? ME.team.id : null;
  if (ME.role === 'ADMIN' && !teamId) {
    const { teams } = await api('/api/teams');
    if (teams.length) teamId = teams[0].id;
    view.innerHTML = `<div class="page-head"><h2 class="page-title">💬 TEAM <span class="accent">CHAT</span></h2></div>
      <div class="subtabs">${teams.map((t) => `<button class="subtab ${t.id === teamId ? 'active' : ''}" data-tc="${t.id}">${logoChip(t.logo)} ${esc(t.name)}</button>`).join('')}</div>
      <div id="chat-mount"></div>`;
    $$('button[data-tc]', view).forEach((b) => b.addEventListener('click', () => { mountChat(Number(b.dataset.tc)); }));
  } else {
    view.innerHTML = `<div class="page-head"><h2 class="page-title">💬 TEAM <span class="accent">CHAT</span></h2></div><div id="chat-mount"></div>`;
  }
  if (teamId) mountChat(teamId);
  else view.innerHTML = '<div class="card"><div class="empty-state">You need a team to use chat.</div></div>';
}

async function mountChat(teamId) {
  const mount = $('#chat-mount');
  if (!mount) return;
  const { messages } = await api(`/api/chat/${teamId}`);
  const team = ME.team || { name: 'Team' };
  mount.innerHTML = `
    <div class="chat-box">
      <div style="padding:.8rem 1rem;border-bottom:1px solid var(--border);font-family:var(--font-display);font-size:.8rem;letter-spacing:.1em">
        🔒 PRIVATE — ${esc(team.name || 'TEAM')} ROOM
      </div>
      <div class="chat-messages" id="chat-messages" data-team-id="${teamId}">
        ${messages.map((m) => chatMsgHtml(m, m.user_id === ME.id)).join('') || '<div class="empty-state">No messages yet. Say hello! 👋</div>'}
      </div>
      <div class="chat-input-row">
        <input id="chat-input" placeholder="Type a message…" maxlength="1000">
        <button class="btn btn-primary" id="chat-send">SEND</button>
      </div>
    </div>`;
  wsJoin(`team:${teamId}`);
  const box = $('#chat-messages');
  box.scrollTop = box.scrollHeight;
  const send = () => {
    const input = $('#chat-input');
    const content = input.value.trim();
    if (!content) return;
    wsSend({ type: 'chat', teamId, content });
    input.value = '';
  };
  $('#chat-send').addEventListener('click', send);
  $('#chat-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); });
}

function chatMsgHtml(m, mine) {
  return `<div class="chat-msg ${mine ? 'mine' : ''}">
    <div class="meta"><strong>${esc(m.display_name || m.username)}</strong>${m.role ? roleBadge(m.role) : ''}<span>${fmtDateTime((m.created_at || '').replace(' ', 'T'))}</span></div>
    <div>${esc(m.content)}</div></div>`;
}

/* ================= announcements ================= */
async function viewAnnouncements(view) {
  const { announcements } = await api('/api/announcements');
  const canPost = ME.role === 'ADMIN' || ME.role === 'MOD';
  view.innerHTML = `
    <div class="page-head"><h2 class="page-title">📢 NEWS &amp; <span class="accent">ANNOUNCEMENTS</span></h2>
      ${canPost ? '<button class="btn btn-primary" id="new-ann-btn">+ POST ANNOUNCEMENT</button>' : ''}</div>
    <div id="new-ann-wrap"></div>
    <div class="grid">
      ${announcements.map((a) => `
        <div class="card">
          <div style="display:flex;justify-content:space-between;gap:.5rem;align-items:flex-start">
            <h3 style="font-size:1rem;color:var(--gold)">${esc(a.title)}</h3>
            ${ME.role === 'ADMIN' ? `<button class="btn btn-ghost btn-sm" data-del="${a.id}">DELETE</button>` : ''}
          </div>
          <p style="margin:.6rem 0;color:var(--text)">${esc(a.body)}</p>
          <div class="hint">— ${esc(a.author || 'Staff')} ${a.author_role ? roleBadge(a.author_role) : ''} · ${fmtDateTime(a.created_at)}</div>
        </div>`).join('') || '<div class="empty-state">No announcements yet.</div>'}
    </div>`;
  $$('button[data-del]', view).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Delete this announcement?')) return;
    try { await api(`/api/announcements/${b.dataset.del}`, { method: 'DELETE' }); toast('Deleted.'); viewAnnouncements(view); }
    catch (err) { toast(err.message, 'error'); }
  }));
  const nb = $('#new-ann-btn', view);
  if (nb) nb.addEventListener('click', () => {
    const wrap = $('#new-ann-wrap');
    if (wrap.innerHTML) { wrap.innerHTML = ''; return; }
    wrap.innerHTML = `<div class="card" style="margin-bottom:1rem"><div class="card-title">Post Announcement</div>
      <div class="form-grid">
        <div style="grid-column:1/-1"><label>TITLE</label><input id="an-title"></div>
        <div style="grid-column:1/-1"><label>BODY</label><input id="an-body"></div>
        <button class="btn btn-primary btn-sm" id="an-post">PUBLISH</button>
      </div></div>`;
    $('#an-post').addEventListener('click', async () => {
      try {
        const d = await api('/api/announcements', { method: 'POST', body: { title: $('#an-title').value, body: $('#an-body').value } });
        toast(d.message, 'success');
        viewAnnouncements(view);
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

/* ================= admin / mod console ================= */
async function viewAdmin(view, tab) {
  const isAdmin = ME.role === 'ADMIN';
  const tabs = isAdmin
    ? [['overview', '📊 OVERVIEW'], ['users', '👥 USERS'], ['teams', '🛡️ TEAMS'], ['registrations', '📋 MANAGERS'], ['auctions', '🔨 AUCTIONS'], ['audit', '📜 AUDIT LOGS']]
    : [['matches', '⚔️ MATCHES'], ['announcements', '📢 ANNOUNCEMENTS']];
  if (!tabs.some(([k]) => k === tab)) tab = tabs[0][0];
  view.innerHTML = `
    <div class="page-head"><h2 class="page-title">${isAdmin ? '👑 ADMIN' : '🛰️ MOD'} <span class="accent">${isAdmin ? 'PANEL' : 'CONSOLE'}</span></h2></div>
    <div class="subtabs">${tabs.map(([k, label]) => `<button class="subtab ${tab === k ? 'active' : ''}" data-at="${k}">${label}</button>`).join('')}</div>
    <div id="admin-content"><div class="empty-state">Loading…</div></div>`;
  $$('button[data-at]', view).forEach((b) => b.addEventListener('click', () => { location.hash = `#/${isAdmin ? 'admin' : 'mod'}/${b.dataset.at}`; }));
  const el = $('#admin-content');
  if (tab === 'overview') return adminOverview(el);
  if (tab === 'users') return adminUsers(el);
  if (tab === 'teams') return adminTeams(el);
  if (tab === 'registrations') return adminRegistrations(el);
  if (tab === 'auctions') return adminAuctions(el);
  if (tab === 'audit') return adminAudit(el);
  if (tab === 'matches') return modMatches(el);
  if (tab === 'announcements') return viewAnnouncements(el);
}

async function adminOverview(el) {
  const o = await api('/api/overview');
  el.innerHTML = `<div class="grid grid-4">
    ${[['🎮', o.players, 'Players'], ['📋', o.managers, 'Managers'], ['🛰️', o.mods, 'Moderators'], ['🛡️', o.teams, 'Teams'],
      ['🔨', o.auctions, 'Auctions'], ['🔴', o.live_auctions, 'Live Auctions'], ['⚔️', o.matches, 'Matches'], ['📅', o.upcoming_matches, 'Upcoming Matches'],
      ['⏳', o.pending_player_regs, 'Pending Auction Registrations'], ['✉️', o.pending_manager_regs, 'Pending Manager Registrations']]
      .map(([ic, v, l]) => `<div class="stat-tile"><div class="stat-icon">${ic}</div><div class="stat-value">${v}</div><div class="stat-label">${l}</div></div>`).join('')}
  </div>`;
}

async function adminUsers(el) {
  const { users } = await api('/api/users');
  el.innerHTML = `
    <div class="card" style="margin-bottom:1rem"><div class="card-title">➕ Create Account (any role)</div>
      <div class="form-grid">
        <div><label>USERNAME</label><input id="nu-username"></div>
        <div><label>DISPLAY NAME</label><input id="nu-display"></div>
        <div><label>PASSWORD</label><input id="nu-password" type="password"></div>
        <div><label>ROLE</label><select id="nu-role"><option>PLAYER</option><option>MANAGER</option><option>MOD</option><option>ADMIN</option></select></div>
        <button class="btn btn-primary btn-sm" id="nu-create">CREATE</button>
      </div></div>
    <div class="table-wrap"><table><thead><tr><th>USER</th><th>ROLE</th><th>STATUS</th><th>TEAM</th><th>LAST LOGIN</th><th>ACTIONS</th></tr></thead>
      <tbody>${users.map((u) => `
        <tr><td><strong>${esc(u.display_name)}</strong><div class="hint">@${esc(u.username)}${u.game_id ? ` · ${esc(u.game_id)}` : ''}</div></td>
        <td>${roleBadge(u.role)}</td>
        <td>${u.status === 'active' ? '<span class="badge-tag tag-approved">ACTIVE</span>' : '<span class="badge-tag tag-rejected">SUSPENDED</span>'}</td>
        <td class="hint">${esc(u.team_name || u.manager_team_name || '—')}</td>
        <td class="hint">${fmtDateTime(u.last_login)}</td>
        <td><div class="inline-actions">
          ${u.status === 'active'
            ? `<button class="btn btn-ghost btn-sm" data-suspend="${u.id}">SUSPEND</button>`
            : `<button class="btn btn-primary btn-sm" data-activate="${u.id}">ACTIVATE</button>`}
          <button class="btn btn-ghost btn-sm" data-role-change="${u.id}">ROLE</button>
          <button class="btn btn-ghost btn-sm" data-reset="${u.id}">RESET PW</button>
          ${u.role === 'PLAYER' ? `<button class="btn btn-ghost btn-sm" data-stats="${u.id}" data-kills="${u.kills || 0}" data-booyahs="${u.booyahs || 0}" data-matches="${u.matches || 0}">STATS</button>` : ''}
          <button class="btn btn-danger btn-sm" data-delete="${u.id}">DELETE</button>
        </div></td></tr>`).join('')}</tbody></table></div>`;
  $('#nu-create').addEventListener('click', async () => {
    try {
      const d = await api('/api/users', { method: 'POST', body: {
        username: $('#nu-username').value, display_name: $('#nu-display').value,
        password: $('#nu-password').value, role: $('#nu-role').value,
      } });
      toast(d.message, 'success');
      adminUsers(el);
    } catch (err) { toast(err.message, 'error'); }
  });
  const act = async (id, body, ok) => { try { await api(`/api/users/${id}`, { method: 'PATCH', body }); toast(ok, 'success'); adminUsers(el); } catch (err) { toast(err.message, 'error'); } };
  $$('button[data-suspend]', el).forEach((b) => b.addEventListener('click', () => act(b.dataset.suspend, { status: 'suspended' }, 'Account suspended — all sessions revoked.')));
  $$('button[data-activate]', el).forEach((b) => b.addEventListener('click', () => act(b.dataset.activate, { status: 'active' }, 'Account activated.')));
  $$('button[data-role-change]', el).forEach((b) => b.addEventListener('click', () => {
    const role = prompt('Set role (ADMIN / MOD / MANAGER / PLAYER):');
    if (role) act(b.dataset.roleChange, { role: role.toUpperCase() }, 'Role updated.');
  }));
  $$('button[data-reset]', el).forEach((b) => b.addEventListener('click', () => {
    const pw = prompt('New password (min 6 chars):');
    if (pw) act(b.dataset.reset, { password: pw }, 'Password reset. User sessions revoked.');
  }));
  $$('button[data-stats]', el).forEach((b) => b.addEventListener('click', () => {
    const kills = prompt('Official total kills:', b.dataset.kills);
    if (kills == null) return;
    const booyahs = prompt('Official Booyahs:', b.dataset.booyahs);
    if (booyahs == null) return;
    const matches = prompt('Matches played:', b.dataset.matches);
    if (matches == null) return;
    api(`/api/players/${b.dataset.stats}/stats`, { method: 'PATCH', body: { kills: Number(kills), booyahs: Number(booyahs), matches: Number(matches) } })
      .then((d) => { toast(d.message, 'success'); adminUsers(el); })
      .catch((err) => toast(err.message, 'error'));
  }));
  $$('button[data-delete]', el).forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Permanently delete this account?')) return;
    try { await api(`/api/users/${b.dataset.delete}`, { method: 'DELETE' }); toast('Account removed.'); adminUsers(el); }
    catch (err) { toast(err.message, 'error'); }
  }));
}

async function adminTeams(el) {
  const { teams } = await api('/api/teams');
  el.innerHTML = `
    <div class="card" style="margin-bottom:1rem"><div class="card-title">➕ Create Team</div>
      <div class="form-grid">
        <div><label>TEAM NAME</label><input id="nt-name"></div>
        <div><label>TEAM LOGO</label><input type="file" id="nt-logo-file" accept="image/png,image/jpeg,image/webp" hidden><div class="logo-upload-box" id="nt-logo-box"><span>📁 click to upload logo</span></div></div>
        <div><label>MANAGER USERNAME (OPTIONAL — e.g. YOURSELF)</label><input id="nt-owner" placeholder="username"></div>
        <button class="btn btn-primary btn-sm" id="nt-create">CREATE</button>
      </div></div>
    <div class="table-wrap"><table><thead><tr><th>TEAM</th><th>MANAGER</th><th>MEMBERS</th><th>KILLS</th><th>BOOYAHS</th><th>POINTS</th></tr></thead>
      <tbody>${teams.map((t) => `
        <tr><td>${logoChip(t.logo)}<strong>${esc(t.name)}</strong></td>
        <td class="hint">${esc(t.owner_name || '—')} ${t.owner_username ? `@${esc(t.owner_username)}` : ''}</td>
        <td>${t.member_count}</td><td class="rank-cell" style="color:var(--red)">${t.total_kills}</td>
        <td>🏆 ${t.total_booyahs}</td><td class="rank-cell" style="color:var(--gold)">${t.kill_points}</td></tr>`).join('')}</tbody></table></div>`;
  const ntBox = $('#nt-logo-box');
  if (ntBox) {
    ntBox.addEventListener('click', () => $('#nt-logo-file').click());
    $('#nt-logo-file').addEventListener('change', async () => {
      try {
        const durl = await readLogoFile($('#nt-logo-file').files[0]);
        if (durl) { ntBox.innerHTML = `<img src="${esc(durl)}" alt="">`; ntBox.classList.add('has-logo'); }
      } catch (err) { toast(err.message, 'error'); }
    });
  }
  $('#nt-create').addEventListener('click', async () => {
    try {
      const ownerName = $('#nt-owner').value.trim();
      let owner_user_id = null;
      if (ownerName) {
        const found = await api(`/api/users?q=${encodeURIComponent(ownerName)}`);
        const match = found.users.find((x) => x.username === ownerName);
        if (match) owner_user_id = match.id;
      }
      const ntLogo = await readLogoFile($('#nt-logo-file').files[0]);
      const d = await api('/api/teams', { method: 'POST', body: { name: $('#nt-name').value, logo: ntLogo, owner_user_id } });
      toast(d.message, 'success');
      const me = await api('/api/auth/me');
      ME = me.user;
      renderNav();
      adminTeams(el);
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function adminRegistrations(el) {
  const [{ managers }] = await Promise.all([api('/api/managers')]);
  const medal = (i) => i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `#${i + 1}`;
  el.innerHTML = `
    <div class="card" style="margin-bottom:1rem"><div class="card-title">🏆 MANAGERS <span class="accent">LEADERBOARD</span></div>
      <p class="hint" style="margin:.2rem 0 .8rem">⚡ Approvals are <strong>automatic</strong> now — every new manager instantly gets a team with 5,000 auction credits. Sorted by most wins.</p>
      <div class="table-wrap"><table><thead><tr><th>RANK</th><th>MANAGER</th><th>TEAM</th><th>PLAYERS</th><th>🏆 WINS</th><th>KILLS</th><th>STATUS</th></tr></thead>
      <tbody>${managers.map((m, i) => `
        <tr>
          <td><strong>${medal(i)}</strong></td>
          <td><strong>${esc(m.display_name)}</strong> <span class="hint">@${esc(m.username)}</span>${m.contact ? `<div class="hint">contact: ${esc(m.contact)}</div>` : ''}</td>
          <td>${logoChip(m.team_logo)}${esc(m.team_name || '—')}</td>
          <td>${m.members}</td>
          <td><span class="bid-amount">${m.wins}</span></td>
          <td class="rank-cell">${m.total_kills}</td>
          <td>${m.status === 'active' ? '<span class="badge-tag tag-approved">ACTIVE</span>' : '<span class="badge-tag tag-rejected">SUSPENDED</span>'}</td>
        </tr>`).join('') || '<tr><td colspan="7"><div class="empty-state">No managers registered yet.</div></td></tr>'}</tbody></table></div>
    </div>`;
}

async function adminAuctions(el) {
  const { auctions } = await api('/api/auctions');
  el.innerHTML = `
    <div class="card" style="margin-bottom:1rem"><div class="card-title">🔨 Create &amp; Control Auctions</div>
      <div class="form-grid">
        <div><label>AUCTION NAME</label><input id="ca-name"></div>
        <div><label>DATE</label><input id="ca-date" type="date"></div>
        <div><label>STARTING TIME</label><input id="ca-time" type="time" value="18:00"></div>
        <div><label>VENUE</label><input id="ca-venue" value="DC" placeholder="DC"></div>
        <div><label>DC LINK (OPTIONAL)</label><input id="ca-dc" placeholder="https://discord.gg/..."></div>
        <div><label>STARTING CREDITS</label><input id="ca-credits" type="number" value="5000"></div>
        <button class="btn btn-primary btn-sm" id="ca-create">PUBLISH AUCTION</button>
      </div>
      <p class="hint" style="margin-top:.6rem">Every participating team automatically receives the starting credit allocation when the auction starts. Credits are tracked per auction and never carry over.</p></div>
    <div class="table-wrap"><table><thead><tr><th>AUCTION</th><th>WHEN</th><th>PLAYERS</th><th>TEAMS</th><th>STATUS</th><th>CONTROLS</th></tr></thead>
      <tbody>${auctions.map((a) => `
        <tr><td><strong>${esc(a.name)}</strong></td>
        <td class="hint">${fmtDate(a.auction_date)} ${fmtTime(a.start_time)}<br>📍 Venue: ${esc(a.venue || 'DC')}</td>
        <td>${a.approved_players} approved / ${a.pending_players} pending<br><span class="hint">${a.sold_players} sold</span></td>
        <td>${a.participating_teams}</td><td>${statusTag(a.status)}</td>
        <td><div class="inline-actions">
          ${a.status === 'upcoming' ? `<button class="btn btn-primary btn-sm" data-act="start" data-id="${a.id}">▶ START</button>` : ''}
          ${a.status === 'live' ? `<button class="btn btn-ghost btn-sm" data-act="pause" data-id="${a.id}">⏸ PAUSE</button>
            <button class="btn btn-danger btn-sm" data-act="close" data-id="${a.id}">⏹ CLOSE</button>` : ''}
          ${a.status === 'paused' ? `<button class="btn btn-primary btn-sm" data-act="resume" data-id="${a.id}">▶ RESUME</button>
            <button class="btn btn-danger btn-sm" data-act="close" data-id="${a.id}">⏹ CLOSE</button>` : ''}
          <button class="btn btn-ghost btn-sm" onclick="location.hash='#/auction/${a.id}'">OPEN</button>
        </div></td></tr>`).join('')}</tbody></table></div>`;
  $('#ca-create').addEventListener('click', async () => {
    try {
      const d = await api('/api/auctions', { method: 'POST', body: {
        name: $('#ca-name').value, auction_date: $('#ca-date').value,
        start_time: $('#ca-time').value, venue: $('#ca-venue').value || 'DC',
        dc_link: ($('#ca-dc') && $('#ca-dc').value.trim()) || '',
        starting_credits: Number($('#ca-credits').value),
      } });
      toast(d.message, 'success');
      adminAuctions(el);
    } catch (err) { toast(err.message, 'error'); }
  });
  $$('button[data-act]', el).forEach((b) => b.addEventListener('click', async () => {
    try {
      const d = await api(`/api/auctions/${b.dataset.id}/${b.dataset.act}`, { method: 'POST' });
      toast(d.message, 'success');
      adminAuctions(el);
    } catch (err) { toast(err.message, 'error'); }
  }));
}

async function adminAudit(el) {
  const { logs } = await api('/api/audit-logs?limit=200');
  el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>TIME</th><th>ACTOR</th><th>ACTION</th><th>DETAILS</th></tr></thead>
    <tbody>${logs.map((l) => `
      <tr><td class="hint">${fmtDateTime(l.created_at)}</td><td>${esc(l.actor_username || 'system')}</td>
      <td><span class="badge-tag tag-role">${esc(l.action)}</span></td>
      <td class="hint mono" style="max-width:420px;overflow:hidden;text-overflow:ellipsis">${esc(l.details)}</td></tr>`).join('')}</tbody></table></div>`;
}

async function modMatches(el) {
  const { matches } = await api('/api/matches');
  const matchCard = (m) => `
    <div class="card hover">
      <div style="display:flex;justify-content:space-between;gap:.6rem;align-items:flex-start;flex-wrap:wrap">
        <div><h3 style="font-size:1rem">${esc(m.tournament_name)}</h3>
          <div class="hint">📅 ${fmtDate(m.match_date)} · 🕕 ${fmtTime(m.match_time)} · ${m.teams.length} team(s)</div></div>
        ${statusTag(m.status)}
      </div>
      <div class="card-title" style="margin:.8rem 0 .4rem">🔒 ROOM ID &amp; PASSWORD</div>
      <div class="form-grid">
        <div><label>ROOM ID</label><input id="mr-id-${m.id}" value="${esc(m.room_id || '')}" placeholder="room id"></div>
        <div><label>ROOM PASSWORD</label><input id="mr-pass-${m.id}" value="${esc(m.room_password || '')}" placeholder="room password"></div>
        <div><label>STATUS</label>
          <select id="mr-status-${m.id}">${['upcoming', 'live', 'completed'].map((st) => `<option value="${st}" ${m.status === st ? 'selected' : ''}>${st}</option>`).join('')}</select></div>
        <div style="display:flex;align-items:center;gap:.4rem;padding-bottom:.4rem">
          <input type="checkbox" id="mr-pub-${m.id}" style="width:auto" ${m.room_published ? 'checked' : ''}>
          <label style="margin:0">PUBLISH TO TEAMS</label></div>
        <button class="btn btn-primary btn-sm" data-mroom="${m.id}">💾 SAVE ROOM INFO</button>
      </div>
      <div class="card-title" style="margin:.8rem 0 .4rem">🏆 POST MATCH RESULTS</div>
      ${m.results.length ? m.results.map((r) => `
        <div style="display:flex;justify-content:space-between;padding:.25rem 0">
          <span>${r.position === 1 ? '🏆' : '#' + r.position} ${logoChip(r.logo)}${esc(r.name)}</span>
          <span class="rank-cell">${r.kills} kills</span></div>`).join('') : '<div class="hint" style="margin-bottom:.4rem">No results posted yet.</div>'}
      <div class="form-grid" style="margin-top:.5rem">
        <div><label>TEAM</label><select id="mrt-${m.id}">${m.teams.map((t) => `<option value="${t.team_id}">${esc(t.name)}</option>`).join('') || '<option value="">No teams registered</option>'}</select></div>
        <div><label>KILLS</label><input id="mrk-${m.id}" type="number" value="0" min="0"></div>
        <div><label>POSITION</label><input id="mrp-${m.id}" type="number" value="1" min="1"></div>
        <button class="btn btn-gold btn-sm" data-mresult="${m.id}" ${m.teams.length ? '' : 'disabled'}>✍ POST RESULT</button>
      </div>
      <p class="hint" style="margin-top:.5rem">🛡 Only participating teams and admins can see the room credentials. Position 1 = 🏆 BOOYAH (counts as a win).</p>
    </div>`;

  el.innerHTML = `
    <div class="page-head" style="margin-bottom:.8rem">
      <div class="card-title" style="margin:0">⚔️ MATCHES YOU CONTROL</div>
      <button class="btn btn-primary" id="new-match-btn">+ SCHEDULE MATCH</button></div>
    <div id="new-match-wrap"></div>
    <div class="grid grid-2">${matches.map(matchCard).join('') || '<div class="empty-state">No matches yet. Schedule the first one!</div>'}</div>`;

  const nb = $('#new-match-btn', el);
  if (nb) nb.addEventListener('click', () => {
    const wrap = $('#new-match-wrap', el);
    if (wrap.innerHTML) { wrap.innerHTML = ''; return; }
    const today = new Date().toISOString().slice(0, 10);
    wrap.innerHTML = `<div class="card" style="margin-bottom:1rem"><div class="card-title">Schedule New Match</div>
      <div class="form-grid">
        <div><label>TOURNAMENT NAME</label><input id="m-tour" placeholder="FFWS Qualifiers"></div>
        <div><label>DATE</label><input id="m-date" type="date" value="${today}"></div>
        <div><label>TIME</label><input id="m-time" type="time" value="19:00"></div>
        <div><label>CUSTOM ROOM ID</label><input id="m-room" placeholder="enter room id"></div>
        <div><label>ROOM PASSWORD</label><input id="m-pass" placeholder="enter password"></div>
        <div style="display:flex;align-items:center;gap:.4rem;padding-bottom:.4rem">
          <input type="checkbox" id="m-pub" style="width:auto"> <label style="margin:0">PUBLISH ROOM DETAILS NOW</label></div>
        <button class="btn btn-primary" id="m-create">PUBLISH MATCH</button>
      </div></div>`;
    $('#m-create', el).addEventListener('click', async () => {
      try {
        const d = await api('/api/matches', { method: 'POST', body: {
          tournament_name: $('#m-tour', el).value, match_date: $('#m-date', el).value, match_time: $('#m-time', el).value,
          room_id: $('#m-room', el).value, room_password: $('#m-pass', el).value, room_published: $('#m-pub', el).checked,
        } });
        toast(d.message, 'success');
        modMatches(el);
      } catch (err) { toast(err.message, 'error'); }
    });
  });

  $$('button[data-mroom]', el).forEach((b) => b.addEventListener('click', async () => {
    const m = b.dataset.mroom;
    try {
      const d = await api(`/api/matches/${m}`, { method: 'PATCH', body: {
        room_id: $(`#mr-id-${m}`, el).value, room_password: $(`#mr-pass-${m}`, el).value,
        room_published: $(`#mr-pub-${m}`, el).checked, status: $(`#mr-status-${m}`, el).value,
      } });
      toast(d.message, 'success');
      modMatches(el);
    } catch (err) { toast(err.message, 'error'); }
  }));

  $$('button[data-mresult]', el).forEach((b) => b.addEventListener('click', async () => {
    const m = b.dataset.mresult;
    const teamSel = $(`#mrt-${m}`, el);
    if (!teamSel || !teamSel.value) { toast('No teams registered for this match.', 'error'); return; }
    try {
      const d = await api(`/api/matches/${m}/results`, { method: 'POST', body: {
        team_id: Number(teamSel.value), kills: Number($(`#mrk-${m}`, el).value), position: Number($(`#mrp-${m}`, el).value),
      } });
      toast(d.message, 'success');
      modMatches(el);
    } catch (err) { toast(err.message, 'error'); }
  }));
}

/* ================= profile ================= */
async function viewProfile(view) {
  const data = await api('/api/auth/me');
  ME = data.user;
  const u = ME;
  view.innerHTML = `
    <div class="page-head"><h2 class="page-title">👤 MY <span class="accent">PROFILE</span></h2></div>
    <div class="grid grid-2">
      <div class="card"><div class="card-title">Account</div>
        <p><strong>${esc(u.display_name)}</strong> <span class="hint">@${esc(u.username)}</span></p>
        <p style="margin:.5rem 0">${roleBadge(u.role)} ${u.status === 'active' ? '<span class="badge-tag tag-approved">ACTIVE</span>' : '<span class="badge-tag tag-rejected">SUSPENDED</span>'}</p>
        ${u.player ? `<div class="hint" style="margin-top:.6rem">Game ID: <span class="mono">${esc(u.player.game_id)}</span></div>
          <div class="hint">Kills: ${u.player.kills} · Booyahs: ${u.player.booyahs} · Matches: ${u.player.matches}</div>
          ${u.team ? `<div style="margin-top:.5rem">Team: <span class="team-logo">${esc(u.team.logo)}</span><strong>${esc(u.team.name)}</strong></div>` : '<div class="hint" style="margin-top:.5rem">No team yet — register for an auction to get signed!</div>'}` : ''}
        ${u.manager ? `<div class="hint" style="margin-top:.6rem">Contact: ${esc(u.manager.contact || '—')}</div>` : ''}
        <div class="form-grid" style="margin-top:1rem">
          <div><label>DISPLAY NAME</label><input id="pf-name" value="${esc(u.display_name)}"></div>
          ${u.player ? `<div><label>PREVIOUS TEAM</label><input id="pf-prev" value="${esc(u.player.previous_team || '')}"></div>` : ''}
          ${u.manager ? `<div><label>CONTACT</label><input id="pf-contact" value="${esc(u.manager.contact || '')}"></div>` : ''}
          <div style="grid-column:1/-1">
            <label class="file-label" style="display:block">PROFILE PICTURE (IMAGE)
              <input type="file" id="pf-avatar-file" accept="image/png,image/jpeg,image/webp" hidden>
              <div class="logo-upload-box avatar-upload" id="pf-avatar-box">${u.avatar ? `<img src="${esc(u.avatar)}" alt="">` : '<span>📁 click to upload your profile pic</span>'}</div></label>
          </div>
          <button class="btn btn-primary btn-sm" id="pf-save">SAVE PROFILE</button>
        </div>
      </div>
      <div class="card"><div class="card-title">🔐 Security</div>
        <div class="form-grid">
          <div><label>CURRENT PASSWORD</label><input id="cp-current" type="password"></div>
          <div><label>NEW PASSWORD</label><input id="cp-new" type="password"></div>
          <button class="btn btn-primary btn-sm" id="cp-save">CHANGE PASSWORD</button>
        </div>
        <p class="hint" style="margin-top:.8rem">For your security, sessions expire automatically after 12 hours. You will need to log in again after logging out or when your session expires.</p>
      </div>
    </div>`;
  const pfAvatarBox = $('#pf-avatar-box');
  if (pfAvatarBox) {
    pfAvatarBox.addEventListener('click', () => $('#pf-avatar-file').click());
    $('#pf-avatar-file').addEventListener('change', async () => {
      try {
        const durl = await readLogoFile($('#pf-avatar-file').files[0]);
        if (durl) {
          const d = await api('/api/auth/avatar', { method: 'PUT', body: { data: durl } });
          ME = d.user;
          toast(d.message, 'success');
          renderNav();
          viewProfile(view);
        }
      } catch (err) { toast(err.message, 'error'); }
    });
  }
  $('#pf-save').addEventListener('click', async () => {
    try {
      const body = { display_name: $('#pf-name').value };
      if (u.player) { body.previous_team = $('#pf-prev').value; }
      if (u.manager) body.contact = $('#pf-contact').value;
      const d = await api('/api/auth/profile', { method: 'PUT', body });
      ME = d.user;
      toast(d.message, 'success');
      renderNav();
      viewProfile(view);
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#cp-save').addEventListener('click', async () => {
    try {
      const d = await api('/api/auth/change-password', { method: 'POST', body: {
        current_password: $('#cp-current').value, new_password: $('#cp-new').value,
      } });
      toast(d.message, 'success');
    } catch (err) { toast(err.message, 'error'); }
  });
}

/* ================= notifications drawer ================= */
function initNotifDrawer() {
  $('#notif-bell').addEventListener('click', async () => {
    const drawer = $('#notif-drawer');
    drawer.classList.toggle('hidden');
    if (!drawer.classList.contains('hidden')) {
      const { notifications } = await api('/api/notifications');
      $('#notif-list').innerHTML = notifications.map((n) => `
        <div class="notif-item ${n.is_read ? '' : 'unread'}">
          <div class="n-title">${esc(n.title)}</div>
          <div class="n-body">${esc(n.body)}</div>
          <div class="n-time">${fmtDateTime(n.created_at)}</div>
        </div>`).join('') || '<div class="empty-state">No notifications yet.</div>';
    }
  });
  $('#notif-close').addEventListener('click', () => $('#notif-drawer').classList.add('hidden'));
  $('#notif-read-all').addEventListener('click', async () => {
    await api('/api/notifications/read', { method: 'POST' });
    await refreshUnread();
    $('#notif-bell').click(); $('#notif-bell').click();
  });
}

$('#logout-btn').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch {}
  ME = null;
  if (WS) { try { WS.close(); } catch {} WS = null; }
  location.hash = '';
  $('#app').classList.add('hidden');
  $('#auth-screen').classList.remove('hidden');
  $('#login-error').textContent = '';
});

initAuthScreen();
initNotifDrawer();
boot();
