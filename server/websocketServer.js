const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

// logger
const logger = winston.createLogger({
    level: 'debug',
    format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.printf(({ timestamp, level, message }) => `${timestamp} ${level}: ${message}`)
    ),
    transports: [
        new winston.transports.Console(),
        new winston.transports.File({ filename: './data/logs/server.log' })
    ],
});

// config + var
const SERVER_PORT = process.env.SERVER_PORT;
const players = new Map(); // nickname → { ws, cat, x, y, anim, frame, dir }

function uniqueNickname(nickname) {
    if (!players.has(nickname)) return nickname;
    let i = 1;
    while (players.has(`${nickname}_${i}`)) i++;
    return `${nickname}_${i}`;
}

function broadcast(data) {
    const json = JSON.stringify(data);
    for (const data of players.values()) {
        if (data.ws.readyState === WebSocket.OPEN)
            data.ws.send(json);
    }
}

function broadcastPlayerList() {
    const playerList = Array.from(players.entries()).map(([nick, data]) => ({
        nickname: nick,
        cat: data.cat
    }));
    broadcast({ type: 'PLAYER_LIST', players: playerList });
}

const HEARTBEAT_INTERVAL = 30000; // 30 segundos

async function iniciarServidor() {
    try {
        const wss = new WebSocket.Server({ port: SERVER_PORT });
        logger.info(`Servidor arrancado en puerto ${SERVER_PORT}`);

        // Heartbeat para detectar conexiones muertas
        const interval = setInterval(() => {
            wss.clients.forEach((ws) => {
                if (ws.isAlive === false) {
                    for (const [nick, data] of players.entries()) {
                        if (data.ws === ws) {
                            players.delete(nick);
                            logger.info(`Jugador eliminado por timeout: ${nick}`);
                        }
                    }
                    broadcastPlayerList();
                    return ws.terminate();
                }
                ws.isAlive = false;
                ws.ping();
            });
        }, HEARTBEAT_INTERVAL);

        wss.on('close', () => clearInterval(interval));

        wss.on('connection', (ws) => {
            let nickname = null;
            logger.info('Nuevo cliente conectado');

            // Heartbeat: marcar como vivo al conectar
            ws.isAlive = true;
            ws.on('pong', () => { ws.isAlive = true; });

            ws.send(JSON.stringify({ type: 'WELCOME', msg: 'Conexión aceptada' }));

            // Enviar lista actual de jugadores al nuevo cliente
            const playerList = Array.from(players.entries()).map(([nick, data]) => ({
                nickname: nick,
                cat: data.cat
            }));
            ws.send(JSON.stringify({ type: 'PLAYER_LIST', players: playerList }));

            ws.on('message', (data) => {
                let message;
                try {
                    message = JSON.parse(data);
                } catch (err) {
                    logger.error('JSON inválido');
                    return;
                }

                logger.info(`Mensaje recibido: ${JSON.stringify(message)}`);

                switch (message.type) {

                    case 'JOIN': {
                        const requested = message.nickname;
                        const cat = message.cat || null;
                        nickname = uniqueNickname(requested);

                        players.set(nickname, {
                            ws,
                            cat,
                            x: 0, y: 0, anim: '', frame: 0, dir: 'RIGHT'
                        });

                        const savedData = players.get(nickname);
                        ws.send(JSON.stringify({ type: 'JOIN_OK', nickname, cat: savedData.cat }));
                        logger.info(`Jugador registrado: ${nickname} con gato: ${cat}`);

                        broadcastPlayerList();
                        break;
                    }

                    case 'MOVE': {
                        const playerData = players.get(nickname);
                        if (!playerData) return;

                        playerData.x     = message.x     ?? playerData.x;
                        playerData.y     = message.y     ?? playerData.y;
                        playerData.anim  = message.anim  ?? playerData.anim;
                        playerData.frame = message.frame ?? playerData.frame;
                        playerData.dir   = message.dir   ?? playerData.dir;

                        const moveMsg = {
                            type:     'MOVE',
                            nickname: nickname,
                            cat:      playerData.cat,
                            x:        playerData.x,
                            y:        playerData.y,
                            anim:     playerData.anim,
                            frame:    playerData.frame,
                            dir:      playerData.dir,
                        };

                        broadcast(moveMsg);
                        logger.info(`MOVE de ${nickname}: dir=${playerData.dir} x=${playerData.x} y=${playerData.y}`);
                        break;
                    }

                    case 'GET_PLAYERS': {
                        const playerList = Array.from(players.entries()).map(([nick, data]) => ({
                            nickname: nick,
                            cat: data.cat
                        }));
                        ws.send(JSON.stringify({
                            type: 'PLAYER_LIST',
                            players: playerList
                        }));
                        break;
                    }

                    case 'LEAVE': {
                        if (nickname && players.has(nickname)) {
                            players.delete(nickname);
                            logger.info(`Jugador salió voluntariamente: ${nickname}`);
                            broadcastPlayerList();
                            nickname = null;
                        }
                        break;
                    }

                    case 'RESET_PLAYERS': {
                        players.clear();
                        logger.info('Lista de jugadores reseteada');
                        broadcastPlayerList();
                        break;
                    }

                    default:
                        logger.warn(`Tipo desconocido: ${message.type}`);
                        break;
                }
            });

            ws.on('close', () => {
                if (nickname && players.has(nickname)) {
                    players.delete(nickname);
                    logger.info(`Jugador desconectado: ${nickname}`);
                    broadcastPlayerList();
                } else {
                    logger.info('Cliente desconectado (sin JOIN)');
                }
            });

            ws.on('error', (err) => {
                logger.error(`Error en conexión: ${err}`);
            });
        });

    } catch (err) {
        logger.error(`Error al iniciar servidor: ${err.message}`);
    }
}

iniciarServidor();