const WebSocket = require('ws');
const winston = require('winston');
const express = require('express');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const mongo = require('./mongo');
const { GameRoom, MAX_PLAYERS, FPS, isViewer } = require('./gameLogic');

const log = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(x => `${x.timestamp} ${x.level}: ${x.message}`)
  ),
  transports: [new winston.transports.Console()]
});

const WS_PORT = Number(process.env.SERVER_PORT || 3000);
const HTTP_PORT = Number(process.env.HTTP_PORT || 3005);
const MONGO_URI = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017';
const SERVER_HOST = process.env.SERVER_HOST || 'pico2.ieti.site';
const PING_EACH_MS = 30000;

const clients = new Map(); // ws -> { id, viewer }

function send(ws, msg) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

function broadcast(msg) {
  const text = JSON.stringify(msg);
  for (const ws of clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) ws.send(text);
  }
}

function sendPlayerList(room) {
  broadcast({
    type: 'PLAYER_LIST',
    players: room.playersForClient(),
    world: room.worldForClient()
  });
}

function sendState(room) {
  broadcast({
    type: 'STATE',
    players: room.playersForClient(),
    world: room.worldForClient()
  });
}

function removeClient(ws, reason, room) {
  const client = clients.get(ws);
  if (client && client.id) {
    const removed = room.removePlayer(client.id, reason);
    if (removed) sendPlayerList(room);
  }
  clients.delete(ws);
}

async function handleJoin(ws, msg, client, room) {
  if (isViewer(msg)) {
    clients.set(ws, { id: null, viewer: true });
    send(ws, { type: 'JOIN_OK', id: '', nickname: 'viewer', cat: 0, viewer: true });
    send(ws, { type: 'PLAYER_LIST', players: room.playersForClient(), world: room.worldForClient() });
    return;
  }

  if (room.isFull() && !client.id) {
    send(ws, { type: 'ERROR', msg: 'Sala llena' });
    return;
  }

  const player = await room.addPlayer(msg, client.id);
  clients.set(ws, { id: player.id, viewer: false });

  send(ws, {
    type: 'JOIN_OK',
    id: player.id,
    nickname: player.nickname,
    cat: player.cat,
    viewer: false
  });

  sendPlayerList(room);
}

function handleMessage(ws, raw, room) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch (err) {
    send(ws, { type: 'ERROR', msg: 'JSON invalido' });
    return;
  }

  const client = clients.get(ws) || { id: null, viewer: true };

  if (msg.type === 'JOIN') {
    handleJoin(ws, msg, client, room).catch(err => {
      log.warn(`JOIN error: ${err.message}`);
      send(ws, { type: 'ERROR', msg: 'No se ha podido entrar en la sala' });
    });
    return;
  }

  if (msg.type === 'INPUT') {
    if (client.id) room.setInput(client.id, msg);
    return;
  }

  if (msg.type === 'MOVE') {
    if (client.id) room.setMoveInput(client.id, msg);
    return;
  }

  if (msg.type === 'GET_PLAYERS') {
    send(ws, { type: 'PLAYER_LIST', players: room.playersForClient(), world: room.worldForClient() });
    return;
  }

  if (msg.type === 'LEAVE') {
    removeClient(ws, 'leave', room);
    return;
  }

  if (msg.type === 'RESET_PLAYERS') {
    room.resetPlayersAndWorld();
    sendPlayerList(room);
    return;
  }

  send(ws, { type: 'ERROR', msg: `Tipo desconocido: ${msg.type}` });
}

function startWebSocketServer(room) {
  const wss = new WebSocket.Server({ port: WS_PORT });
  log.info(`Servidor WebSocket escuchando en ${WS_PORT}`);

  setInterval(() => {
    room.tick();
    sendState(room);
  }, 1000 / FPS);

  setInterval(() => {
    wss.clients.forEach(ws => {
      if (ws.isAlive === false) {
        removeClient(ws, 'timeout', room);
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

    send(ws, { type: 'WELCOME', msg: 'ok', world: room.worldForClient() });
    send(ws, { type: 'PLAYER_LIST', players: room.playersForClient(), world: room.worldForClient() });

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', raw => handleMessage(ws, raw, room));
    ws.on('close', () => removeClient(ws, 'close', room));
    ws.on('error', err => log.warn(err.message));
  });
}

function startHttpServer() {
  const app = express();

  app.get('/web', (req, res) => {
    const apkUrl = `https://${SERVER_HOST}/apk`;
    const indexPath = path.join(__dirname, '..', 'web', 'index.html');

    fs.readFile(indexPath, 'utf8', (err, data) => {
      if (err) {
        log.error(`Error al leer index.html: ${err.message}`);
        return res.status(500).send('Error al cargar la web');
      }

      let html = data.replace(/text:\s*"[^"]*"/, `text: "${apkUrl}"`);
      html = html.replace(/apk\.pico2\.com/g, apkUrl);
      res.send(html);
    });
  });

  app.get('/apk', (req, res) => {
    const apkPath = path.join(__dirname, '..', 'apk', 'android-debug.apk');

    if (!fs.existsSync(apkPath)) {
      log.error(`APK no encontrada en: ${apkPath}`);
      return res.status(404).send('APK no encontrada');
    }

    res.download(apkPath, 'drymophylakes.apk');
  });

  app.use(express.static(path.join(__dirname, '..', 'web')));

  // Importante: solo hay un app.listen. Esto arregla el EADDRINUSE provocado por arrancarlo dos veces.
  const httpServer = app.listen(HTTP_PORT, () => {
    log.info(`Servidor HTTP escuchando en http://localhost:${HTTP_PORT}`);
    log.info(`Web con QR: http://localhost:${HTTP_PORT}/web`);
    log.info(`APK: http://localhost:${HTTP_PORT}/apk`);
  });

  httpServer.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      log.error(`El puerto HTTP ${HTTP_PORT} ya está en uso. Cierra el proceso anterior o cambia HTTP_PORT en .env.`);
    } else {
      log.error(`Error HTTP: ${err.message}`);
    }
    process.exit(1);
  });
}

async function main() {
  await mongo.connectMongo({ uri: MONGO_URI, log });

  const room = new GameRoom({
    log,
    mongo: {
      upsertJugador: nickname => mongo.upsertJugador(nickname, log),
      startMatch: () => mongo.startMatch(log),
      registerPlayerInMatch: id => mongo.registerPlayerInMatch(id, log),
      markPotionObtained: id => mongo.markPotionObtained(id, log),
      finishMatch: () => mongo.finishMatch(log)
    }
  });

  startWebSocketServer(room);
  startHttpServer();
}

main().catch(err => {
  log.error(err.stack || err.message);
  process.exit(1);
});