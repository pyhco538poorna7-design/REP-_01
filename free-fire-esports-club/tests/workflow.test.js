'use strict';
/* End-to-end workflow tests. Spawns a fresh server on a temp database. */
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const WebSocket = require('ws');

const PORT = 3100;
const BASE = `http://localhost:${PORT}`;
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, extra) {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; failures.push(name + (extra ? ` :: ${extra}` : '')); console.log(`  ✗ ${name}`, extra || ''); }
}

function client() {
  let cookie = '';
  return {
    async req(method, urlPath, body) {
      const res = await fetch(BASE + urlPath, {
        method,
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      const setCookie = res.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      const data = await res.json().catch(() => ({}));
      return { status: res.status, data };
    },
    ws() {
      return new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://localhost:${PORT}/ws`, { headers: { Cookie: cookie } });
        const inbox = [];
        const waiters = [];
        ws.on('message', (raw) => {
          const msg = JSON.parse(raw.toString());
          if (waiters.length) waiters.shift()(msg);
          else inbox.push(msg);
        });
        ws.on('open', () => resolve({
          send: (obj) => ws.send(JSON.stringify(obj)),
          next: async (timeout = 5000, type = null) => {
            for (;;) {
              const msg = inbox.length ? inbox.shift() : await new Promise((res2, rej2) => { const t = setTimeout(() => rej2(new Error('ws timeout')), timeout); waiters.push((m) => { clearTimeout(t); res2(m); }); });
              if (msg.type === 'connected') continue;
              if (msg.type === 'joined' && type !== 'joined') continue;
              if (type && msg.type !== type) continue;
              return msg;
            }
          },
          close: () => ws.close(),
        }));
        ws.on('error', reject);
      });
    },
  };
}

async function waitForServer(tries = 40) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(BASE + '/api/auth/me');
      if (res.status === 401) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('Server did not start');
}

