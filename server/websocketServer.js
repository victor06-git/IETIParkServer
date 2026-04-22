const WebSocket = require('ws');
const winston = require('winston');
const fs = require('fs');
const path = require('path');
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
const TICK_RATE = 60;                   // simulación a 60 Hz
const TICK_MS = 1000 / TICK_RATE;
const BROADCAST_RATE = 20;              // broadcast a 20 Hz
const BROADCAST_MS = 1000 / BROADCAST_RATE;
const HEARTBEAT_INTERVAL = 30000;

// ─── Física ───
const MOVE_SPEED    = 150;   // px/s
const GRAVITY       = 2088;  // px/s²
const JUMP_IMPULSE  = 708;   // px/s
const MAX_FALL      = 840;   // px/s
const PLAYER_W      = 16;    // hitbox ancho
const PLAYER_H      = 16;    // hitbox alto
const FLOOR_EPSILON = 2;     // tolerancia suelo

// ─── Nivel: zonas ───
let zones = { floors: [], walls: [], doors: [] };

function loadZones() {
    try {
        const zonesPath = path.join(__dirname, '..', 'ietiparkflutter', 'assets', 'levels', 'zones', 'level_000_zones.json');
        const data = JSON.parse(fs.readFileSync(zonesPath, 'utf8'));
        zones = { floors: [], walls: [], doors: [] };

        for (const z of (data.zones || [])) {
            const type = (z.type || '').toLowerCase();
            const name = (z.name || '').toLowerCase();
            const rect = { x: z.x, y: z.y, w: z.width, h: z.height };

            if (type === 'floor' || name.includes('floor')) {
                zones.floors.push(rect);
            } else if (type === 'mur' || name.includes('mur') || name.includes('wall')) {
                zones.walls.push(rect);
            } else if (type === 'door' || name.includes('door') || name.includes('puerta')) {
                zones.doors.push({ ...rect, open: false });
            }
        }
        logger.info(`Zonas cargadas: ${zones.floors.length} floors, ${zones.walls.length} walls, ${zones.doors.length} doors`);
    } catch (err) {
        logger.error(`Error cargando zonas: ${err.message}`);
        // Fallback mínimo
        zones.floors = [{ x: 350, y: 398, w: 1000, h: 20 }];
        zones.walls = [
            { x: 310, y: 0, w: 50, h: 410 },
            { x: 1306, y: -3, w: 50, h: 410 }
        ];
    }
}

// ─── Jugadores ───
const players = new Map(); // nickname → PlayerState

class PlayerState {
    constructor(ws, cat, spawnX, spawnY) {
        this.ws = ws;
        this.cat = cat;
        this.x = spawnX;
        this.y = spawnY;
        this.vx = 0;
        this.vy = 0;
        this.onGround = false;
        this.dir = 'RIGHT';
        this.anim = 'idle';
        this.frame = 0;
        this.inputDir = 'IDLE';   // último input recibido
        this.wantJump = false;
    }
}

const SPAWN_X = 160;
const SPAWN_Y = 170;

// ─── Colisiones ───
function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function playerRect(p) {
    return { x: p.x - PLAYER_W * 0.5, y: p.y - PLAYER_H * 0.5, w: PLAYER_W, h: PLAYER_H };
}

function isOnFloor(p) {
    const pr = playerRect(p);
    const bottom = pr.y + pr.h;
    for (const f of zones.floors) {
        const hOverlap = pr.x + pr.w > f.x && pr.x < f.x + f.w;
        if (hOverlap && Math.abs(bottom - f.y) <= FLOOR_EPSILON) return true;
    }
    return false;
}

function collidesWall(px, py) {
    const pr = { x: px - PLAYER_W * 0.5, y: py - PLAYER_H * 0.5, w: PLAYER_W, h: PLAYER_H };
    for (const w of zones.walls) {
        if (rectsOverlap(pr.x, pr.y, pr.w, pr.h, w.x, w.y, w.w, w.h)) return true;
    }
    // Puertas cerradas actúan como paredes
    for (const d of zones.doors) {
        if (!d.open && rectsOverlap(pr.x, pr.y, pr.w, pr.h, d.x, d.y, d.w, d.h)) return true;
    }
    return false;
}

