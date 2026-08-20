/**
 * agar-server — gioco .io-like multi-player (stile agar.io)
 * 100% tuo, 100% legittimo: tu definisci le regole.
 *
 * Server: Node.js + ws (WebSocket) + client statico in public/.
 */

// ===========================================================================
// CONFIGURAZIONE
// ===========================================================================
const CONFIG = {
  PORT: process.env.PORT || 3000,
  WORLD: {
    WIDTH: 5000,               // larghezza mondo
    HEIGHT: 5000,              // altezza mondo
    PELLET_COUNT: 1200,        // pellet base
    PELLET_MASS: 1,            // massa di ogni pellet
    START_MASS: 20,            // massa iniziale giocatore
  },
  PHYSICS: {
    BASE_SPEED: 3.0,           // velocità base (px/frame)
    SPEED_MASS_DECAY: 0.55,    // esponente di decadimento velocità con la massa
    EAT_FACTOR: 1.15,          // rapporto minimo per mangiare un altro
    SPLIT_COOLDOWN: 1000,      // ms tra split
    SPLIT_MASS_THRESHOLD: 20,  // massa minima per splittare
    EJECT_MASS: 15,            // massa espulsa con "feed"
    MERGE_TIMEOUT: 30_000,     // ms prima che le celle si riuniscano
  },
  TICK: 1000 / 30,             // 30 fps lato server
  BOTS: {
    DEFAULT_COUNT: 30,
    DEFAULT_MASS: 30,
    AGGRESSION: 0.95,          // probabilità di inseguire un bersaglio (era 0.7)
    VIEW_RADIUS: 1600,         // raggio di "vista" dei bot (era 800)
    SPAWN_RADIUS: 1200,        // raggio attorno al centro dove spawnano i bot
    CHASE_RANGE: 1400,         // distanza entro cui un bot insegue un umano
  },
};

// ===========================================================================
// UTILITÀ
// ===========================================================================
const rand = (min, max) => min + Math.random() * (max - min);
const randInt = (min, max) => Math.floor(rand(min, max + 1));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const randColor = () =>
  `hsl(${randInt(0, 360)}, ${randInt(45, 85)}%, ${randInt(45, 60)}%)`;
const uid = () => Math.random().toString(36).slice(2, 10);

/** La massa determina il raggio: area proporzionale alla massa. */
function radiusFromMass(mass) {
  return Math.sqrt(mass * 100) / Math.PI; // radius = sqrt(mass / PI) * ... sintonizzato
}
// Raggio più "umano": r = 10 * sqrt(mass)
function cellRadius(mass) {
  return 10 * Math.sqrt(mass);
}

// ===========================================================================
// STATO DEL MONDO
// ===========================================================================
class World {
  constructor() {
    this.players = new Map(); // id -> Player
    this.pellets = [];
    this.cells = new Map();   // cellId -> Cell (per lookup rapido)
    this.powerups = [];        // potenziamenti sparsi nel mondo
  }

  initPellets() {
    for (let i = 0; i < CONFIG.WORLD.PELLET_COUNT; i++) {
      this.pellets.push({
        id: uid(),
        x: rand(0, CONFIG.WORLD.WIDTH),
        y: rand(0, CONFIG.WORLD.HEIGHT),
        mass: CONFIG.WORLD.PELLET_MASS,
      });
    }
  }

  spawnPellet() {
    this.pellets.push({
      id: uid(),
      x: rand(0, CONFIG.WORLD.WIDTH),
      y: rand(0, CONFIG.WORLD.HEIGHT),
      mass: CONFIG.WORLD.PELLET_MASS,
    });
  }

  // ===== POWER-UP =====
  initPowerups() {
    const types = ['virus', 'speed', 'mass', 'invisible', 'magnet'];
    for (let i = 0; i < 25; i++) {
      const type = types[randInt(0, types.length - 1)];
      const mass = type === 'mass' ? 100 : type === 'virus' ? 160 : 40;
      this.powerups.push({
        id: uid(),
        x: rand(0, CONFIG.WORLD.WIDTH),
        y: rand(0, CONFIG.WORLD.HEIGHT),
        type,
        mass, // virus = grande, mass = bottino
      });
    }
  }

