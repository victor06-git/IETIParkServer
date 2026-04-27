const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

const log = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(x => `${x.timestamp} ${x.level}: ${x.message}`)
  ),
  transports: [new winston.transports.Console()]
});

const PORT = Number(process.env.SERVER_PORT || 3000);
const MAX_PLAYERS = 8;
const FPS = 30;
const DT = 1 / FPS;
const PING_EACH_MS = 30000;

const map = { width: 320, height: 180, floorY: 164 };
const cat = { w: 16, h: 16, speed: 90, gravity: 900, jump: 310, maxFall: 520 };
const potion = { x: 157, y: 160, w: 24, h: 24, taken: false, carrierId: null };
const tree = { x: 262, y: 153, w: 48, h: 80, open: false };

const spawns = [
  { x: 29, y: 148 }, { x: 47, y: 148 }, { x: 65, y: 148 }, { x: 83, y: 148 },
  { x: 101, y: 148 }, { x: 119, y: 148 }, { x: 137, y: 148 }, { x: 155, y: 148 }
];

const clients = new Map(); // ws -> { id, viewer }
const players = new Map(); // id -> jugador real
let nextId = 1;

function cleanNick(value) {
  const nick = String(value || 'Player').trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 16);
  return nick || 'Player';
}

function freeNick(base) {
  const used = new Set([...players.values()].map(p => p.nickname));
  let nick = cleanNick(base);
  if (!used.has(nick)) return nick;
  let i = 1;
  while (used.has(`${nick}_${i}`)) i++;
  return `${nick}_${i}`;
}

function freeCat() {
  const used = new Set([...players.values()].map(p => p.cat));
  for (let i = 1; i <= MAX_PLAYERS; i++) if (!used.has(i)) return i;
  return 1;
}

function isViewer(msg) {
  const txt = String(msg.client || msg.role || '').toLowerCase();
  return msg.viewer === true || txt.includes('viewer') || txt.includes('flutter');
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function round(v) {
  return Math.round(v * 100) / 100;
}

function rectsTouch(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function catRect(p, x = p.x, y = p.y) {
  return { x: x - cat.w * 0.5, y: y - cat.h, w: cat.w, h: cat.h };
}

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg) {
  const text = JSON.stringify(msg);
  for (const ws of clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(text);
  }
}

function playersForClient() {
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
    hasPotion: potion.carrierId === p.id,
    viewer: false
  }));
}

function worldForClient() {
  return {
    potionTaken: potion.taken,
    potionCarrierId: potion.carrierId || '',
    potionX: potion.x,
    potionY: potion.y,
    doorOpen: tree.open,
    doorX: tree.x,
    doorY: tree.y,
    doorWidth: tree.w,
    doorHeight: tree.h
  };
}

function sendPlayerList() {
  broadcast({ type: 'PLAYER_LIST', players: playersForClient(), world: worldForClient() });
}

function sendState() {
  broadcast({ type: 'STATE', players: playersForClient(), world: worldForClient() });
}

function wallBlocks(rect) {
  if (rect.x < 0 || rect.x + rect.w > map.width) return true;
  return !tree.open && rectsTouch(rect, tree);
}

function touchesOther(player, x, y) {
  const r = catRect(player, x, y);
  for (const other of players.values()) {
    if (other.id !== player.id && rectsTouch(r, catRect(other))) return true;
  }
  return false;
}

function canMoveTo(player, x, y) {
  const r = catRect(player, x, y);
  return !wallBlocks(r) && !touchesOther(player, x, y);
}

function findPlayerBelow(player, nextY) {
  if (player.vy <= 0) return null;

  const currentBottom = player.y;
  const nextBottom = nextY;
  let best = null;
  let bestTop = Infinity;

  for (const other of players.values()) {
    if (other.id === player.id) continue;

    const otherTop = other.y - cat.h;
    const horizontalTouch =
      player.x + cat.w * 0.5 > other.x - cat.w * 0.5 &&
      player.x - cat.w * 0.5 < other.x + cat.w * 0.5;

    if (horizontalTouch && currentBottom <= otherTop && nextBottom >= otherTop && otherTop < bestTop) {
      best = other;
      bestTop = otherTop;
    }
  }

  return best ? bestTop : null;
}

function updatePlayer(p) {
  const input = p.input || { moveX: 0, jumpPressed: false, jumpHeld: false };

  const moveX = clamp(Number(input.moveX || 0), -1, 1);
  p.vx = moveX * cat.speed;
  if (moveX < 0) p.facingRight = false;
  if (moveX > 0) p.facingRight = true;

  if (input.jumpPressed && p.grounded) {
    p.vy = -cat.jump;
    p.grounded = false;
  }
  input.jumpPressed = false;

  if (!p.grounded) {
    p.vy = Math.min(cat.maxFall, p.vy + cat.gravity * DT);
  }

  const nextX = p.x + p.vx * DT;
  if (canMoveTo(p, nextX, p.y)) {
    p.x = nextX;
  } else {
    p.vx = 0;
  }

  let nextY = p.y + p.vy * DT;
  const playerTop = findPlayerBelow(p, nextY);

  if (playerTop !== null) {
    p.y = playerTop;
    p.vy = 0;
    p.grounded = true;
  } else if (nextY >= map.floorY) {
    p.y = map.floorY;
    p.vy = 0;
    p.grounded = true;
  } else if (canMoveTo(p, p.x, nextY)) {
    p.y = nextY;
    p.grounded = false;
  } else {
    p.vy = 0;
  }

  const r = catRect(p);
  if (!potion.taken && rectsTouch(r, potion)) {
    potion.taken = true;
    potion.carrierId = p.id;
    tree.open = true; 
    log.info(`${p.nickname} coge la pocion`);
  }

  p.x = clamp(p.x, cat.w * 0.5, map.width - cat.w * 0.5);
  p.y = clamp(p.y, 0, map.floorY);
  p.anim = !p.grounded ? 'jump' : (Math.abs(p.vx) > 1 ? 'run' : 'idle');
}

