const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

const SERVER_PORT = Number(process.env.SERVER_PORT || 3000);
const MAX_PLAYERS = 8;
const TICK_HZ = 30;
const DT = 1 / TICK_HZ;
const HEARTBEAT_INTERVAL = 30000;

const WORLD = { width: 320, height: 180, floorY: 164 };
const CAT = { width: 16, height: 16, speed: 90, gravity: 900, jump: 310, maxFall: 520 };
const POTION = { x: 157, y: 160, width: 24, height: 24, taken: false };
const DOOR = { x: 262, y: 153, width: 48, height: 80, open: false }; // arbol/puerta
const SPAWNS = [
  { x: 29, y: 148 }, { x: 47, y: 148 }, { x: 65, y: 148 }, { x: 83, y: 148 },
  { x: 101, y: 148 }, { x: 119, y: 148 }, { x: 137, y: 148 }, { x: 155, y: 148 }
];

const clients = new Map(); // ws -> client
const players = new Map(); // id -> player, excludes flutter viewers
let nextId = 1;

function sanitizeNickname(value) {
  const clean = String(value || 'Player').trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 16);
  return clean || 'Player';
}

function uniqueNickname(base) {
  let nick = sanitizeNickname(base);
  const used = new Set([...players.values()].map(p => p.nickname));
  if (!used.has(nick)) return nick;
  let i = 1;
  while (used.has(`${nick}_${i}`)) i += 1;
  return `${nick}_${i}`;
}

function nextFreeCat() {
  const used = new Set([...players.values()].map(p => p.cat));
  for (let cat = 1; cat <= MAX_PLAYERS; cat += 1) if (!used.has(cat)) return cat;
  return 1;
}

function isViewerJoin(message) {
  const client = String(message.client || message.role || '').toLowerCase();
  return client.includes('flutter') || client.includes('viewer') || message.viewer === true;
}

function send(ws, data) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcast(data) {
  const json = JSON.stringify(data);
  for (const ws of clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  }
}

function publicPlayers() {
  return [...players.values()].map(p => ({
    id: p.id,
    nickname: p.nickname,
    cat: p.cat,
    x: round(p.x),
    y: round(p.y),
    vx: round(p.vx),
    vy: round(p.vy),
    anim: p.anim,
    facingRight: p.facingRight,
    grounded: p.grounded,
    viewer: false
  }));
}

function publicWorld() {
  return {
    potionTaken: POTION.taken,
    doorOpen: DOOR.open,
    potionX: POTION.x,
    potionY: POTION.y,
    doorX: DOOR.x,
    doorY: DOOR.y,
    doorWidth: DOOR.width,
    doorHeight: DOOR.height
  };
}

function broadcastState() {
  broadcast({ type: 'STATE', players: publicPlayers(), world: publicWorld() });
}

function broadcastPlayerList() {
  broadcast({ type: 'PLAYER_LIST', players: publicPlayers(), world: publicWorld() });
}

function rectsOverlap(a, b) {
  return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

function playerRect(p, x = p.x, y = p.y) {
  return { x: x - CAT.width * 0.5, y: y - CAT.height, width: CAT.width, height: CAT.height };
}

function round(n) { return Math.round(n * 100) / 100; }
function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

function canOccupy(player, nextX, nextY) {
  const r = playerRect(player, nextX, nextY);
  if (r.x < 0 || r.x + r.width > WORLD.width) return false;
  if (!DOOR.open && rectsOverlap(r, DOOR)) return false;
  for (const other of players.values()) {
    if (other.id === player.id) continue;
    if (rectsOverlap(r, playerRect(other))) return false;
  }
  return true;
}

function simulatePlayer(p) {
  const input = p.input || { moveX: 0, jumpPressed: false, jumpHeld: false };
  const moveX = clamp(Number(input.moveX || 0), -1, 1);
  p.vx = moveX * CAT.speed;
  if (moveX < 0) p.facingRight = false;
  if (moveX > 0) p.facingRight = true;

  if (input.jumpPressed && p.grounded) {
    p.vy = -CAT.jump;
    p.grounded = false;
  }
  input.jumpPressed = false;

  if (!p.grounded) p.vy = Math.min(CAT.maxFall, p.vy + CAT.gravity * DT);

  const nextX = p.x + p.vx * DT;
  if (canOccupy(p, nextX, p.y)) p.x = nextX;
  else p.vx = 0;

  let nextY = p.y + p.vy * DT;
  if (nextY >= WORLD.floorY) {
    nextY = WORLD.floorY;
    p.vy = 0;
    p.grounded = true;
  } else {
    p.grounded = false;
  }
  if (canOccupy(p, p.x, nextY)) p.y = nextY;
  else p.vy = 0;

  const r = playerRect(p);
  if (!POTION.taken && rectsOverlap(r, POTION)) {
    POTION.taken = true;
    DOOR.open = true; // la pocion abre/elimina el arbol-puerta
    logger.info(`${p.nickname} ha recogido la pocion. Puerta/arbol abierto.`);
  }

  p.x = clamp(p.x, CAT.width * 0.5, WORLD.width - CAT.width * 0.5);
  p.y = clamp(p.y, 0, WORLD.floorY);
  p.anim = !p.grounded ? 'jump' : (Math.abs(p.vx) > 1 ? 'run' : 'idle');
}

function resetWorldIfEmpty() {
  if (players.size === 0) {
    POTION.taken = false;
    DOOR.open = false;
  }
}

function tick() {
  for (const p of players.values()) simulatePlayer(p);
  broadcastState();
}

const wss = new WebSocket.Server({ port: SERVER_PORT });
logger.info(`Servidor WebSocket iniciado en puerto ${SERVER_PORT}`);

const heartbeat = setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      removeClient(ws, 'timeout');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, HEARTBEAT_INTERVAL);

