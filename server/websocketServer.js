const WebSocket = require('ws');
const winston = require('winston');
const express = require('express');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const mongo = require('./mongo');
const { GameRoom, FPS, isViewer } = require('./gameLogic');

const SERVER_PORT = Number(process.env.SERVER_PORT);
const HTTP_PORT = process.env.HTTP_PORT;
const MONGO_URI = process.env.MONGO_URI;
const SERVER_HOST = process.env.SERVER_HOST;
const PING_EACH_MS = 30000;

const log = winston.createLogger({
  level: 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`)
  ),
  transports: [new winston.transports.Console()]
});

// ws -> { id: string|null, viewer: boolean }
const clients = new Map();

function makeMongoApi() {
  return {
    upsertJugador: nickname => mongo.upsertJugador(nickname, log),
    startMatch: () => mongo.startMatch(log),
    registerPlayerInMatch: playerMongoId => mongo.registerPlayerInMatch(playerMongoId, log),
    markPotionObtained: playerMongoId => mongo.markPotionObtained(playerMongoId, log),
    finishMatch: () => mongo.finishMatch(log)
  };
}

function send(ws, message) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcast(message) {
  const text = JSON.stringify(message);
  for (const ws of clients.keys()) {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(text);
    }
  }
}

function playerListMessage(room) {
  return {
    type: 'PLAYER_LIST',
    players: room.playersForClient(),
    world: room.worldForClient()
  };
}

function stateMessage(room) {
  return {
    type: 'STATE',
    players: room.playersForClient(),
    world: room.worldForClient()
  };
}

function sendPlayerList(room) {
  broadcast(playerListMessage(room));
}

function sendState(room) {
  broadcast(stateMessage(room));
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
  // El menú de Android y flutter_viewer entran como viewer:
  // ven PLAYER_LIST/STATE, pero no ocupan gato ni salen en players[].
  if (isViewer(msg)) {
    clients.set(ws, { id: null, viewer: true });
    send(ws, {
      type: 'JOIN_OK',
      id: '',
      nickname: 'viewer',
      cat: 0,
      viewer: true
    });
    send(ws, playerListMessage(room));
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

function handleInput(ws, msg, room) {
  const client = clients.get(ws);
  if (!client || !client.id) return;
  room.setInput(client.id, msg);
}

function handleMove(ws, msg, room) {
  // Compatibilidad con clientes viejos: la app nueva usa INPUT.
  const client = clients.get(ws);
  if (!client || !client.id) return;
  room.setMoveInput(client.id, msg);
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

  switch (msg.type) {
    case 'JOIN':
      handleJoin(ws, msg, client, room).catch(err => {
        log.warn(`JOIN error: ${err.message}`);
        send(ws, { type: 'ERROR', msg: 'No se ha podido entrar en la sala' });
      });
      break;

    case 'INPUT':
      handleInput(ws, msg, room);
      break;

    case 'MOVE':
      handleMove(ws, msg, room);
      break;

    case 'GET_PLAYERS':
      send(ws, playerListMessage(room));
      break;

    case 'LEAVE':
      removeClient(ws, 'leave', room);
      break;

    case 'RESET_PLAYERS':
      room.resetPlayersAndWorld();
      sendPlayerList(room);
      log.info('Sala reiniciada manualmente');
      break;

    default:
      send(ws, { type: 'ERROR', msg: `Tipo desconocido: ${msg.type}` });
      break;
  }
}

function startWebSocketServer(room) {
  const wss = new WebSocket.Server({ port: SERVER_PORT });
  log.info(`Servidor WebSocket escuchando en ${SERVER_PORT}`);

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
    send(ws, playerListMessage(room));

    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', raw => handleMessage(ws, raw, room));
    ws.on('close', () => removeClient(ws, 'close', room));
    ws.on('error', err => log.warn(`WebSocket error: ${err.message}`));
  });

  wss.on('error', err => {
    log.error(`No se pudo iniciar WebSocket en ${SERVER_PORT}: ${err.message}`);
    process.exitCode = 1;
  });
}

function startHttpServer() {
  if (!HTTP_PORT) return;

  const app = express();
  const webDir = path.join(__dirname, '..', 'web');
  const apkPath = path.join(__dirname, '..', 'apk', 'android-debug.apk');

  app.get('/web', (req, res) => {
    const indexPath = path.join(webDir, 'index.html');
    const apkUrl = `https://${SERVER_HOST}/apk`;

    fs.readFile(indexPath, 'utf8', (err, html) => {
      if (err) {
        log.warn(`No se pudo leer index.html: ${err.message}`);
        res.status(500).send('Error al cargar la web');
        return;
      }

      const updated = html
        .replace(/text:\s*"[^"]*"/, `text: "${apkUrl}"`)
        .replace(/apk\.pico2\.com/g, apkUrl);

      res.send(updated);
    });
  });

  app.get('/apk', (req, res) => {
    if (!fs.existsSync(apkPath)) {
      res.status(404).send('APK no encontrada');
      return;
    }
    res.download(apkPath, 'ieti-park.apk');
  });

  app.use(express.static(webDir));

  const httpServer = app.listen(HTTP_PORT, () => {
    log.info(`Servidor HTTP escuchando en ${HTTP_PORT}`);
  });

  httpServer.on('error', err => {
    log.error(`No se pudo iniciar HTTP en ${HTTP_PORT}: ${err.message}`);
  });
}

async function main() {
  await mongo.connectMongo({ uri: MONGO_URI, log });

  const room = new GameRoom({
    log,
    mongo: makeMongoApi()
  });

  startWebSocketServer(room);
  startHttpServer();
}

main().catch(err => {
  log.error(`Error arrancando servidor: ${err.stack || err.message}`);
  process.exit(1);
});