function collidesOtherPlayer(nickname, px, py) {
    const pr = { x: px - PLAYER_W * 0.5, y: py - PLAYER_H * 0.5, w: PLAYER_W, h: PLAYER_H };
    for (const [nick, other] of players) {
        if (nick === nickname) continue;
        const or = playerRect(other);
        if (rectsOverlap(pr.x, pr.y, pr.w, pr.h, or.x, or.y, or.w, or.h)) return true;
    }
    return false;
}

function resolveFloorCollision(p) {
    const pr = playerRect(p);
    const bottom = pr.y + pr.h;
    for (const f of zones.floors) {
        const hOverlap = pr.x + pr.w > f.x && pr.x < f.x + f.w;
        if (hOverlap && bottom > f.y && bottom < f.y + f.h + FLOOR_EPSILON) {
            p.y = f.y - PLAYER_H * 0.5;
            p.vy = 0;
            p.onGround = true;
            return true;
        }
    }
    return false;
}

// ─── Simulación ───
function simulate(dt) {
    for (const [nickname, p] of players) {
        // Input → velocidad horizontal
        if (p.inputDir === 'LEFT') {
            p.vx = -MOVE_SPEED;
            p.dir = 'LEFT';
        } else if (p.inputDir === 'RIGHT') {
            p.vx = MOVE_SPEED;
            p.dir = 'RIGHT';
        } else {
            p.vx = 0;
        }

        // Salto
        if (p.wantJump && p.onGround) {
            p.vy = -JUMP_IMPULSE;
            p.onGround = false;
            p.wantJump = false;
        }

        // Gravedad
        if (!p.onGround) {
            p.vy += GRAVITY * dt;
            if (p.vy > MAX_FALL) p.vy = MAX_FALL;
        }

        // Movimiento horizontal con colisiones
        const nextX = p.x + p.vx * dt;
        if (!collidesWall(nextX, p.y) && !collidesOtherPlayer(nickname, nextX, p.y)) {
            p.x = nextX;
        } else {
            p.vx = 0;
        }

        // Movimiento vertical con colisiones
        const nextY = p.y + p.vy * dt;
        if (!collidesWall(p.x, nextY) && !collidesOtherPlayer(nickname, p.x, nextY)) {
            p.y = nextY;
            p.onGround = false;
        }

        // Resolver suelo
        resolveFloorCollision(p);
        if (!p.onGround) {
            p.onGround = isOnFloor(p);
            if (p.onGround) p.vy = 0;
        }

        // Animación server-side
        if (!p.onGround) {
            p.anim = 'jump';
        } else if (Math.abs(p.vx) > 1) {
            p.anim = 'run';
        } else {
            p.anim = 'idle';
        }
    }
}

// ─── Networking ───
function uniqueNickname(nickname) {
    if (!players.has(nickname)) return nickname;
    let i = 1;
    while (players.has(`${nickname}_${i}`)) i++;
    return `${nickname}_${i}`;
}

function broadcast(data) {
    const json = JSON.stringify(data);
    for (const p of players.values()) {
        if (p.ws.readyState === WebSocket.OPEN) p.ws.send(json);
    }
}

function broadcastPlayerList() {
    const playerList = Array.from(players.entries()).map(([nick, p]) => ({
        nickname: nick, cat: p.cat
    }));
    broadcast({ type: 'PLAYER_LIST', players: playerList });
}

function broadcastState() {
    for (const [nickname, p] of players) {
        broadcast({
            type: 'MOVE',
            nickname,
            cat: p.cat,
            x: Math.round(p.x),
            y: Math.round(p.y),
            anim: p.anim,
            frame: p.frame,
            dir: p.dir,
        });
    }
}