  spawnPowerup() {
    const types = ['virus', 'speed', 'mass', 'invisible', 'magnet'];
    const type = types[randInt(0, types.length - 1)];
    const mass = type === 'mass' ? 100 : type === 'virus' ? 160 : 40;
    this.powerups.push({
      id: uid(),
      x: rand(0, CONFIG.WORLD.WIDTH),
      y: rand(0, CONFIG.WORLD.HEIGHT),
      type,
      mass,
    });
  }
}

// ===========================================================================
// ENTITÀ
// ===========================================================================
class Cell {
  constructor(x, y, mass, ownerId) {
    this.id = uid();
    this.x = x;
    this.y = y;
    this.mass = mass;
    this.ownerId = ownerId; // id giocatore/bot
    this.bornAt = Date.now();
  }
  get radius() {
    return cellRadius(this.mass);
  }
}

class Player {
  constructor(id, name, isBot = false) {
    this.id = id;
    this.name = name;
    this.isBot = isBot;
    this.color = randColor();
    this.cells = [];
    this.target = { x: rand(0, CONFIG.WORLD.WIDTH), y: rand(0, CONFIG.WORLD.HEIGHT) };
    this.lastSplit = 0;
    this.score = 0;
    this.ws = null; // solo per umani
    this.botState = null; // stato IA per bot
  }

  get totalMass() {
    return this.cells.reduce((s, c) => s + c.mass, 0);
  }

  get center() {
    if (!this.cells.length) return null;
    const mass = this.totalMass;
    if (mass === 0) return this.cells[0];
    let x = 0, y = 0;
    for (const c of this.cells) { x += c.x * c.mass; y += c.y * c.mass; }
    return { x: x / mass, y: y / mass, mass };
  }

  spawnCell() {
    const p = this.center || { x: rand(0, CONFIG.WORLD.WIDTH), y: rand(0, CONFIG.WORLD.HEIGHT) };
    const c = new Cell(p.x, p.y, CONFIG.WORLD.START_MASS, this.id);
    this.cells.push(c);
    return c;
  }

  spawnCellAt(x, y) {
    const c = new Cell(clamp(x, 0, CONFIG.WORLD.WIDTH), clamp(y, 0, CONFIG.WORLD.HEIGHT), CONFIG.WORLD.START_MASS, this.id);
    this.cells.push(c);
    return c;
  }
}

// ===========================================================================
// SERVER DI GIOCO
// ===========================================================================
class GameServer {
  constructor() {
    this.world = new World();
    this.world.initPellets();
    this.world.initPowerups();
    this.lastTick = Date.now();
  }

  addPlayer(name, isBot = false) {
    const p = new Player(uid(), name, isBot);
    this.world.players.set(p.id, p);
    if (isBot) {
      // i bot spawnano vicino al centro per essere subito visibili/incontroabili
      const cx = CONFIG.WORLD.WIDTH / 2;
      const cy = CONFIG.WORLD.HEIGHT / 2;
      p.spawnCellAt(cx + rand(-CONFIG.BOTS.SPAWN_RADIUS, CONFIG.BOTS.SPAWN_RADIUS),
                     cy + rand(-CONFIG.BOTS.SPAWN_RADIUS, CONFIG.BOTS.SPAWN_RADIUS));
      p.botState = { wanderTheta: rand(0, Math.PI * 2), retargetAt: 0 };
    } else {
      p.spawnCell();
    }
    return p;
  }

  removePlayer(id) {
    const p = this.world.players.get(id);
    if (!p) return;
    // rilascia massa sotto forma di pellet
    for (const c of p.cells) {
      const pellets = Math.max(1, Math.floor(c.mass / 5));
      for (let i = 0; i < pellets; i++) {
        this.world.pellets.push({
          id: uid(),
          x: c.x + rand(-c.radius, c.radius),
          y: c.y + rand(-c.radius, c.radius),
          mass: CONFIG.WORLD.PELLET_MASS * 2,
        });
      }
    }
    this.world.players.delete(id);
  }

