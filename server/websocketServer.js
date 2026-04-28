const WebSocket = require('ws');
const winston = require('winston');
const { MongoClient, ObjectId } = require('mongodb');
const express = require('express');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const log = winston.createLogger({
  level: process.env.LOG_LEVEL,
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(x => `${x.timestamp} ${x.level}: ${x.message}`)
  ),
  transports: [new winston.transports.Console()]
});

const PORT = Number(process.env.SERVER_PORT);
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017';
const HTTP_PORT = process.env.HTTP_PORT;
const DB_NAME = 'ietipark2';
const MAX_PLAYERS = 8;
const FPS = 30;
const DT = 1 / FPS;
const PING_EACH_MS = 30000;

const map = { width: 320, height: 180, floorY: 176 };

// x/y del jugador representa el centro inferior del gato.
// La hitbox es más grande que antes para que los gatos no se solapen visualmente.
const cat = { w: 26, h: 28, speed: 90, gravity: 900, jump: 310, maxFall: 520 };

// La poción se recoge con una caja pequeña, acorde al tamaño con el que se pinta.
const potion = { x: 181, y: 118, w: 24, h: 24, taken: false, carrierId: null, consumed: false };

// Árbol cerrado. Mientras no esté abierto bloquea el paso.
const tree = { x: 241, y: 90, w: 90, h: 90, open: false, openedAt: 0 };

const goal = {
  unlocked: false,
  allPlayersPassed: false,
  shouldChangeScreen: false,
  crossedAt: 0,
  changeReason: ""
};

// Punto a partir del cual consideramos que un gato ya ha cruzado el árbol.
// Antes de abrirse, el árbol frena al jugador en este borde izquierdo.
const DOOR_CROSS_X = tree.x;

// Obstáculos fijos del mapa.
const solidZones = [
  { name: 'rampa', x: 126, y: 132, w: 112, h: 48 }
];

const spawns = [
  { x: 22, y: 148 }, { x: 50, y: 148 }, { x: 78, y: 148 }, { x: 106, y: 148 },
  { x: 134, y: 148 }, { x: 162, y: 148 }, { x: 190, y: 148 }, { x: 218, y: 148 }
];

const clients = new Map(); // ws -> { id, viewer }
const players = new Map(); // id -> player
let nextId = 1;

// ─── MongoDB ────────────────────────────────────────────────────────────────

let db = null;
let currentPartidaId = null;
const partidaStartTime = { value: null };

async function connectMongo() {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db(DB_NAME);
    log.info(`MongoDB conectado a la base de datos "${DB_NAME}"`);
    await ensureIndexes();
  } catch (err) {
    log.warn(`MongoDB no disponible: ${err.message}. El servidor funciona sin persistencia.`);
    db = null;
  }
}

async function ensureIndexes() {
  if (!db) return;
  try {
    // Índice en jugadores por nickname
    await db.collection('jugadores').createIndex({ nickname: 1 }, { unique: true });
    // Índice en partida_jugador por partidaId + jugadorId
    await db.collection('partida_jugador').createIndex({ partidaId: 1, jugadorId: 1 }, { unique: true });
    log.info('Índices MongoDB verificados');
  } catch (err) {
    log.warn(`Error creando índices: ${err.message}`);
  }
}

/**
 * Obtiene o crea un jugador en la colección "jugadores".
 * Estructura: { _id, nickname, id_categoria }
 * id_categoria por defecto ObjectId de "Junior" si no existe en la colección categorias.
 */
async function upsertJugador(nickname) {
  if (!db) return null;
  try {
    // Busca la categoría por defecto (Junior)
    let categoria = await db.collection('categorias').findOne({ nombre: 'Junior' });
    if (!categoria) {
      // Si no existe ninguna categoría, crea las tres por defecto según el diagrama
      const categorias = [
        { nombre: 'Junior', color: 'Azul' },
        { nombre: 'Senior', color: 'Morado' },
        { nombre: 'Expert', color: 'Dorado' }
      ];
      const result = await db.collection('categorias').insertMany(categorias);
      categoria = { _id: Object.values(result.insertedIds)[0] };
      log.info('Categorías por defecto creadas en MongoDB');
    }

    // Upsert del jugador: si ya existe devuelve el existente, si no lo crea
    const resultado = await db.collection('jugadores').findOneAndUpdate(
      { nickname },
      { $setOnInsert: { nickname, id_categoria: categoria._id } },
      { upsert: true, returnDocument: 'after' }
    );
    return resultado;
  } catch (err) {
    log.warn(`upsertJugador error: ${err.message}`);
    return null;
  }
}