const gameLoop = setInterval(tick, 1000 / TICK_HZ);
wss.on('close', () => { clearInterval(heartbeat); clearInterval(gameLoop); });

wss.on('connection', ws => {
  ws.isAlive = true;
  clients.set(ws, { id: null, viewer: true });
  send(ws, { type: 'WELCOME', msg: 'Conexion aceptada', world: publicWorld() });
  send(ws, { type: 'PLAYER_LIST', players: publicPlayers(), world: publicWorld() });

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => handleMessage(ws, raw));
  ws.on('close', () => removeClient(ws, 'close'));
  ws.on('error', err => logger.warn(`Error WebSocket: ${err.message}`));
});

function handleMessage(ws, raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return send(ws, { type: 'ERROR', msg: 'JSON invalido' }); }
  const client = clients.get(ws) || { id: null, viewer: true };

  switch (msg.type) {
    case 'JOIN': {
      const viewer = isViewerJoin(msg);
      if (viewer) {
        clients.set(ws, { id: null, viewer: true });
        send(ws, { type: 'JOIN_OK', id: '', nickname: 'viewer', cat: 0, viewer: true });
        return;
      }
      if (players.size >= MAX_PLAYERS && !client.id) return send(ws, { type: 'ERROR', msg: 'Sala llena: maximo 8 jugadores' });
      const id = client.id || `p${nextId++}`;
      const nick = uniqueNickname(msg.nickname);
      const cat = nextFreeCat();
      const spawn = SPAWNS[cat - 1] || SPAWNS[0];
      const p = { id, nickname: nick, cat, x: spawn.x, y: spawn.y, vx: 0, vy: 0, grounded: true, facingRight: true, anim: 'idle', input: { moveX: 0, jumpPressed: false, jumpHeld: false } };
      players.set(id, p);
      clients.set(ws, { id, viewer: false });
      send(ws, { type: 'JOIN_OK', id, nickname: nick, cat, viewer: false });
      broadcastPlayerList();
      break;
    }
    case 'INPUT': {
      if (!client.id || !players.has(client.id)) return;
      const p = players.get(client.id);
      p.input.moveX = clamp(Number(msg.moveX || 0), -1, 1);
      p.input.jumpPressed = Boolean(msg.jumpPressed) || p.input.jumpPressed;
      p.input.jumpHeld = Boolean(msg.jumpHeld);
      break;
    }
    case 'MOVE': { // compatibilidad con clientes antiguos: se convierte en INPUT aproximado
      if (!client.id || !players.has(client.id)) return;
      const p = players.get(client.id);
      const dir = String(msg.dir || '').toUpperCase();
      p.input.moveX = dir === 'LEFT' ? -1 : (dir === 'RIGHT' ? 1 : 0);
      p.input.jumpPressed = dir === 'JUMP' || Boolean(msg.jumpPressed);
      break;
    }
    case 'GET_PLAYERS':
      send(ws, { type: 'PLAYER_LIST', players: publicPlayers(), world: publicWorld() });
      break;
    case 'LEAVE':
      removeClient(ws, 'leave');
      break;
    case 'RESET_PLAYERS':
      players.clear(); POTION.taken = false; DOOR.open = false; broadcastPlayerList();
      break;
    default:
      send(ws, { type: 'ERROR', msg: `Tipo desconocido: ${msg.type}` });
  }
}

function removeClient(ws, reason) {
  const client = clients.get(ws);
  if (client && client.id && players.has(client.id)) {
    const nick = players.get(client.id).nickname;
    players.delete(client.id);
    logger.info(`Jugador desconectado (${reason}): ${nick}`);
    resetWorldIfEmpty();
    broadcastPlayerList();
  }
  clients.delete(ws);
}