  // ==== FISICA / MOVIMENTO ====
  movePlayer(p, dt) {
    if (!p.cells.length) return;
    const center = p.center;
    if (!center) return;
    const t = p.target || center;
    for (const cell of p.cells) {
      // direzione verso il target
      let dx = t.x - cell.x;
      let dy = t.y - cell.y;
      let d = Math.hypot(dx, dy);
      const speed = this.speedAt(cell) * (p.speedBoost && p.speedBoost > now ? 1.7 : 1);
      if (d > 1) {
        cell.x += (dx / d) * speed * dt;
        cell.y += (dy / d) * speed * dt;
      }
      // separazione tra le proprie celle (mucchio, non esattamente sovrapposte)
      for (const other of p.cells) {
        if (other === cell) continue;
        const sx = cell.x - other.x;
        const sy = cell.y - other.y;
        const sd = Math.hypot(sx, sy);
        const minD = cell.radius + other.radius;
        if (sd < minD && sd > 0) {
          const push = (minD - sd) * 0.5;
          cell.x += (sx / sd) * push;
          cell.y += (sy / sd) * push;
        }
      }
      // bordi del mondo
      cell.x = clamp(cell.x, cell.radius, CONFIG.WORLD.WIDTH - cell.radius);
      cell.y = clamp(cell.y, cell.radius, CONFIG.WORLD.HEIGHT - cell.radius);
    }
  }

  speedAt(cell) {
    const decay = Math.pow(cell.mass, -CONFIG.PHYSICS.SPEED_MASS_DECAY);
    return CONFIG.PHYSICS.BASE_SPEED * 100 * decay;
  }
  setTarget(p, x, y) {
    p.target = { x, y };
    // spinge le celle verso il target
    const c = p.center;
    if (!c) return;
    const dx = x - c.x, dy = y - c.y;
    const d = Math.hypot(dx, dy) || 1;
    for (const cell of p.cells) {
      if (dist(cell, c) > 1) {
        // separazione tra le proprie celle (riunione)
        const mx = c.x - cell.x, my = c.y - cell.y;
        const md = Math.hypot(mx, my) || 1;
        cell.x += (mx / md) * 0.5;
        cell.y += (my / md) * 0.5;
      }
    }
  }

  // ==== AZIONI ====
  split(p) {
    const now = Date.now();
    if (now - p.lastSplit < CONFIG.PHYSICS.SPLIT_COOLDOWN) return;
    p.lastSplit = now;
    const eligible = p.cells.filter((c) => c.mass >= CONFIG.PHYSICS.SPLIT_MASS_THRESHOLD);
    if (!eligible.length) return;
    const cell = eligible[0];
    const half = cell.mass / 2;
    cell.mass = half;
    const dir = p.target ? Math.atan2(p.target.y - cell.y, p.target.x - cell.x) : 0;
    const nx = cell.x + Math.cos(dir) * (cell.radius + cellRadius(half));
    const ny = cell.y + Math.sin(dir) * (cell.radius + cellRadius(half));
    const nc = new Cell(
      clamp(nx, 0, CONFIG.WORLD.WIDTH),
      clamp(ny, 0, CONFIG.WORLD.HEIGHT),
      half,
      p.id
    );
    nc.bornAt = now;
    p.cells.push(nc);
  }

  eject(p) {
    if (!p.cells.length || p.totalMass < 20) return;
    const cell = p.cells.reduce((a, b) => (a.mass > b.mass ? a : b));
    cell.mass -= CONFIG.PHYSICS.EJECT_MASS;
    const dir = p.target ? Math.atan2(p.target.y - cell.y, p.target.x - cell.x) : 0;
    this.world.pellets.push({
      id: uid(),
      x: cell.x + Math.cos(dir) * cell.radius,
      y: cell.y + Math.sin(dir) * cell.radius,
      mass: CONFIG.PHYSICS.EJECT_MASS,
    });
  }

  // ==== COLLISIONI ====
  resolveCollisions() {
    // pellet
    for (const player of this.world.players.values()) {
      for (const cell of player.cells) {
        for (let i = this.world.pellets.length - 1; i >= 0; i--) {
          const pl = this.world.pellets[i];
          if (dist(cell, pl) < cell.radius) {
            cell.mass += pl.mass;
            this.world.pellets.splice(i, 1);
          }
        }
      }
    }

    // giocatore-mangia-giocatore
    const players = [...this.world.players.values()];
    for (const eater of players) {
      for (const victim of players) {
        if (eater.id === victim.id) continue;
        this.tryEat(eater, victim);
      }
    }
  }