function broadcastDoorState() {
    broadcast({
        type: 'DOOR_STATE',
        doors: zones.doors.map((d, i) => ({ index: i, x: d.x, y: d.y, w: d.w, h: d.h, open: d.open }))
    });
}

// ─── Server principal ───
async function iniciarServidor() {
    loadZones();

    try {
        const wss = new WebSocket.Server({ port: SERVER_PORT });
        logger.info(`Servidor arrancado en puerto ${SERVER_PORT}`);

        // Game loop: simulación a TICK_RATE Hz
        setInterval(() => {
            simulate(1 / TICK_RATE);
        }, TICK_MS);

        // Broadcast de estado a BROADCAST_RATE Hz
        setInterval(() => {
            if (players.size > 0) broadcastState();
        }, BROADCAST_MS);

        // Heartbeat
        const heartbeat = setInterval(() => {
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

        wss.on('close', () => clearInterval(heartbeat));

        wss.on('connection', (ws) => {
            let nickname = null;
            ws.isAlive = true;
            ws.on('pong', () => { ws.isAlive = true; });

            logger.info('Nuevo cliente conectado');
            ws.send(JSON.stringify({ type: 'WELCOME', msg: 'Conexión aceptada' }));

            // Enviar lista actual
            const playerList = Array.from(players.entries()).map(([nick, p]) => ({
                nickname: nick, cat: p.cat
            }));
            ws.send(JSON.stringify({ type: 'PLAYER_LIST', players: playerList }));

            // Enviar estado de puertas
            if (zones.doors.length > 0) {
                ws.send(JSON.stringify({
                    type: 'DOOR_STATE',
                    doors: zones.doors.map((d, i) => ({ index: i, x: d.x, y: d.y, w: d.w, h: d.h, open: d.open }))
                }));
            }

            ws.on('message', (data) => {
                let message;
                try {
                    message = JSON.parse(data);
                } catch (err) {
                    logger.error('JSON inválido');
                    return;
                }

                switch (message.type) {
                    case 'JOIN': {
                        const requested = message.nickname;
                        const cat = message.cat || null;
                        nickname = uniqueNickname(requested);

                        players.set(nickname, new PlayerState(ws, cat, SPAWN_X, SPAWN_Y));

                        ws.send(JSON.stringify({ type: 'JOIN_OK', nickname, cat }));
                        logger.info(`Jugador registrado: ${nickname} (cat: ${cat})`);
                        broadcastPlayerList();
                        break;
                    }

                    case 'MOVE': {
                        // El cliente envía intención, no posición
                        const p = players.get(nickname);
                        if (!p) return;

                        const dir = message.dir || 'IDLE';
                        p.inputDir = dir;

                        if (dir === 'UP' || message.jump) {
                            p.wantJump = true;
                        }

                        // Aceptar frame del cliente para sincronizar animación
                        if (message.frame !== undefined) p.frame = message.frame;
                        break;
                    }

                    case 'GET_PLAYERS': {
                        const list = Array.from(players.entries()).map(([nick, p]) => ({
                            nickname: nick, cat: p.cat
                        }));
                        ws.send(JSON.stringify({ type: 'PLAYER_LIST', players: list }));
                        break;
                    }

                    case 'OPEN_DOOR': {
                        const doorIndex = message.doorIndex;
                        if (doorIndex >= 0 && doorIndex < zones.doors.length) {
                            zones.doors[doorIndex].open = true;
                            logger.info(`Puerta ${doorIndex} abierta`);
                            broadcastDoorState();
                        }
                        break;
                    }

                    case 'CLOSE_DOOR': {
                        const doorIndex = message.doorIndex;
                        if (doorIndex >= 0 && doorIndex < zones.doors.length) {
                            zones.doors[doorIndex].open = false;
                            logger.info(`Puerta ${doorIndex} cerrada`);
                            broadcastDoorState();
                        }
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