/**
 * Crea una nueva partida en la colección "partidas".
 * Estructura: { _id, fecha, duracion }
 * duracion se rellena al finalizar la partida.
 */
async function iniciarPartida() {
  if (!db) return;
  try {
    const resultado = await db.collection('partidas').insertOne({
      fecha: new Date(),
      duracion: null  // se actualiza al terminar
    });
    currentPartidaId = resultado.insertedId;
    partidaStartTime.value = Date.now();
    log.info(`Partida iniciada en MongoDB con id ${currentPartidaId}`);
  } catch (err) {
    log.warn(`iniciarPartida error: ${err.message}`);
  }
}

/**
 * Registra la entrada de un jugador en la partida actual (partida_jugador).
 * Estructura: { _id, partidaId, jugadorId, pocion_obtenida }
 */
async function registrarJugadorEnPartida(jugadorMongoId) {
  if (!db || !currentPartidaId || !jugadorMongoId) return;
  try {
    await db.collection('partida_jugador').updateOne(
      { partidaId: currentPartidaId, jugadorId: jugadorMongoId },
      { $setOnInsert: { partidaId: currentPartidaId, jugadorId: jugadorMongoId, pocion_obtenida: 0 } },
      { upsert: true }
    );
  } catch (err) {
    log.warn(`registrarJugadorEnPartida error: ${err.message}`);
  }
}

/**
 * Marca pocion_obtenida = 1 para el jugador que recogió la poción.
 */
async function marcarPotionObtenida(jugadorMongoId) {
  if (!db || !currentPartidaId || !jugadorMongoId) return;
  try {
    await db.collection('partida_jugador').updateOne(
      { partidaId: currentPartidaId, jugadorId: jugadorMongoId },
      { $set: { pocion_obtenida: 1 } }
    );
    log.info(`pocion_obtenida marcada para jugador ${jugadorMongoId}`);
  } catch (err) {
    log.warn(`marcarPotionObtenida error: ${err.message}`);
  }
}

/**
 * Finaliza la partida actualizando la duración en segundos.
 */
async function finalizarPartida() {
  if (!db || !currentPartidaId || !partidaStartTime.value) return;
  try {
    const duracion = Math.round((Date.now() - partidaStartTime.value) / 1000);
    await db.collection('partidas').updateOne(
      { _id: currentPartidaId },
      { $set: { duracion } }
    );
    log.info(`Partida ${currentPartidaId} finalizada. Duración: ${duracion}s`);
    currentPartidaId = null;
    partidaStartTime.value = null;
  } catch (err) {
    log.warn(`finalizarPartida error: ${err.message}`);
  }
}

// ─── Fin MongoDB ─────────────────────────────────────────────────────────────

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
  const EPS = 0.001;
  return a.x < b.x + b.w - EPS &&
    a.x + a.w > b.x + EPS &&
    a.y < b.y + b.h - EPS &&
    a.y + a.h > b.y + EPS;
}

function catRect(p, x = p.x, y = p.y) {
  return { x: x - cat.w * 0.5, y: y - cat.h, w: cat.w, h: cat.h };
}

function potionRect() {
  return { x: potion.x - potion.w * 0.5, y: potion.y - potion.h * 0.5, w: potion.w, h: potion.h };
}

function openTreeWithPotion(player) {
  potion.taken = true;
  potion.consumed = true;
  potion.carrierId = null;
  tree.open = true;
  tree.openedAt = Date.now();
  goal.unlocked = true;
  goal.allPlayersPassed = false;
  goal.shouldChangeScreen = false;
  goal.changeReason = "";
  for (const p of players.values()) p.crossedDoor = false;
  log.info(`${player.nickname} cura el arbol con la pocion`);

  // Registrar en MongoDB quién obtuvo la poción
  if (player.mongoId) {
    marcarPotionObtenida(player.mongoId);
  }
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
    crossedDoor: p.crossedDoor === true,
    viewer: false
  }));
}

