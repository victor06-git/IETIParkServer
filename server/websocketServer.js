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
const players = new Map();

function uniqueNickname(nickname) {
    if (!players.has(nickname)) return nickname;
    let i = 1;
    while (players.has(`${nickname}_${i}`)) i++; // evitamos nicknames duplicados laura - laura_1
    return `${nickname}_${i}`;
}

function broadcast(data) { // mensaje para todos
    const json = JSON.stringify(data);
    for (const ws of players.values()) {
        if (ws.readyState === WebSocket.OPEN) 
            ws.send(json);
    }
}

function broadcastPlayerList() {
    broadcast({ type: 'PLAYER_LIST', players: Array.from(players.keys()) }); // envía la lista de jugadores activos a todos
}

async function iniciarServidor() {
    try {
        const wss = new WebSocket.Server({ port: SERVER_PORT });
        logger.info(`Servidor arrancado en puerto ${SERVER_PORT}`);

        wss.on('connection', (ws) => {
            let nickname = null;
            logger.info('Nuevo cliente conectado');

            ws.send(JSON.stringify({ type: 'WELCOME', msg: 'Conexión aceptada' }));
            ws.send(JSON.stringify({ type: 'listPlayersWelcome', msg: broadcastPlayerList()}));

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

                        // confirmar al cliente su nick definitivo
                        ws.send(JSON.stringify({ type: 'JOIN_OK', nickname }));
                        logger.info(`Jugador registrado: ${nickname}`);

                        broadcastPlayerList(); // notificar a todos la lista actualizada, revisar que la lista salga sin 
                        break;
                    }

                    case 'MOVE': {
                        const validDirections = ['UP', 'LEFT', 'RIGHT'];
                        if (!validDirections.includes(message.direction)) {
                            logger.warn(`Dirección inválida: ${message.direction}`);
                            return;
                        }

                        const moveMsg = { // reenviar el movimiento a todos los demás
                            type: 'MOVE',
                            nickname: nickname || '?',
                            direction: message.direction,
                            timestamp: message.timestamp,
                        };

                        broadcast(moveMsg);
                        logger.info(`MOVE de ${nickname}: ${message.direction}`);
                        break;
                    }

                    case 'GET_PLAYERS' : {
                        ws.send(JSON.stringify({
                            type: 'PLAYER_LIST',  // responder al que pida 
                            players: Array.from(players.keys()),
                        }));
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