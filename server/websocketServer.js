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
const players = new Map(); // nickname → { ws, x, y, cat, direction, flipX }

// ─── Gestión de Gatos ───
const availableCats = ['cat1', 'cat2', 'cat3', 'cat4', 'cat5', 'cat6', 'cat7', 'cat8'];
const catAssignments = new Map(); // catName → nickname

function assignCat(nickname) {
    // Buscar un gato no asignado
    for (const cat of availableCats) {
        if (!catAssignments.has(cat)) {
            catAssignments.set(cat, nickname);
            logger.info(`Gato ${cat} asignado a ${nickname}`);
            return cat;
        }
    }
    logger.warn(`No hay gatos disponibles para ${nickname}`);
    return null; // No hay gatos disponibles
}

function releaseCat(nickname) {
    for (const [cat, nick] of catAssignments.entries()) {
        if (nick === nickname) {
            catAssignments.delete(cat);
            logger.info(`Gato ${cat} liberado de ${nickname}`);
            break;
        }
    }
}

// ─── Utils ───
function uniqueNickname(nickname) {
    if (!players.has(nickname)) return nickname;
    let i = 1;
    while (players.has(`${nickname}_${i}`)) i++;
    const uniqueName = `${nickname}_${i}`;
    logger.info(`Nickname duplicado ${nickname} -> ${uniqueName}`);
    return uniqueName;
}

function broadcast(data) {
    const json = JSON.stringify(data);
    logger.debug(`Broadcast: ${json.substring(0, 200)}${json.length > 200 ? '...' : ''}`);
    for (const { ws } of players.values()) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(json);
        }
    }
}

