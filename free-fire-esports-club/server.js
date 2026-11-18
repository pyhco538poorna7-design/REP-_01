'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const db = require('./db');
if (!db.prepare('SELECT COUNT(*) AS c FROM users').get().c) {
  const bcrypt = require('bcryptjs');
  db.prepare("INSERT INTO users (username, password_hash, role, display_name) VALUES ('admin', ?, 'ADMIN', 'Admin')")
    .run(bcrypt.hashSync('admin123', 10));
  console.log('Fresh database — created initial ADMIN account (admin / admin123). Change this password immediately.');
}
const { attachUser } = require('./auth');
const { handleUpgrade } = require('./ws');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.use(express.json({ limit: '40mb' }));
app.use(attachUser);

const { router: authRoutes } = require('./routes/authRoutes');
const { router: adminRoutes } = require('./routes/adminRoutes');
const { router: auctionRoutes } = require('./routes/auctionRoutes');
const { router: matchRoutes } = require('./routes/matchRoutes');
const { router: miscRoutes } = require('./routes/miscRoutes');

app.use('/api/auth', authRoutes);
app.use('/api', adminRoutes);
app.use('/api', auctionRoutes);
app.use('/api', matchRoutes);
app.use('/api', miscRoutes);

app.use('/api', (req, res) => res.status(404).json({ error: 'API endpoint not found.' }));

app.use(express.static(path.join(__dirname, 'public')));
const UPLOAD_ROOT = process.env.FF_DATA_DIR ? path.join(process.env.FF_DATA_DIR, 'uploads') : path.join(__dirname, 'data', 'uploads');
app.use('/uploads', express.static(UPLOAD_ROOT));

// eslint-disable-next-line no-unused-vars
app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
});

server.on('upgrade', (request, socket, head) => {
  if (request.url.startsWith('/ws')) handleUpgrade(request, socket, head);
  else socket.destroy();
});

server.listen(PORT, () => {
  console.log(`Free Fire Esports Club server running on http://localhost:${PORT}`);
});