function worldForClient() {
  return {
    potionTaken: potion.taken,
    potionConsumed: potion.consumed,
    potionCarrierId: potion.carrierId || '',
    potionX: potion.x,
    potionY: potion.y,
    doorOpen: tree.open,
    treeOpening: tree.open && Date.now() - tree.openedAt < 1100,
    doorX: tree.x,
    doorY: tree.y,
    doorWidth: tree.w,
    doorHeight: tree.h,
    levelUnlocked: goal.unlocked,
    allPlayersPassed: goal.allPlayersPassed,
    shouldChangeScreen: goal.shouldChangeScreen,
    crossedPlayers: crossedPlayersForClient(),
    totalPlayers: players.size,
    passedPlayers: countPlayersPastDoor(),
    changeReason: goal.changeReason
  };
}

function crossedPlayersForClient() {
  return [...players.values()].map(p => ({
    id: p.id,
    nickname: p.nickname,
    crossedDoor: p.crossedDoor === true
  }));
}

function countPlayersPastDoor() {
  let total = 0;
  for (const p of players.values()) {
    if (p.crossedDoor === true) total++;
  }
  return total;
}

function updateGoalState() {
  if (!goal.unlocked) {
    goal.allPlayersPassed = false;
    goal.shouldChangeScreen = false;
    return;
  }

  for (const p of players.values()) {
    const playerLeft = p.x - cat.w * 0.5;
    if (!p.crossedDoor && playerLeft >= DOOR_CROSS_X) {
      p.crossedDoor = true;
      log.info(`${p.nickname} ha cruzado el arbol`);
    }
  }

  const hasPlayers = players.size > 0;
  const everyonePassed = hasPlayers && [...players.values()].every(p => p.crossedDoor === true);

  if (everyonePassed && !goal.shouldChangeScreen) {
    goal.allPlayersPassed = true;
    goal.shouldChangeScreen = true;
    goal.crossedAt = Date.now();
    goal.changeReason = "ALL_PLAYERS_CROSSED_TREE";
    log.info("Todos los jugadores han cruzado el arbol. La app ya puede preparar el cambio de pantalla.");

    // Finalizar la partida en MongoDB cuando todos han cruzado
    finalizarPartida();
  } else if (!everyonePassed) {
    goal.allPlayersPassed = false;
    goal.shouldChangeScreen = false;
    goal.changeReason = "";
  }
}

function resetGoalState() {
  goal.unlocked = false;
  goal.allPlayersPassed = false;
  goal.shouldChangeScreen = false;
  goal.crossedAt = 0;
  goal.changeReason = "";
}

function sendPlayerList() {
  broadcast({ type: 'PLAYER_LIST', players: playersForClient(), world: worldForClient() });
}

function sendState() {
  broadcast({ type: 'STATE', players: playersForClient(), world: worldForClient() });
}

function playerBoxes(player) {
  const boxes = [];
  for (const other of players.values()) {
    if (other.id !== player.id) boxes.push({ name: 'player', ...catRect(other) });
  }
  return boxes;
}

function mapBoxes() {
  const boxes = [
    { name: 'left_wall', x: -50, y: -100, w: 50, h: 400 },
    { name: 'right_wall', x: map.width, y: -100, w: 50, h: 400 },
    ...solidZones
  ];
  if (!tree.open) boxes.push({ name: 'tree', x: tree.x, y: tree.y, w: tree.w, h: tree.h });
  return boxes;
}

function collisionBoxes(player) {
  return [...mapBoxes(), ...playerBoxes(player)];
}

function touchesClosedTree(player, rect) {
  return !tree.open && !potion.consumed && potion.carrierId === player.id && rectsTouch(rect, tree);
}

function moveX(player, dx) {
  if (dx === 0) return;

  let nextX = player.x + dx;
  let r = catRect(player, nextX, player.y);

  if (touchesClosedTree(player, r)) openTreeWithPotion(player);

  for (const box of collisionBoxes(player)) {
    if (box.name === 'tree' && tree.open) continue;
    if (!rectsTouch(r, box)) continue;

    if (dx > 0) nextX = box.x - cat.w * 0.5;
    else nextX = box.x + box.w + cat.w * 0.5;

    player.vx = 0;
    r = catRect(player, nextX, player.y);
  }

  player.x = clamp(nextX, cat.w * 0.5, map.width - cat.w * 0.5);
}

