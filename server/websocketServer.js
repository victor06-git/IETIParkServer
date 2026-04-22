const WebSocket = require('ws');
const winston = require('winston');
require('dotenv').config();

// ─── Logger ───
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

// ─── Config ───
const SERVER_PORT = process.env.SERVER_PORT;
const players = new Map(); // nickname → ws

// ─── Utils ───
function uniqueNickname(nickname) {
    if (!players.has(nickname)) return nickname;
    let i = 1;
    while (players.has(`${nickname}_${i}`)) i++;
    return `${nickname}_${i}`;
}

function broadcast(data) {
    const json = JSON.stringify(data);
    for (const ws of players.values()) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(json);
        }
    }
}

function broadcastPlayerList() {
    const playerList = Array.from(players.keys()); // SOLO strings
    broadcast({ type: 'PLAYER_LIST', players: playerList });
}

// ─── Heartbeat ───
const HEARTBEAT_INTERVAL = 30000;

// ─── Server ───
async function iniciarServidor() {
    try {
        const wss = new WebSocket.Server({ port: SERVER_PORT });
        logger.info(`Servidor arrancado en puerto ${SERVER_PORT}`);

        const interval = setInterval(() => {
            wss.clients.forEach((ws) => {
                if (ws.isAlive === false) {
                    for (const [nick, client] of players.entries()) {
                        if (client === ws) {
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
            ws.isAlive = true;

            ws.on('pong', () => { ws.isAlive = true; });

            logger.info('Nuevo cliente conectado');

            // Bienvenida
            ws.send(JSON.stringify({ type: 'WELCOME', msg: 'Conexión aceptada' }));

            // Lista actual
            ws.send(JSON.stringify({
                type: 'PLAYER_LIST',
                players: Array.from(players.keys())
            }));

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
                        nickname = uniqueNickname(requested);

                        players.set(nickname, ws);

                        ws.send(JSON.stringify({
                            type: 'JOIN_OK',
                            nickname
                        }));

                        logger.info(`Jugador registrado: ${nickname}`);
                        broadcastPlayerList();
                        break;
                    }

                    case 'MOVE': {
                        if (!nickname) return;

                        const direction = message.direction || "?";

                        broadcast({
                            type: 'MOVE',
                            nickname: nickname,
                            direction: direction
                        });

                        logger.info(`MOVE de ${nickname}: ${direction}`);
                        break;
                    }

                    case 'GET_PLAYERS': {
                        ws.send(JSON.stringify({
                            type: 'PLAYER_LIST',
                            players: Array.from(players.keys())
                        }));
                        break;
                    }

                    case 'LEAVE': {
                        if (nickname && players.has(nickname)) {
                            players.delete(nickname);
                            logger.info(`Jugador salió: ${nickname}`);
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