  tryEat(eater, victim) {
    for (const ec of eater.cells) {
      for (let i = victim.cells.length - 1; i >= 0; i--) {
        const vc = victim.cells[i];
        if (ec.mass > vc.mass * CONFIG.PHYSICS.EAT_FACTOR && dist(ec, vc) < ec.radius - vc.radius * 0.4) {
          ec.mass += vc.mass;
          victim.cells.splice(i, 1);
        }
      }
    }
    if (!victim.cells.length) {
      // vittima eliminata -> respawn
      this.respawn(victim);
    }
  }

  // ==== POWER-UP ====
  resolvePowerups() {
    for (const player of this.world.players.values()) {
      for (const cell of player.cells) {
        for (let i = this.world.powerups.length - 1; i >= 0; i--) {
          const pu = this.world.powerups[i];
          if (dist(cell, pu) < cell.radius) {
            this.applyPowerup(player, cell, pu);
            this.world.powerups.splice(i, 1);
          }
        }
      }
    }
    // mantieni un numero minimo di power-up
    while (this.world.powerups.length < 20) this.world.spawnPowerup();
  }

  applyPowerup(player, cell, pu) {
    switch (pu.type) {
      case 'mass':
        cell.mass += pu.mass;
        break;
      case 'virus':
        // il virus esplode la cella in tante celle piccole (come agar.io)
        this.explodeFromVirus(player, cell);
        break;
      case 'speed':
        player.speedBoost = Date.now() + 8000; // +velocità per 8s
        break;
      case 'invisible':
        player.invisible = Date.now() + 5000; // invisibile per 5s
        break;
      case 'magnet':
        player.magnet = Date.now() + 6000; // attira pellet per 6s
        break;
    }
  }

  explodeFromVirus(player, cell) {
    if (cell.mass < 50) return;
    const pieces = Math.min(16, Math.floor(cell.mass / 10));
    const perPiece = cell.mass / pieces;
    for (let i = 0; i < pieces; i++) {
      const ang = rand(0, Math.PI * 2);
      const nx = cell.x + Math.cos(ang) * (cell.radius + 20);
      const ny = cell.y + Math.sin(ang) * (cell.radius + 20);
      const nc = new Cell(
        clamp(nx, 0, CONFIG.WORLD.WIDTH),
        clamp(ny, 0, CONFIG.WORLD.HEIGHT),
        perPiece,
        player.id
      );
      nc.bornAt = Date.now();
      player.cells.push(nc);
    }
    player.cells = player.cells.filter((c) => c !== cell);
  }

  respawn(p) {
    p.cells = [];
    p.spawnCell();
  }

  // ==== MERGE ====
  mergeCells() {
    const now = Date.now();
    for (const p of this.world.players.values()) {
      const cells = p.cells.slice();
      for (let i = 0; i < cells.length; i++) {
        for (let j = i + 1; j < cells.length; j++) {
          const a = cells[i], b = cells[j];
          if (now - a.bornAt > CONFIG.PHYSICS.MERGE_TIMEOUT
            && now - b.bornAt > CONFIG.PHYSICS.MERGE_TIMEOUT
            && dist(a, b) < a.radius + b.radius) {
            a.mass += b.mass;
            a.x = (a.x + b.x) / 2;
            a.y = (a.y + b.y) / 2;
            p.cells = p.cells.filter((c) => c !== b);
            return; // ricalcoliamo al prossimo tick
          }
        }
      }
    }
  }