function moveY(player, dy) {
  if (dy === 0) return;

  let nextY = player.y + dy;
  let r = catRect(player, player.x, nextY);
  player.grounded = false;

  if (touchesClosedTree(player, r)) openTreeWithPotion(player);

  for (const box of collisionBoxes(player)) {
    if (box.name === 'tree' && tree.open) continue;
    if (!rectsTouch(r, box)) continue;

    if (dy > 0) {
      nextY = box.y;
      player.grounded = true;
    } else {
      nextY = box.y + box.h + cat.h;
    }

    player.vy = 0;
    r = catRect(player, player.x, nextY);
  }

  if (nextY >= map.floorY) {
    nextY = map.floorY;
    player.vy = 0;
    player.grounded = true;
  }

  player.y = clamp(nextY, 0, map.floorY);
}

function isStandingOnSomething(player) {
  if (Math.abs(player.y - map.floorY) <= 0.5) return true;

  const foot = { x: player.x - cat.w * 0.5 + 1, y: player.y, w: cat.w - 2, h: 1.5 };
  for (const box of collisionBoxes(player)) {
    if (box.name === 'tree' && tree.open) continue;
    const top = { x: box.x, y: box.y - 0.5, w: box.w, h: 1.5 };
    if (rectsTouch(foot, top)) return true;
  }
  return false;
}

function updatePlayer(p) {
  const input = p.input || { moveX: 0, jumpPressed: false, jumpHeld: false };

  const move = clamp(Number(input.moveX || 0), -1, 1);
  p.vx = move * cat.speed;
  if (move < 0) p.facingRight = false;
  if (move > 0) p.facingRight = true;

  p.grounded = isStandingOnSomething(p);

  if (input.jumpPressed && p.grounded) {
    p.vy = -cat.jump;
    p.grounded = false;
  }
  input.jumpPressed = false;

  if (!p.grounded) {
    p.vy = Math.min(cat.maxFall, p.vy + cat.gravity * DT);
  }

  moveX(p, p.vx * DT);
  moveY(p, p.vy * DT);

  const r = catRect(p);
  if (!potion.taken && !potion.consumed && rectsTouch(r, potionRect())) {
    potion.taken = true;
    potion.carrierId = p.id;
    log.info(`${p.nickname} coge la pocion`);
  }

  if (!tree.open && potion.carrierId === p.id && rectsTouch(r, tree)) {
    openTreeWithPotion(p);
  }

  p.x = clamp(p.x, cat.w * 0.5, map.width - cat.w * 0.5);
  p.y = clamp(p.y, 0, map.floorY);
  p.anim = !p.grounded ? 'jump' : (Math.abs(p.vx) > 1 ? 'run' : 'idle');
}

function resetWorldIfRoomEmpty() {
  if (players.size === 0) {
    potion.taken = false;
    potion.carrierId = null;
    potion.consumed = false;
    tree.open = false;
    tree.openedAt = 0;
    resetGoalState();
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
      potion.consumed = false;
      tree.open = false;
      tree.openedAt = 0;
      resetGoalState();
    }

    log.info(`${nick} sale (${why})`);
    resetWorldIfRoomEmpty();
    sendPlayerList();
  }
  clients.delete(ws);
}

async function handleJoin(ws, msg, oldClient) {
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
  const nickname = freeNick(msg.nickname);

  // Registrar/obtener jugador en MongoDB
  const jugadorDoc = await upsertJugador(nickname);
  const mongoId = jugadorDoc ? jugadorDoc._id : null;

  // Si es el primer jugador, iniciar partida en MongoDB
  if (players.size === 0) {
    await iniciarPartida();
  }

  const p = {
    id,
    nickname,
    cat: assignedCat,
    x: spawn.x,
    y: spawn.y,
    vx: 0,
    vy: 0,
    grounded: true,
    facingRight: true,
    anim: 'idle',
    crossedDoor: false,
    mongoId,   // referencia al _id de MongoDB para operaciones posteriores
    input: { moveX: 0, jumpPressed: false, jumpHeld: false }
  };

  players.set(id, p);
  clients.set(ws, { id, viewer: false });
  send(ws, { type: 'JOIN_OK', id, nickname: p.nickname, cat: p.cat, viewer: false });

  // Registrar participación en la partida actual
  await registrarJugadorEnPartida(mongoId);

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
    potion.consumed = false;
    tree.open = false;
    tree.openedAt = 0;
    resetGoalState();
    sendPlayerList();
    return;
  }

  send(ws, { type: 'ERROR', msg: `Tipo desconocido: ${msg.type}` });
}

