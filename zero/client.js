/**
 * client.js — gioco lato browser.
 * Mouse = movimento, Spazio = split, W = feed (espelli massa).
 */
(function () {
  'use strict';

  // ============================================================
  // CONFIGURAZIONE — URL del game server
  // ------------------------------------------------------------
  // ⚠️ METTI QUI il tuo URL ngrok (https, senza slash finale).
  //     es: 'https://abcd1234.ngrok-free.app'
  var SERVER_URL = 'https://sanctuary-visibly-cymbal.ngrok-free.dev'; // <-- URL del tuo tunnel ngrok
  // ============================================================

  function wsUrl(host) {
    if (host.startsWith('localhost') || host.startsWith('127.0.0.1'))
      return 'ws://' + host;
    return 'wss://' + host;
  }
  function httpUrl(host) {
    if (host.startsWith('localhost') || host.startsWith('127.0.0.1'))
      return 'http://' + host;
    return 'https://' + host;
  }
  // L'host a cui puntano WS e API (dedotto una sola volta)
  var SERVER_HOST = SERVER_URL
    ? SERVER_URL.replace(/^https?:\/\//i, '')
    : location.host;
  var WS_ROOT = wsUrl(SERVER_HOST);
  var API_ROOT = SERVER_URL
    ? SERVER_URL
    : httpUrl(SERVER_HOST);

  // ===== stato =====
  let ws = null;
  let myId = null;
  let world = { width: 5000, height: 5000 };
  let state = { players: [], pellets: [], leaderboard: [] };

  const canvas = document.getElementById('game');
  const ctx = canvas.getContext('2d');
  const mmCanvas = document.getElementById('minimap-canvas');
  const mmCtx = mmCanvas.getContext('2d');

  let camera = { x: 0, y: 0, zoom: 1 };
  let target = { x: 0, y: 0 };
  let mouse = { x: 0, y: 0 };
  let keys = {};

  // ===== dimensioni =====
  function resize() {
    canvas.width = window.innerWidth * devicePixelRatio;
    canvas.height = window.innerHeight * devicePixelRatio;
    canvas.style.width = window.innerWidth + 'px';
    canvas.style.height = window.innerHeight + 'px';
  }
  window.addEventListener('resize', resize);
  resize();

  // ===== input =====
  canvas.addEventListener('mousemove', (e) => {
    mouse.x = e.clientX;
    mouse.y = e.clientY;
  });

  window.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    keys[e.key] = true;
    if (e.key === ' ' || e.code === 'Space') {
      e.preventDefault();
      send({ type: 'split' });
    } else if (e.key.toLowerCase() === 'w') {
      send({ type: 'eject' });
    }
  });
  window.addEventListener('keyup', (e) => {
    keys[e.key] = false;
  });

  // pulsanti Split / Feed (touch + click)
  document.getElementById('btn-split').addEventListener('click', () => send({ type: 'split' }));
  document.getElementById('btn-feed').addEventListener('click', () => send({ type: 'eject' }));
  // evitano di far perdere il focus / doppia attivazione su touch
  ['btn-split', 'btn-feed'].forEach((id) => {
    const b = document.getElementById(id);
    b.addEventListener('touchstart', (e) => e.preventDefault(), { passive: false });
  });

  // ===== websocket =====
  function connect(name) {
    ws = new WebSocket(WS_ROOT);

    ws.onopen = () => send({ type: 'join', name });

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'welcome') {
        myId = msg.id;
        world = msg.world;
        document.getElementById('menu').style.display = 'none';
      } else if (msg.type === 'state') {
        state = msg;
        world = { width: msg.world.width, height: msg.world.height };
      }
    };

    ws.onclose = () => {
      document.getElementById('menu').style.display = 'flex';
    };
  }

  function send(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  // ===== menu =====
  document.getElementById('play').addEventListener('click', () => {
    const name = document.getElementById('name').value.trim() || 'Player';
    connect(name);
  });
  document.getElementById('name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('play').click();
  });

  // ===== spawn bot =====
  document.getElementById('bot-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const count = document.getElementById('bot-count').value;
    const mass = document.getElementById('bot-mass').value;
    const name = document.getElementById('bot-name').value || 'Bot';
    const status = document.getElementById('bot-status');
    status.textContent = 'Spawn in corso...';
    try {
      const res = await fetch(`${API_ROOT}/api/spawn-bot?count=${count}&mass=${mass}&name=${encodeURIComponent(name)}`);
      const data = await res.json();
      status.textContent = `✅ Spawnati ${data.spawned} bot (massa ${data.mass}).`;
    } catch (err) {
      status.textContent = '❌ Errore.';
    }
  });

  // ===== game loop (render) =====
  function me() {
    return state.players.find((p) => p.id === myId);
  }

  function updateCamera() {
    const m = me();
    if (!m || !m.cells.length) return;
    let mx = 0, my = 0, mm = 0;
    for (const c of m.cells) { mx += c.x * c.mass; my += c.y * c.mass; mm += c.mass; }
    mx /= mm; my /= mm;

    // zoom in base alla massa
    const mass = m.mass;
    const targetZoom = clamp(Math.pow(Math.min(mass, 20000), 0.4) / 6, 0.4, 2.2);

    camera.x = mx;
    camera.y = my;
    camera.zoom += (targetZoom - camera.zoom) * 0.1;

    // calcola il target nel mondo per il server
    const wx = (mouse.x - canvas.width / devicePixelRatio / 2) / camera.zoom + camera.x;
    const wy = (mouse.y - canvas.height / devicePixelRatio / 2) / camera.zoom + camera.y;
    target = { x: wx, y: wy };
    send({ type: 'target', x: wx, y: wy });
  }

  function draw() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const dpr = devicePixelRatio;
    ctx.save();
    ctx.scale(dpr, dpr);
    ctx.translate(canvas.width / dpr / 2, canvas.height / dpr / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);

    drawGrid();
    drawPellets();
    drawCells();

    ctx.restore();

    drawHUD();
    drawMinimap();
    drawLeaderboard();
  }

  function drawGrid() {
    const dpr = devicePixelRatio;
    const vw = world.width, vh = world.height;
    ctx.strokeStyle = 'rgba(255,255,255,0.03)';
    ctx.lineWidth = 1 / camera.zoom;
    const step = 100;
    const x0 = camera.x - canvas.width / dpr / 2 / camera.zoom;
    const x1 = camera.x + canvas.width / dpr / 2 / camera.zoom;
    const y0 = camera.y - canvas.height / dpr / 2 / camera.zoom;
    const y1 = camera.y + canvas.height / dpr / 2 / camera.zoom;

    ctx.beginPath();
    for (let x = Math.floor(x0 / step) * step; x <= x1; x += step) {
      ctx.moveTo(x, y0); ctx.lineTo(x, y1);
    }
    for (let y = Math.floor(y0 / step) * step; y <= y1; y += step) {
      ctx.moveTo(x0, y); ctx.lineTo(x1, y);
    }
    ctx.stroke();

    // bordo mondo
    ctx.strokeStyle = '#ff4d4d';
    ctx.lineWidth = 4 / camera.zoom;
    ctx.strokeRect(0, 0, vw, vh);
  }

  function drawPellets() {
    ctx.fillStyle = '#7d8590';
    for (const p of state.pellets) {
      // culling
      if (p.x < camera.x - 1000 || p.x > camera.x + 1000) continue;
      if (p.y < camera.y - 1000 || p.y > camera.y + 1000) continue;
      const r = 4 + p.mass;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function drawCells() {
    const m = me();
    for (const p of state.players) {
      for (const c of p.cells) {
        const r = 10 * Math.sqrt(c.mass);
        // cerchio
        ctx.beginPath();
        ctx.arc(c.x, c.y, r, 0, Math.PI * 2);
        ctx.fillStyle = p.color;
        ctx.fill();
        ctx.strokeStyle = 'rgba(0,0,0,0.35)';
        ctx.lineWidth = Math.max(1, r * 0.06);
        ctx.stroke();

        // nome (solo se abbastanza grande o è me stesso)
        if (r > 20 || p.id === myId) {
          ctx.fillStyle = '#fff';
          ctx.font = `bold ${Math.max(11, r * 0.35)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(p.name + (p.isBot ? ' 🤖' : ''), c.x, c.y);
          if (p.id === myId) {
            ctx.font = `bold ${Math.max(9, r * 0.22)}px sans-serif`;
            ctx.fillText(Math.round(c.mass), c.x, c.y + r * 0.4);
          }
        }
      }
    }
  }

  function drawHUD() {
    const m = me();
    document.getElementById('mass').textContent = m ? `Massa: ${Math.round(m.mass)}` : '';
  }

  function drawMinimap() {
    mmCtx.clearRect(0, 0, 160, 160);
    const scale = 160 / Math.max(world.width, world.height);

    // sfondo mondo
    mmCtx.fillStyle = 'rgba(255,255,255,0.04)';
    mmCtx.fillRect(0, 0, 160, 160);

    // bordo mondo
    mmCtx.strokeStyle = 'rgba(255,77,77,.6)';
    mmCtx.lineWidth = 1;
    mmCtx.strokeRect(0, 0, world.width * scale, world.height * scale);

    // players
    for (const p of state.players) {
      if (!p.cells.length) continue;
      const c = p.cells[0];
      mmCtx.fillStyle = p.id === myId ? '#6ee7ff' : p.color;
      const r = p.id === myId ? 3 : 2;
      mmCtx.beginPath();
      mmCtx.arc(c.x * scale, c.y * scale, r, 0, Math.PI * 2);
      mmCtx.fill();
    }

    // viewport (l'area che stai guardando)
    const vwpx = (canvas.width / devicePixelRatio) / camera.zoom * scale;
    const vhpx = (canvas.height / devicePixelRatio) / camera.zoom * scale;
    mmCtx.strokeStyle = 'rgba(110,231,255,.85)';
    mmCtx.lineWidth = 1.5;
    mmCtx.strokeRect(
      camera.x * scale - vwpx / 2,
      camera.y * scale - vhpx / 2,
      vwpx, vhpx
    );
  }

  function drawLeaderboard() {
    const list = document.getElementById('lb-list');
    list.innerHTML = '';
    state.leaderboard.forEach((e, i) => {
      const li = document.createElement('li');
      li.className = (e.id === myId ? 'me' : '') + (e.isBot ? ' bot' : '');
      li.innerHTML =
        `<span class="rank">${i + 1}.</span>` +
        `<span class="name">${escapeHtml(e.name)}</span>` +
        `<span class="m">${e.mass}</span>`;
      list.appendChild(li);
    });
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  function loop() {
    updateCamera();
    draw();
    requestAnimationFrame(loop);
  }
  requestAnimationFrame(loop);
})();
