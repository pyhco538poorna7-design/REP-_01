'use strict';
const express = require('express');
const http = require('http');
const path = require('path');
const db = require('./db');
const { attachUser } = require('./auth');
const { handleUpgrade } = require('./ws');

const app = express();
const server = http.createServer(app);
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));
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