// ─── Arranque ────────────────────────────────────────────────────────────────

connectMongo().then(() => {
  const wss = new WebSocket.Server({ port: PORT });
  log.info(`Servidor escuchando en ${PORT}`);

  setInterval(() => {
    for (const p of players.values()) updatePlayer(p);
    updateGoalState();
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

  // HTTP Server con Express
  const app = express();
  const SERVER_HOST = process.env.SERVER_HOST || 'pico2.ieti.site';

  // Endpoint para servir la web con el QR apuntando a la APK
  app.get('/web', (req, res) => {
    const apkUrl = `https://${SERVER_HOST}/apk`;
    const indexPath = path.join(__dirname, '..', 'web', 'index.html');

    fs.readFile(indexPath, 'utf8', (err, data) => {
      if (err) {
        log.error('Error al leer index.html:', err);
        return res.status(500).send('Error al cargar la web');
      }

      // Reemplazar el URL del QR por el de descarga de la APK
      let html = data.replace(
        /text:\s*"[^"]*"/,
        `text: "${apkUrl}"`
      );

      // Reemplazar el texto mostrado del URL
      html = html.replace(
        /apk\.pico2\.com/,
        apkUrl
      );

      res.send(html);
    });
  });

  // Endpoint para descargar la APK
  app.get('/apk', (req, res) => {
    const apkPath = path.join(__dirname, '..', 'apk', 'android-debug.apk');

    if (!fs.existsSync(apkPath)) {
      log.error('APK no encontrada en:', apkPath);
      return res.status(404).send('APK no encontrada');
    }

    res.download(apkPath, 'drymophylakes.apk');
  });

  // Servir archivos estáticos de la web (imágenes, qrcode.min.js, etc)
  app.use(express.static(path.join(__dirname, '..', 'web')));

  // Iniciar servidor HTTP
  app.listen(HTTP_PORT, () => {
    log.info(`Servidor HTTP escuchando en http://localhost:${HTTP_PORT}`);
    log.info(`Accede a la web con QR en: http://localhost:${HTTP_PORT}/web`);
    log.info(`Descarga APK en: http://localhost:${HTTP_PORT}/apk/download`);
  });

  // HTTP Server con Express
  app = express();
  SERVER_HOST = process.env.SERVER_HOST || 'pico2.ieti.site';

  // Endpoint para servir la web con el QR apuntando a la APK
  app.get('/web', (req, res) => {
    const apkUrl = `https://${SERVER_HOST}/apk`;
    const indexPath = path.join(__dirname, '..', 'web', 'index.html');

    fs.readFile(indexPath, 'utf8', (err, data) => {
      if (err) {
        log.error('Error al leer index.html:', err);
        return res.status(500).send('Error al cargar la web');
      }

      // Reemplazar el URL del QR por el de descarga de la APK
      let html = data.replace(
        /text:\s*"[^"]*"/,
        `text: "${apkUrl}"`
      );

      // Reemplazar el texto mostrado del URL
      html = html.replace(
        /apk\.pico2\.com/,
        apkUrl
      );

      res.send(html);
    });
  });

  // Endpoint para descargar la APK
  app.get('/apk', (req, res) => {
    const apkPath = path.join(__dirname, '..', 'apk', 'android-debug.apk');

    if (!fs.existsSync(apkPath)) {
      log.error('APK no encontrada en:', apkPath);
      return res.status(404).send('APK no encontrada');
    }

    res.download(apkPath, 'drymophylakes.apk');
  });

  // Servir archivos estáticos de la web (imágenes, qrcode.min.js, etc)
  app.use(express.static(path.join(__dirname, '..', 'web')));

  // Iniciar servidor HTTP
  app.listen(HTTP_PORT, () => {
    log.info(`Servidor HTTP escuchando en http://localhost:${HTTP_PORT}`);
    log.info(`Accede a la web con QR en: http://localhost:${HTTP_PORT}/web`);
    log.info(`Descarga APK en: http://localhost:${HTTP_PORT}/apk/download`);
  });
});