  // ==== IA BOT ====
  updateBot(p, dt) {
    if (!p.cells.length) { p.spawnCell(); return; }
    const s = p.botState;
    const c = p.center;
    const now = Date.now();
    let tx, ty;

    // trova bersaglio più vicino (giocatore piccolo / pellet vicino)
    const threats = [], preys = [];
    for (const other of this.world.players.values()) {
      if (other.id === p.id) continue;
      const o = other.center;
      if (!o) continue;
      const d = dist(c, o);
      if (d > CONFIG.BOTS.VIEW_RADIUS) continue;
      if (o.mass * CONFIG.PHYSICS.EAT_FACTOR < p.totalMass) preys.push({ o, d });
      else if (p.totalMass * CONFIG.PHYSICS.EAT_FACTOR < o.mass) threats.push({ o, d });
    }

    // 0) INSEGUI un umano vicino, anche se è più grande (aggressivo)
    let nearestHuman = null, nd = Infinity;
    for (const other of this.world.players.values()) {
      if (other.id === p.id || other.isBot) continue;
      const o = other.center;
      if (!o) continue;
      const d = dist(c, o);
      if (d < nd) { nd = d; nearestHuman = o; }
    }
    if (nearestHuman && nd < CONFIG.BOTS.CHASE_RANGE && Math.random() < CONFIG.BOTS.AGGRESSION) {
      tx = nearestHuman.x;
      ty = nearestHuman.y;
    }
    // 1) fuggi solo se c'è un bot molto più grande
    else if (threats.length) {
      threats.sort((x, y) => x.d - y.d);
      const t = threats[0].o;
      const ang = Math.atan2(c.y - t.y, c.x - t.x);
      tx = c.x + Math.cos(ang) * 500;
      ty = c.y + Math.sin(ang) * 500;
    }
    // 2) insegui preda
    else if (preys.length && Math.random() < CONFIG.BOTS.AGGRESSION) {
      preys.sort((x, y) => x.d - y.d);
      tx = preys[0].o.x;
      ty = preys[0].o.y;
    }
    // 3) raccogli pellet vicino
    else {
      let best = null, bestD = Infinity;
      // cerca pellet entro raggio ridotto per efficienza
      for (const pl of this.world.pellets) {
        const d = dist(c, pl);
        if (d < 400 && d < bestD) { bestD = d; best = pl; }
      }
      if (best) { tx = best.x; ty = best.y; }
      else {
        // vagabonda
        if (now > s.retargetAt) {
          s.wanderTheta = rand(0, Math.PI * 2);
          s.retargetAt = now + rand(500, 2500);
        }
        tx = c.x + Math.cos(s.wanderTheta) * 300;
        ty = c.y + Math.sin(s.wanderTheta) * 300;
      }
    }

    this.setTarget(p, tx, ty);
    this.movePlayer(p, dt);

    // split offensivo occasionale
    if (preys.length && preys[0].d < 200 && p.totalMass > CONFIG.PHYSICS.SPLIT_MASS_THRESHOLD * 3 && Math.random() < 0.02) {
      this.split(p);
    }
  }

  // ==== LOOP ====
  tick() {
    const now = Date.now();
    const dt = (now - this.lastTick) / 1000;
    this.lastTick = now;

    for (const p of this.world.players.values()) {
      if (p.isBot) this.updateBot(p, dt);
      // gli umani si muovono verso p.target (impostato dal client)
      else this.movePlayer(p, dt);
    }

    this.resolveCollisions();
    this.resolvePowerups();
    this.mergeCells();

    // mantieni population di pellet
    while (this.world.pellets.length < CONFIG.WORLD.PELLET_COUNT) this.world.spawnPellet();
  }

  // ==== SNAPSHOT PER I CLIENT ====
  snapshot() {
    const players = [...this.world.players.values()].map((p) => ({
      id: p.id,
      name: p.name,
      isBot: p.isBot,
      color: p.color,
      mass: Math.round(p.totalMass),
      invisible: !!p.invisible && p.invisible > Date.now(),
      speedBoost: !!p.speedBoost && p.speedBoost > Date.now(),
      magnet: !!p.magnet && p.magnet > Date.now(),
      cells: p.cells.map((c) => ({ x: c.x, y: c.y, mass: c.mass, id: c.id })),
    }));
    return {
      players,
      pellets: this.world.pellets,
      powerups: this.world.powerups,
      world: { width: CONFIG.WORLD.WIDTH, height: CONFIG.WORLD.HEIGHT },
    };
  }

  leaderboard() {
    return [...this.world.players.values()]
      .map((p) => ({ id: p.id, name: p.name, mass: Math.round(p.totalMass), isBot: p.isBot }))
      .sort((a, b) => b.mass - a.mass)
      .slice(0, 10);
  }
}

module.exports = { GameServer, CONFIG, cellRadius, rand, clamp, uid };
