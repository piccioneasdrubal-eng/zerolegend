/**
 * server.js — entry point: HTTP (client statico) + WebSocket (gioco).
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const { GameServer, CONFIG } = require('./game');

const game = new GameServer();

// ===========================================================================
// HTTP: serve public/ e un semplice endpoint per spawnare bot via POST/GET
// ===========================================================================
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const server = http.createServer((req, res) => {
  // CORS: consente al frontend ospitato altrove (es. gamer.gd) di chiamare le API
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // API: spawn bot
  if (url.pathname === '/api/spawn-bot') {
    const count = clampInt(url.searchParams.get('count'), 1, 200, CONFIG.BOTS.DEFAULT_COUNT);
    const mass = clampInt(url.searchParams.get('mass'), 1, 10000, CONFIG.BOTS.DEFAULT_MASS);
    const prefix = (url.searchParams.get('name') || 'BOT').slice(0, 12).replace(/[^\w\-]/g, '');
    for (let i = 0; i < count; i++) {
      const p = game.addPlayer(`${prefix}${i + 1}`, true);
      p.cells[0].mass = mass;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, spawned: count, mass }));
    return;
  }

  // API: leaderboard
  if (url.pathname === '/api/leaderboard') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(game.leaderboard()));
    return;
  }

  // API: stato (debug)
  if (url.pathname === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      players: game.world.players.size,
      pellets: game.world.pellets.length,
    }));
    return;
  }

  // file statici
  let filePath = url.pathname === '/' ? '/index.html' : url.pathname;
  filePath = path.join(__dirname, 'public', path.normalize(filePath));
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

function clampInt(v, lo, hi, dflt) {
  const n = parseInt(v, 10);
  if (isNaN(n)) return dflt;
  return Math.max(lo, Math.min(hi, n));
}

// ===========================================================================
// WebSocket
// ===========================================================================
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  let player = null;

  // attende il nome dal client
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return; }

    if (!player) {
      if (msg.type === 'join') {
        const name = (msg.name || 'Player').toString().slice(0, 16);
        player = game.addPlayer(name, false);
        // personalizzazione: colore preferito (opzionale)
        if (typeof msg.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(msg.color)) {
          player.color = msg.color;
        }
        player.ws = ws;
        ws.send(JSON.stringify({ type: 'welcome', id: player.id, world: CONFIG.WORLD }));
      }
      return;
    }

    switch (msg.type) {
      case 'target':
        if (typeof msg.x === 'number' && typeof msg.y === 'number') {
          game.setTarget(player, msg.x, msg.y);
        }
        break;
      case 'split':
        game.split(player);
        break;
      case 'eject':
        game.eject(player);
        break;
      case 'chat':
        // chat globale: inoltra a tutti (nome + messaggio)
        if (typeof msg.text === 'string') {
          const text = msg.text.trim().slice(0, 120);
          if (!text) break;
          const out = JSON.stringify({ type: 'chat', name: player.name, id: player.id, isBot: player.isBot, text });
          for (const c of wss.clients) {
            if (c.readyState === 1) c.send(out);
          }
        }
        break;
    }
  });

  // messaggio di benvenuto in chat
  ws.on('close', () => {
    if (player) game.removePlayer(player.id);
  });

  ws.on('error', () => {});
});

// ===========================================================================
// BROADCAST e GAME LOOP
// ===========================================================================
const gameLoop = setInterval(() => {
  game.tick();
  const snap = game.snapshot();
  const lb = game.leaderboard();
  const payload = JSON.stringify({ type: 'state', ...snap, leaderboard: lb });

  for (const client of wss.clients) {
    if (client.readyState === 1) {
      client.send(payload);
    }
  }
}, CONFIG.TICK);

// ===========================================================================
// AVVIO — e prefilla qualche bot per l'allenamento immediato
// ===========================================================================
// Render richiede di ascoltare su 0.0.0.0 e di usare la PORT fornita dall'host
const HOST = process.env.HOST || '0.0.0.0';
server.listen(CONFIG.PORT, HOST, () => {
  console.log('==============================================');
  console.log('  agar-server  —  il TUO gioco .io');
  console.log('==============================================');
  console.log(`  Bind:    http://${HOST}:${CONFIG.PORT}`);
  console.log(`  Client:  http://localhost:${CONFIG.PORT}`);
  console.log(`  Bot:     http://localhost:${CONFIG.PORT}/api/spawn-bot?count=10&mass=30&name=BOT`);
  console.log('==============================================');

  // bot iniziali per l'allenamento (spawnano vicino al centro, subito visibili)
  const initial = 20;
  for (let i = 0; i < initial; i++) {
    const p = game.addPlayer(`Bot${i + 1}`, true);
    p.cells[0].mass = CONFIG.BOTS.DEFAULT_MASS;
  }
  console.log(`  Ho spawnato ${initial} bot iniziali (aggressivi, vicino al centro).`);
  console.log('  Premi Ctrl+C per fermare.');
});

console.log('Avvio server...');