function resetWorldIfRoomEmpty() {
  if (players.size === 0) {
    potion.taken = false;
    potion.carrierId = null;
    tree.open = false;
  }
}

function removeClient(ws, why) {
  const c = clients.get(ws);
  if (c && c.id && players.has(c.id)) {
    const nick = players.get(c.id).nickname;
    players.delete(c.id);

    if (potion.carrierId === c.id) {
      potion.taken = false;
      potion.carrierId = null;
      tree.open = false;
    }

    log.info(`${nick} sale (${why})`);
    resetWorldIfRoomEmpty();
    sendPlayerList();
  }
  clients.delete(ws);
}

function handleJoin(ws, msg, oldClient) {
  if (isViewer(msg)) {
    clients.set(ws, { id: null, viewer: true });
    send(ws, { type: 'JOIN_OK', id: '', nickname: 'viewer', cat: 0, viewer: true });
    send(ws, { type: 'PLAYER_LIST', players: playersForClient(), world: worldForClient() });
    return;
  }

  if (players.size >= MAX_PLAYERS && !oldClient.id) {
    send(ws, { type: 'ERROR', msg: 'Sala llena' });
    return;
  }

  const id = oldClient.id || `p${nextId++}`;
  const assignedCat = freeCat();
  const spawn = spawns[assignedCat - 1] || spawns[0];

  const p = {
    id,
    nickname: freeNick(msg.nickname),
    cat: assignedCat,
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    grounded: true,
    facingRight: true,
    anim: 'idle',
    input: { moveX: 0, jumpPressed: false, jumpHeld: false }
  };

  players.set(id, p);
  clients.set(ws, { id, viewer: false });
  send(ws, { type: 'JOIN_OK', id, nickname: p.nickname, cat: p.cat, viewer: false });
  sendPlayerList();
  log.info(`${p.nickname} entra como cat${p.cat}`);
}

function handleMessage(ws, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (e) {
    send(ws, { type: 'ERROR', msg: 'JSON invalido' });
    return;
  }

  const client = clients.get(ws) || { id: null, viewer: true };

  if (msg.type === 'JOIN') {
    handleJoin(ws, msg, client);
    return;
  }

  if (msg.type === 'INPUT') {
    if (!client.id || !players.has(client.id)) return;
    const p = players.get(client.id);
    p.input.moveX = clamp(Number(msg.moveX || 0), -1, 1);
    p.input.jumpPressed = Boolean(msg.jumpPressed) || p.input.jumpPressed;
    p.input.jumpHeld = Boolean(msg.jumpHeld);
    return;
  }

  if (msg.type === 'MOVE') {
    if (!client.id || !players.has(client.id)) return;
    const p = players.get(client.id);
    const dir = String(msg.dir || '').toUpperCase();
    p.input.moveX = dir === 'LEFT' ? -1 : (dir === 'RIGHT' ? 1 : 0);
    p.input.jumpPressed = dir === 'JUMP' || Boolean(msg.jumpPressed);
    return;
  }

  if (msg.type === 'GET_PLAYERS') {
    send(ws, { type: 'PLAYER_LIST', players: playersForClient(), world: worldForClient() });
    return;
  }

  if (msg.type === 'LEAVE') {
    removeClient(ws, 'leave');
    return;
  }

  if (msg.type === 'RESET_PLAYERS') {
    players.clear();
    potion.taken = false;
    potion.carrierId = null;
    tree.open = false;
    sendPlayerList();
    return;
  }

  send(ws, { type: 'ERROR', msg: `Tipo desconocido: ${msg.type}` });
}

const wss = new WebSocket.Server({ port: PORT });
log.info(`Servidor escuchando en ${PORT}`);

setInterval(() => {
  for (const p of players.values()) updatePlayer(p);
  sendState();
}, 1000 / FPS);

setInterval(() => {
  wss.clients.forEach(ws => {
    if (ws.isAlive === false) {
      removeClient(ws, 'timeout');
      ws.terminate();
      return;
    }
    ws.isAlive = false;
    ws.ping();
  });
}, PING_EACH_MS);

wss.on('connection', ws => {
  ws.isAlive = true;
  clients.set(ws, { id: null, viewer: true });

  send(ws, { type: 'WELCOME', msg: 'ok', world: worldForClient() });
  send(ws, { type: 'PLAYER_LIST', players: playersForClient(), world: worldForClient() });

  ws.on('pong', () => { ws.isAlive = true; });
  ws.on('message', raw => handleMessage(ws, raw));
  ws.on('close', () => removeClient(ws, 'close'));
  ws.on('error', err => log.warn(err.message));
});