function broadcastPlayerList() {
    const playerList = Array.from(players.entries()).map(([nickname, data]) => ({
        nickname,
        cat: data.cat || '',
        x: data.x || -1,
        y: data.y || -1,
        direction: data.direction || 'RIGHT'
    }));
    
    const message = { type: 'PLAYER_LIST', players: playerList };
    logger.info(`Broadcast PLAYER_LIST: ${playerList.length} jugadores`);
    broadcast(message);
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
                    // Encontrar y eliminar al jugador
                    for (const [nick, data] of players.entries()) {
                        if (data.ws === ws) {
                            players.delete(nick);
                            releaseCat(nick);  // Liberar el gato
                            logger.info(`Jugador eliminado por timeout: ${nick}`);
                            broadcastPlayerList();
                        }
                    }
                    return ws.terminate();
                }
                ws.isAlive = false;
                ws.ping();
            });
        }, HEARTBEAT_INTERVAL);

        wss.on('close', () => {
            clearInterval(interval);
            logger.info('Servidor cerrado');
        });

        wss.on('connection', (ws) => {
            let nickname = null;
            ws.isAlive = true;

            ws.on('pong', () => { 
                ws.isAlive = true; 
            });

            logger.info('🔌 Nuevo cliente conectado');

            // Bienvenida
            ws.send(JSON.stringify({ 
                type: 'WELCOME', 
                msg: 'Conexión aceptada',
                availableCats: availableCats.filter(cat => !catAssignments.has(cat)).length
            }));

            // Enviar lista actual de jugadores
            ws.send(JSON.stringify({
                type: 'PLAYER_LIST',
                players: Array.from(players.entries()).map(([nickname, data]) => ({
                    nickname,
                    cat: data.cat || '',
                    x: data.x || -1,
                    y: data.y || -1,
                    direction: data.direction || 'RIGHT'
                }))
            }));

            ws.on('message', (data) => {
                let message;
                try {
                    message = JSON.parse(data);
                } catch (err) {
                    logger.error('JSON inválido recibido');
                    return;
                }

                logger.info(`Mensaje recibido: ${JSON.stringify(message)}`);

                switch (message.type) {

                    case 'JOIN': {
                        const requested = message.nickname;
                        nickname = uniqueNickname(requested);
                        
                        // Asignar gato disponible
                        const assignedCat = assignCat(nickname);
                        
                        if (!assignedCat) {
                            logger.warn(`No hay gatos disponibles para ${nickname}`);
                            ws.send(JSON.stringify({
                                type: 'JOIN_ERROR',
                                msg: 'No hay gatos disponibles. Inténtalo más tarde.'
                            }));
                            return;
                        }
                        
                        players.set(nickname, { 
                            ws, 
                            x: -1, 
                            y: -1, 
                            cat: assignedCat,
                            direction: 'RIGHT',
                            flipX: false
                        });
                        
                        ws.send(JSON.stringify({
                            type: 'JOIN_OK',
                            nickname,
                            cat: assignedCat
                        }));
                        
                        logger.info(`Jugador registrado: ${nickname} con gato ${assignedCat}`);
                        broadcastPlayerList();
                        break;
                    }

                    case 'MOVE': {
                        if (!nickname) {
                            logger.warn('MOVE sin JOIN previo');
                            return;
                        }

                        const playerData = players.get(nickname);
                        if (!playerData) {
                            logger.warn(`MOVE de jugador no encontrado: ${nickname}`);
                            return;
                        }

                        const dir   = message.dir   || 'IDLE';
                        const x     = typeof message.x === 'number' ? message.x : playerData.x;
                        const y     = typeof message.y === 'number' ? message.y : playerData.y;
                        const anim  = message.anim  || '';
                        const frame = message.frame || 0;
                        
                        playerData.x = x;
                        playerData.y = y;
                        playerData.direction = dir;
                        playerData.flipX = dir === 'LEFT';
                        
                        broadcast({
                            type: 'MOVE',
                            nickname,
                            cat: playerData.cat,
                            dir,
                            x,
                            y,
                            anim,
                            frame,
                            flipX: playerData.flipX
                        });
                        
                        logger.debug(`MOVE de ${nickname} (${playerData.cat}): dir=${dir} x=${x.toFixed(1)} y=${y.toFixed(1)} anim=${anim}`);
                        break;
                    }

                    case 'GET_PLAYERS': {
                        logger.debug('GET_PLAYERS solicitado');
                        ws.send(JSON.stringify({
                            type: 'PLAYER_LIST',
                            players: Array.from(players.entries()).map(([nickname, data]) => ({
                                nickname,
                                cat: data.cat || '',
                                x: data.x || -1,
                                y: data.y || -1,
                                direction: data.direction || 'RIGHT'
                            }))
                        }));
                        break;
                    }

                    case 'LEAVE': {
                        if (nickname && players.has(nickname)) {
                            players.delete(nickname);
                            releaseCat(nickname);
                            logger.info(`Jugador salió: ${nickname}`);
                            broadcastPlayerList();
                            nickname = null;
                        }
                        break;
                    }

                    case 'RESET_PLAYERS': {
                        // Limpiar todo
                        players.clear();
                        catAssignments.clear();
                        logger.info('Lista de jugadores y gatos reseteada');
                        broadcastPlayerList();
                        break;
                    }

                    case 'PING': {
                        ws.send(JSON.stringify({ type: 'PONG' }));
                        break;
                    }

                    default:
                        logger.warn(`Tipo de mensaje desconocido: ${message.type}`);
                        ws.send(JSON.stringify({ 
                            type: 'ERROR', 
                            msg: `Tipo de mensaje desconocido: ${message.type}` 
                        }));
                        break;
                }
            });

            ws.on('close', () => {
                if (nickname && players.has(nickname)) {
                    players.delete(nickname);
                    releaseCat(nickname);
                    logger.info(`Jugador desconectado: ${nickname}`);
                    broadcastPlayerList();
                } else {
                    logger.info('Cliente desconectado (sin JOIN)');
                }
            });

            ws.on('error', (err) => {
                logger.error(`Error en conexión: ${err.message}`);
            });
        });

    } catch (err) {
        logger.error(`Error fatal al iniciar servidor: ${err.message}`);
        process.exit(1);
    }
}

// ─── Manejo de señales para cierre graceful ───
process.on('SIGINT', () => {
    logger.info('Recibida señal SIGINT. Cerrando servidor...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('Recibida señal SIGTERM. Cerrando servidor...');
    process.exit(0);
});

// ─── Iniciar ───
iniciarServidor();