async function main() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ffclub-test-'));
  const server = spawn(process.execPath, [path.join(ROOT, 'server.js')], {
    env: { ...process.env, PORT: String(PORT), FF_DATA_DIR: tmp },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write('[server] ' + d));
  try {
    await waitForServer();
    // seed via child process against same data dir
    await new Promise((res, rej) => {
      const p = spawn(process.execPath, [path.join(ROOT, 'db.js')], { env: { ...process.env, FF_DATA_DIR: tmp } });
      p.on('exit', (c) => c === 0 ? res() : rej(new Error('seed failed')));
    });

    const admin = client(), mod = client(), mgr1 = client(), mgr2 = client(), p1 = client(), p3 = client(), anon = client();
    const L = (u, p) => ({ username: u, password: p });

    console.log('\n== 1. Authentication ==');
    let r = await anon.req('POST', '/api/auth/login', L('admin', 'wrongpass'));
    check('wrong password rejected', r.status === 401, JSON.stringify(r.data));
    r = await anon.req('GET', '/api/auth/me');
    check('unauthenticated /me is 401', r.status === 401);
    r = await admin.req('POST', '/api/auth/login', L('admin', 'admin123'));
    check('admin login', r.status === 200 && r.data.user.role === 'ADMIN', JSON.stringify(r.data));
    r = await admin.req('GET', '/api/auth/me');
    check('session cookie works', r.status === 200 && r.data.user.username === 'admin');
    await mod.req('POST', '/api/auth/login', L('mod', 'mod123'));
    await mgr1.req('POST', '/api/auth/login', L('manager1', 'manager123'));
    await mgr2.req('POST', '/api/auth/login', L('manager2', 'manager123'));
    await p1.req('POST', '/api/auth/login', L('player001', 'player123'));
    await p3.req('POST', '/api/auth/login', L('player003', 'player123'));
    r = await p1.req('GET', '/api/auth/me');
    check('player has profile + team', r.data.user.player && r.data.user.team && r.data.user.team.id === 1, JSON.stringify(r.data.user.team));

    const tmpClient = client();
    await tmpClient.req('POST', '/api/auth/login', L('player002', 'player123'));
    await tmpClient.req('POST', '/api/auth/logout');
    r = await tmpClient.req('GET', '/api/auth/me');
    check('logout destroys session', r.status === 401);

    console.log('\n== 2. Role-based access control ==');
    r = await p1.req('POST', '/api/auctions', { name: 'x', auction_date: '2025-01-01', start_time: '18:00' });
    check('player cannot create auction', r.status === 403);
    r = await mod.req('POST', '/api/auctions', { name: 'x', auction_date: '2025-01-01', start_time: '18:00' });
    check('MOD cannot create auction', r.status === 403);
    r = await mod.req('POST', '/api/users', { username: 'x', password: 'secret1', role: 'MOD', display_name: 'X' });
    check('MOD cannot create users', r.status === 403);
    r = await mod.req('PATCH', '/api/players/5/stats', { kills: 1 });
    check('MOD cannot edit official stats', r.status === 403);
    r = await mgr1.req('GET', '/api/users');
    check('manager cannot list users', r.status === 403);
    r = await mod.req('GET', '/api/audit-logs');
    check('MOD cannot read audit logs', r.status === 403);
    r = await p1.req('GET', '/api/leaderboards/kills');
    check('player can view leaderboards', r.status === 200);

    console.log('\n== 3. Public registration + manager approval ==');
    const newPlayer = client(), newManager = client();
    r = await newPlayer.req('POST', '/api/auth/register', {
      username: 'newplayer', password: 'secret1', display_name: 'New Player', role: 'PLAYER',
      game_id: 'FF00000001', roles: ['Rusher', 'Sniper'],
    });
    check('player registration', r.status === 201, JSON.stringify(r.data));
    r = await newPlayer.req('POST', '/api/auth/register', { username: 'newplayer', password: 'secret1', display_name: 'dup', role: 'PLAYER', game_id: 'x', roles: ['Rusher', 'Sniper'] });
    check('duplicate username rejected', r.status === 409);
    r = await newPlayer.req('POST', '/api/auth/register', { username: 'badroles', password: 'secret1', display_name: 'x', role: 'PLAYER', game_id: 'x', roles: ['Rusher'] });
    check('fewer than 2 roles rejected', r.status === 400);
    r = await newManager.req('POST', '/api/auth/register', {
      username: 'newmanager', password: 'secret1', display_name: 'New Manager', role: 'MANAGER',
      team_name: 'Test United', team_logo: '🎮', contact: 'test@example.com',
    });
    check('manager registration', r.status === 201);
    r = await newManager.req('POST', '/api/auth/register', {
      username: 'newmanager2', password: 'secret1', role: 'MANAGER',
      team_name: 'Test United', contact: 'x@example.com',
    });
    check('duplicate team name on manager register rejected', r.status === 409);
    await newManager.req('POST', '/api/auth/login', L('newmanager', 'secret1'));
    r = await newManager.req('GET', '/api/auth/me');
    check('manager team created automatically', r.data.user.team && r.data.user.team.name === 'Test United', JSON.stringify(r.data.user.team));
    r = await newManager.req('GET', '/api/teams/' + r.data.user.team.id);
    check('auto team is auction-ready', r.status === 200 && r.data.can_manage === true);
    r = await admin.req('GET', '/api/managers');
    const mgrRow = r.data.managers.find((x) => x.username === 'newmanager');
    check('admin managers list includes new manager', !!mgrRow && mgrRow.team_name === 'Test United', JSON.stringify(r.data.managers.slice(0, 2)));
    check('managers list sorted by wins desc', r.data.managers.every((x, i) => i === 0 || r.data.managers[i - 1].wins >= x.wins));

    console.log('\n== 3b. Profile pictures ==');
    const png1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
    r = await newPlayer.req('POST', '/api/auth/register', {
      username: 'picplayer', password: 'secret1', role: 'PLAYER',
      game_id: 'FF00000009', roles: ['Support', 'Sniper'], avatar: png1,
    });
    check('player registers with profile picture', r.status === 201, JSON.stringify(r.data));
    const picClient = client();
    r = await picClient.req('POST', '/api/auth/login', L('picplayer', 'secret1'));
    check('avatar returned on login', r.data.user.avatar === png1, JSON.stringify(r.data.user.avatar));
    r = await picClient.req('PUT', '/api/auth/avatar', { data: png1.replace('AAAA', 'AAAB') });
    check('profile picture can be changed later', r.status === 200 && r.data.user.avatar !== png1, JSON.stringify(r.data));
    r = await picClient.req('PUT', '/api/auth/avatar', { data: 'not-an-image' });
    check('invalid avatar rejected', r.status === 400);

    console.log('\n== 4. Auction lifecycle + live bidding + credits ==');
    r = await admin.req('POST', '/api/auctions', { name: 'Test Auction', auction_date: '2025-12-01', start_time: '18:00', starting_credits: 5000 });
    check('admin creates auction', r.status === 201);
    const auctionId = r.data.auction_id;
    r = await admin.req('GET', `/api/auctions/${auctionId}`);
    check('auction venue defaults to DC', r.data.auction.venue === 'DC', JSON.stringify(r.data.auction.venue));

    r = await mgr1.req('PATCH', `/api/auctions/${auctionId}/dc-link`, { dc_link: 'https://discord.gg/testdc' });
    check('manager cannot set DC link', r.status === 403);
    r = await admin.req('PATCH', `/api/auctions/${auctionId}/dc-link`, { dc_link: 'https://discord.gg/testdc' });
    check('admin sets DC link', r.status === 200);
    r = await p1.req('POST', `/api/auctions/${auctionId}/register`);
    check('player registers for auction (auto-approved)', r.status === 201, JSON.stringify(r.data));
    check('register message says auto-approved', /automatically/.test(r.data.message || ''));
    r = await p1.req('POST', `/api/auctions/${auctionId}/register`);
    check('duplicate registration blocked', r.status === 409);
    r = await p1.req('GET', `/api/auctions/${auctionId}`);
    check('registered player sees DC link', r.data.auction.dc_link === 'https://discord.gg/testdc', JSON.stringify(r.data.auction.dc_link));
    await newPlayer.req('POST', '/api/auth/login', L('newplayer', 'secret1'));
    r = await newPlayer.req('POST', `/api/auctions/${auctionId}/register`);
    check('second player registers', r.status === 201, JSON.stringify(r.data));
    r = await p3.req('GET', `/api/auctions/${auctionId}`);
    check('outsider player gets DC link masked', r.data.auction.dc_link === '', JSON.stringify(r.data.auction.dc_link));
    r = await mgr1.req('GET', `/api/auctions/${auctionId}`);
    const det = r.data;
    r = await p1.req('GET', '/api/auctions');
    check('player sees own registration status (approved automatically)', r.data.auctions.find((a) => a.id === auctionId).my_registration === 'approved');
    const reg = det.players.find((p) => p.username === 'newplayer' && p.reg_status === 'approved');
    const reg1 = det.players.find((p) => p.username === 'player001' && p.reg_status === 'approved');
    check('both players immediately approved in auction', !!reg && !!reg1, JSON.stringify(det.players.map((x) => `${x.username}:${x.reg_status}`)));

    r = await mgr1.req('POST', `/api/auctions/${auctionId}/bid`, { player_id: reg1.player_id, amount: 500 });
    check('bid on own team member rejected', r.status === 400);
    r = await mgr1.req('POST', `/api/auctions/${auctionId}/bid`, { player_id: reg.player_id, amount: 500 });
    check('bid before start rejected', r.status === 400);
    r = await admin.req('POST', `/api/auctions/${auctionId}/start`);
    check('admin starts auction', r.status === 200);
    r = await mgr1.req('GET', `/api/auctions/${auctionId}`);
    check('team ledger allocated 5000', r.data.my_team && r.data.my_team.credits === 5000 && r.data.my_team.available === 5000, JSON.stringify(r.data.my_team));
    r = await mgr2.req('GET', `/api/auctions/${auctionId}`);
    check('manager2 ledger allocated 5000', r.data.my_team && r.data.my_team.credits === 5000);

    r = await mgr1.req('POST', `/api/auctions/${auctionId}/bid`, { player_id: reg.player_id, amount: 500 });
    check('valid bid accepted', r.status === 201, JSON.stringify(r.data));
    r = await mgr1.req('POST', `/api/auctions/${auctionId}/bid`, { player_id: reg.player_id, amount: 600 });
    check('cannot outbid own highest bid', r.status === 400);
    r = await mgr2.req('POST', `/api/auctions/${auctionId}/bid`, { player_id: reg.player_id, amount: 505 });
    check('min increment enforced (505 < 510)', r.status === 400);
    r = await mgr2.req('POST', `/api/auctions/${auctionId}/bid`, { player_id: reg.player_id, amount: 510 });
    check('higher valid bid accepted', r.status === 201);
    r = await mgr1.req('POST', `/api/auctions/${auctionId}/bid`, { player_id: reg.player_id, amount: 99999 });
    check('bid exceeding credits rejected', r.status === 400);
    r = await mgr1.req('GET', `/api/auctions/${auctionId}`);
    check('losing bids do not deduct credits', r.data.my_team.spent === 0 && r.data.my_team.available === 5000, JSON.stringify(r.data.my_team));
    r = await mgr2.req('GET', `/api/auctions/${auctionId}`);
    check('available reflects held bid (4490)', r.data.my_team.available === 4490, JSON.stringify(r.data.my_team));

    r = await admin.req('POST', `/api/auctions/${auctionId}/sold`, { player_id: reg.player_id });
    check('admin closes bidding: SOLD', r.status === 200 && /SOLD/.test(r.data.message), JSON.stringify(r.data));
    r = await mgr2.req('GET', `/api/auctions/${auctionId}`);
    check('winning bid deducted (spent 510)', r.data.my_team.spent === 510 && r.data.my_team.available === 4490, JSON.stringify(r.data.my_team));
    r = await newPlayer.req('GET', '/api/auth/me');
    check('sold player moved to winning team', r.data.user.team && r.data.user.team.name === 'Nova Strike', JSON.stringify(r.data.user.team));
    r = await mgr2.req('POST', `/api/auctions/${auctionId}/bid`, { player_id: reg.player_id, amount: 600 });
    check('duplicate purchase prevented', r.status === 409);
    r = await mgr2.req('GET', `/api/auctions/${auctionId}/transactions`);
    check('purchase transaction recorded', r.data.transactions.some((t) => t.type === 'purchase' && t.amount === -510));

    // pause / resume
    r = await admin.req('POST', `/api/auctions/${auctionId}/pause`);
    check('pause works', r.status === 200);
    r = await mgr1.req('POST', `/api/auctions/${auctionId}/bid`, { player_id: reg.player_id + 1, amount: 200 });
    check('bidding blocked while paused', r.status === 400);
    r = await admin.req('POST', `/api/auctions/${auctionId}/resume`);
    check('resume works', r.status === 200);

    // unsold + close
    r = await mgr1.req('GET', `/api/auctions/${auctionId}`);
    const other = r.data.players.find((p) => p.reg_status === 'approved' && !p.result);
    r = await admin.req('POST', `/api/auctions/${auctionId}/unsold`, { player_id: other.player_id });
    check('player marked UNSOLD', r.status === 200);
    r = await admin.req('POST', `/api/auctions/${auctionId}/close`);
    check('auction closed', r.status === 200);
    r = await mgr1.req('GET', `/api/auctions/${auctionId}`);
    const unsoldCount = r.data.players.filter((p) => p.result && p.result.status === 'UNSOLD').length;
    check('remaining players marked UNSOLD on close', unsoldCount === r.data.players.filter((p) => p.reg_status === 'approved').length - 1, `unsold=${unsoldCount}`);
    r = await mgr1.req('POST', `/api/auctions/${auctionId}/bid`, { player_id: other.player_id, amount: 300 });
    check('bidding blocked after close', r.status === 400);

    console.log('\n== 5. Per-auction credit ledgers (no carry-over) ==');
    r = await admin.req('POST', '/api/auctions', { name: 'Auction Two', auction_date: '2025-12-15', start_time: '20:00', starting_credits: 5000 });
    const auction2 = r.data.auction_id;
    await admin.req('POST', `/api/auctions/${auction2}/start`);
    r = await mgr2.req('GET', `/api/auctions/${auction2}`);
    check('fresh 5000 budget in new auction', r.data.my_team.credits === 5000 && r.data.my_team.spent === 0, JSON.stringify(r.data.my_team));
    r = await mgr2.req('GET', `/api/auctions/${auctionId}`);
    check('old auction records intact', r.data.my_team.spent === 510);
    await admin.req('POST', `/api/auctions/${auction2}/close`);

    console.log('\n== 6. Leaderboards ==');
    r = await p1.req('GET', '/api/leaderboards/kills');
    const lbk = r.data.leaderboard;
    check('top kills sorted desc', lbk.every((x, i) => i === 0 || lbk[i - 1].kills >= x.kills));
    check('top kills has names/ids/teams', lbk[0].player_name && lbk[0].game_id);
    r = await p1.req('GET', '/api/leaderboards/teams');
    const lbt = r.data.leaderboard;
    check('team points = kills + 3*booyahs', lbt.every((t) => t.kill_points === t.total_kills + t.total_booyahs * 3));
    check('teams sorted by points', lbt.every((x, i) => i === 0 || lbt[i - 1].kill_points >= x.kill_points));
    check('ranks sequential', lbt[0].rank === 1 && lbt[1].rank === 2);
    r = await p1.req('GET', '/api/leaderboards/booyahs');
    const lbb = r.data.leaderboard;
    check('booyah board sorted desc', lbb.every((x, i) => i === 0 || lbb[i - 1].total_booyahs >= x.total_booyahs));

    console.log('\n== 7. Matches, room credentials, results ==');
    r = await mod.req('POST', '/api/matches', {
      tournament_name: 'Test Cup Final', match_date: '2025-12-20', match_time: '19:00',
      room_id: 'ROOM-123', room_password: 'secret-pass', room_published: false,
    });
    check('MOD creates match with room info', r.status === 201, JSON.stringify(r.data));
    const matchId = r.data.match_id;
    r = await p1.req('GET', '/api/matches');
    let m = r.data.matches.find((x) => x.id === matchId);
    check('room hidden from non-participants', m.room_id === null && m.room_access === false);
    r = await mgr1.req('POST', `/api/matches/${matchId}/register`);
    check('manager registers team for match', r.status === 201);
    r = await mgr1.req('POST', `/api/matches/${matchId}/register`);
    check('duplicate match registration blocked', r.status === 409);
    r = await p1.req('GET', '/api/matches');
    m = r.data.matches.find((x) => x.id === matchId);
    check('room still hidden before publish', m.room_id === null);
    r = await mod.req('PATCH', `/api/matches/${matchId}`, { room_published: true });
    check('MOD publishes room details', r.status === 200);
    r = await mgr1.req('GET', '/api/matches');
    m = r.data.matches.find((x) => x.id === matchId);
    check('registered manager sees room credentials', m.room_access === true && m.room_id === 'ROOM-123' && m.room_password === 'secret-pass');
    r = await p1.req('GET', '/api/matches');
    m = r.data.matches.find((x) => x.id === matchId);
    check('registered team member (player) sees room credentials', m.room_access === true && m.room_id === 'ROOM-123');
    r = await mgr2.req('GET', '/api/matches');
    m = r.data.matches.find((x) => x.id === matchId);
    check('non-participating manager cannot see room', m.room_access === false && m.room_id === null);
    r = await mod.req('POST', `/api/matches/${matchId}/results`, { team_id: 1, kills: 42, position: 1 });
    check('MOD records match result', r.status === 200);
    await mgr2.req('POST', `/api/matches/${matchId}/register`);
    r = await mod.req('POST', `/api/matches/${matchId}/results`, { team_id: 2, kills: 30, position: 2 });
    check('second result recorded', r.status === 200);
    r = await p1.req('GET', '/api/leaderboards/booyahs');
    check('result feeds booyah leaderboard', r.data.leaderboard.length > 0);
    r = await mod.req('PATCH', `/api/matches/${matchId}`, { status: 'completed' });
    check('MOD updates match status', r.status === 200);

    console.log('\n== 7b. Fair-play video proof ==');
    r = await mgr2.req('POST', `/api/matches/${matchId}/proof`, { url: 'https://example.com/not-winner.mp4' });
    check('non-winning team cannot upload proof', r.status === 403, JSON.stringify(r.data));
    r = await mgr1.req('POST', `/api/matches/${matchId}/proof`, { url: 'https://example.com/proof-team1.mp4' });
    check('winning manager uploads proof link', r.status === 201, JSON.stringify(r.data));
    const proofId = r.data.proof && r.data.proof.id;
    r = await p1.req('GET', `/api/matches/${matchId}/proof`);
    check('team member can view proofs', r.status === 200 && r.data.proofs.length === 1 && r.data.proofs[0].status === 'pending');
    r = await newManager.req('GET', `/api/matches/${matchId}/proof`);
    check('non-participant denied proof list', r.status === 403);
    r = await mod.req('POST', `/api/matches/${matchId}/proof/${proofId}/verify`);
    check('only ADMIN can verify proof', r.status === 403);
    r = await admin.req('POST', `/api/matches/${matchId}/proof/${proofId}/verify`);
    check('admin verifies proof', r.status === 200);
    r = await mgr1.req('POST', `/api/matches/${matchId}/proof`, { url: 'https://example.com/second.mp4' });
    check('duplicate proof blocked while verified', r.status === 409);
    r = await mgr1.req('GET', '/api/notifications');
    check('manager notified of proof verification', r.data.notifications.some((n) => /Proof verified/.test(n.title)));

    console.log('\n== 8. Team Center privacy + chat ==');
    r = await mgr1.req('GET', '/api/teams/1');
    check('manager views own team center', r.status === 200 && r.data.team.id === 1 && r.data.members.length > 0);
    check('team center shows totals + credits fields', typeof r.data.totals.total_kills === 'number');
    r = await mgr2.req('GET', '/api/teams/1');
    check('other manager denied private team center', r.status === 403);
    r = await p1.req('GET', '/api/teams/1');
    check('team member player can view team center', r.status === 200 && r.data.can_manage === false);
    r = await mgr1.req('POST', '/api/chat/1', { content: 'Practice at 8pm tonight' });
    check('manager posts chat message', r.status === 201);
    r = await p1.req('GET', '/api/chat/1');
    check('member reads chat history', r.status === 200 && r.data.messages.some((x) => x.content === 'Practice at 8pm tonight'));
    r = await admin.req('GET', '/api/chat/1');
    check('admin denied other team chat (privacy)', r.status === 403, JSON.stringify(r.data));
    r = await mgr2.req('GET', '/api/chat/1');
    check('outsider denied team chat', r.status === 403);

    console.log('\n== 9. WebSocket real-time ==');
    const wsMgr = await mgr1.ws();
    await wsMgr.send({ type: 'join', channel: 'team:1' });
    const joined = await wsMgr.next(5000, 'joined');
    check('manager joins team channel', joined.type === 'joined');
    const wsPlayer = await p1.ws();
    await wsPlayer.send({ type: 'join', channel: 'team:1' });
    wsMgr.send({ type: 'chat', teamId: 1, content: 'GLHF in the final!' });
    const chatMsg = await wsPlayer.next(5000, 'chat');
    check('real-time chat delivered', chatMsg.type === 'chat' && chatMsg.message.content === 'GLHF in the final!', JSON.stringify(chatMsg).slice(0, 120));
    wsPlayer.close(); wsMgr.close();

    const wsOutsider = await mgr2.ws();
    wsOutsider.send({ type: 'join', channel: 'team:1' });
    const denied = await wsOutsider.next(5000, 'error');
    check('outsider cannot join private team channel', denied.type === 'error', JSON.stringify(denied));
    wsOutsider.close();

    const wsAdmin = await admin.ws();
    wsAdmin.send({ type: 'join', channel: 'team:1' });
    const adminDenied = await wsAdmin.next(5000, 'error');
    check('admin cannot join private team channel', adminDenied.type === 'error', JSON.stringify(adminDenied));
    wsAdmin.close();

    // auction real-time
    r = await admin.req('POST', '/api/auctions', { name: 'RT Auction', auction_date: '2025-12-25', start_time: '18:00', starting_credits: 5000 });
    const rtAuction = r.data.auction_id;
    r = await p1.req('POST', `/api/auctions/${rtAuction}/register`);
    check('player registers for RT auction', r.status === 201);
    await newPlayer.req('POST', `/api/auctions/${rtAuction}/register`);
    await admin.req('POST', `/api/auctions/${rtAuction}/start`);
    const wsA = await mgr1.ws();
    await wsA.send({ type: 'join', channel: `auction:${rtAuction}` });
    r = await mgr1.req('GET', `/api/auctions/${rtAuction}`);
    const rtPlayer = r.data.players.find((p) => p.reg_status === 'approved' && p.username === 'newplayer');
    await mgr1.req('POST', `/api/auctions/${rtAuction}/bid`, { player_id: rtPlayer.player_id, amount: 250 });
    const upd = await wsA.next(5000, 'auction_update');
    check('live bid broadcast to auction room', upd.type === 'auction_update' && upd.auction_id === rtAuction, JSON.stringify(upd).slice(0, 120));
    wsA.close();
    await admin.req('POST', `/api/auctions/${rtAuction}/close`);

    console.log('\n== 10. Admin participates as manager ==');
    r = await admin.req('GET', '/api/auth/me');
    const adminId = r.data.user.id;
    r = await admin.req('POST', '/api/teams', { name: 'Admin Legion', logo: '👑', owner_user_id: adminId });
    check('admin registers own team', r.status === 201);
    r = await admin.req('GET', '/api/auth/me');
    check('admin now has manager identity + team', r.data.user.team && r.data.user.team.name === 'Admin Legion');
    r = await admin.req('POST', '/api/auctions', { name: 'Admin Play Auction', auction_date: '2025-12-30', start_time: '18:00', starting_credits: 5000 });
    const apAuction = r.data.auction_id;
    await p3.req('POST', `/api/auctions/${apAuction}/register`);
    await admin.req('POST', `/api/auctions/${apAuction}/start`);
    r = await admin.req('GET', `/api/auctions/${apAuction}`);
    check('admin team gets same 5000 starting credits', r.data.my_team && r.data.my_team.credits === 5000, JSON.stringify(r.data.my_team));
    const apPlayer = r.data.players.find((p) => p.reg_status === 'approved');
    r = await admin.req('POST', `/api/auctions/${apAuction}/bid`, { player_id: apPlayer.player_id, amount: 300 });
    check('admin can bid as manager', r.status === 201, JSON.stringify(r.data));
    await admin.req('POST', `/api/auctions/${apAuction}/close`);

    console.log('\n== 11. Admin user management + audit ==');
    r = await admin.req('POST', '/api/users', { username: 'mod2', password: 'modpass1', role: 'MOD', display_name: 'Second Mod' });
    check('admin creates MOD account', r.status === 201);
    const mod2 = client();
    r = await mod2.req('POST', '/api/auth/login', L('mod2', 'modpass1'));
    check('new MOD can log in', r.status === 200 && r.data.user.role === 'MOD');
    r = await admin.req('GET', '/api/users?q=player005');
    const p5id = r.data.users[0].id;
    r = await admin.req('PATCH', `/api/users/${p5id}`, { status: 'suspended' });
    check('admin suspends account', r.status === 200);
    const suspended = client();
    r = await suspended.req('POST', '/api/auth/login', L('player005', 'player123'));
    check('suspended account cannot log in', r.status === 403, JSON.stringify(r.data));
    await admin.req('PATCH', `/api/users/${p5id}`, { status: 'active' });
    r = await admin.req('GET', '/api/audit-logs');
    check('audit log records actions', r.status === 200 && r.data.logs.some((l) => l.action === 'auction_sold') && r.data.logs.some((l) => l.action === 'user_create'));

    console.log('\n== 12. Notifications ==');
    r = await p1.req('GET', '/api/notifications');
    const titles = r.data.notifications.map((n) => n.title);
    check('player notified of registration approval', titles.includes('Auction registration approved'), JSON.stringify(titles.slice(0, 6)));
    r = await newPlayer.req('GET', '/api/notifications');
    check('player notified of being sold', r.data.notifications.some((n) => n.title === 'You were sold!'));
    r = await mgr1.req('GET', '/api/notifications');
    check('manager notified of match room details', r.data.notifications.some((n) => n.title === 'Match room details published'));
    await p1.req('POST', '/api/notifications/read');
    r = await p1.req('GET', '/api/notifications');
    check('mark all read works', r.data.unread === 0);

    console.log('\n== 13. Scale check (100+ members) ==');
    r = await admin.req('GET', '/api/overview');
    check('100+ registered players', r.data.players >= 100, `players=${r.data.players}`);
    check('12+ teams', r.data.teams >= 12);

  } finally {
    server.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n========================================`);
  console.log(`PASSED: ${passed}   FAILED: ${failed}`);
  if (failures.length) { console.log('Failures:'); failures.forEach((f) => console.log(' - ' + f)); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
