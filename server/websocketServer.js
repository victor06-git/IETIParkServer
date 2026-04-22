const WebSocket = require('ws');
const winston = require('winston');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

// ─── ESPECTADOR ───
const SPECTATOR_NICKNAME = 'flutter_viewer';

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
const TICK_RATE = 60;
const TICK_MS = 1000 / TICK_RATE;
const BROADCAST_RATE = 20;
const BROADCAST_MS = 1000 / BROADCAST_RATE;
const HEARTBEAT_INTERVAL = 30000;

// ─── Física ───
const MOVE_SPEED = 150;
const GRAVITY = 2088;
const JUMP_IMPULSE = 708;
const MAX_FALL = 840;
const PLAYER_W = 16;
const PLAYER_H = 16;
const FLOOR_EPSILON = 2;

// ─── Nivel ───
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
            } else if (type.includes('wall') || name.includes('mur')) {
                zones.walls.push(rect);
            } else if (type.includes('door')) {
                zones.doors.push({ ...rect, open: false });
            }
        }
    } catch (err) {
        logger.error(`Error cargando zonas: ${err.message}`);
        zones.floors = [{ x: 350, y: 398, w: 1000, h: 20 }];
        zones.walls = [
            { x: 310, y: 0, w: 50, h: 410 },
            { x: 1306, y: -3, w: 50, h: 410 }
        ];
    }
}

// ─── Jugadores ───
const players = new Map();

class PlayerState {
    constructor(ws, cat, x, y) {
        this.ws = ws;
        this.cat = cat;
        this.x = x;
        this.y = y;
        this.vx = 0;
        this.vy = 0;
        this.onGround = false;
        this.dir = 'RIGHT';
        this.anim = 'idle';
        this.frame = 0;
        this.inputDir = 'IDLE';
        this.wantJump = false;
    }
}

const SPAWN_X = 514;
const SPAWN_Y = 395;

// ─── Utils colisión ───
function rectsOverlap(ax, ay, aw, ah, bx, by, bw, bh) {
    return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

function playerRect(p) {
    return { x: p.x - PLAYER_W / 2, y: p.y - PLAYER_H / 2, w: PLAYER_W, h: PLAYER_H };
}

function collidesWall(px, py) {
    const pr = { x: px - PLAYER_W / 2, y: py - PLAYER_H / 2, w: PLAYER_W, h: PLAYER_H };

    for (const w of zones.walls) {
        if (rectsOverlap(pr.x, pr.y, pr.w, pr.h, w.x, w.y, w.w, w.h)) return true;
    }

    for (const d of zones.doors) {
        if (!d.open && rectsOverlap(pr.x, pr.y, pr.w, pr.h, d.x, d.y, d.w, d.h)) return true;
    }

    return false;
}

// ─── Simulación ───
function simulate(dt) {
    for (const [nickname, p] of players) {

        if (p.inputDir === 'LEFT') {
            p.vx = -MOVE_SPEED;
            p.dir = 'LEFT';
        } else if (p.inputDir === 'RIGHT') {
            p.vx = MOVE_SPEED;
            p.dir = 'RIGHT';
        } else {
            p.vx = 0;
        }

        if (p.wantJump && p.onGround) {
            p.vy = -JUMP_IMPULSE;
            p.onGround = false;
            p.wantJump = false;
        }

        if (!p.onGround) {
            p.vy += GRAVITY * dt;
            if (p.vy > MAX_FALL) p.vy = MAX_FALL;
        }

        const nextX = p.x + p.vx * dt;
        if (!collidesWall(nextX, p.y)) p.x = nextX;

        const nextY = p.y + p.vy * dt;
        if (!collidesWall(p.x, nextY)) p.y = nextY;

        if (p.y >= SPAWN_Y) {
            p.y = SPAWN_Y;
            p.vy = 0;
            p.onGround = true;
        }

        if (!p.onGround) p.anim = 'jump';
        else if (Math.abs(p.vx) > 1) p.anim = 'run';
        else p.anim = 'idle';
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
    const list = Array.from(players.entries())
        .filter(([nick]) => nick !== SPECTATOR_NICKNAME)
        .map(([nick, p]) => ({ nickname: nick, cat: p.cat }));

    broadcast({ type: 'PLAYER_LIST', players: list });
}

function broadcastState() {
    for (const [nickname, p] of players) {

        if (nickname === SPECTATOR_NICKNAME) continue;

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

// ─── Server ───
async function iniciarServidor() {
    loadZones();

    const wss = new WebSocket.Server({ port: SERVER_PORT });

    setInterval(() => simulate(1 / TICK_RATE), TICK_MS);
    setInterval(() => broadcastState(), BROADCAST_MS);

    wss.on('connection', (ws) => {

        let nickname = null;

        ws.on('message', (data) => {
            const msg = JSON.parse(data);

            switch (msg.type) {

                case 'JOIN': {

                    const requested = msg.nickname;

                    // 🔴 ESPECTADOR
                    if (requested === SPECTATOR_NICKNAME) {
                        nickname = requested;
                        ws.send(JSON.stringify({ type: 'JOIN_OK', nickname }));
                        logger.info('Viewer conectado');
                        return;
                    }

                    nickname = uniqueNickname(requested);

                    players.set(nickname, new PlayerState(ws, msg.cat, SPAWN_X, SPAWN_Y));

                    ws.send(JSON.stringify({ type: 'JOIN_OK', nickname }));

                    broadcastPlayerList();
                    break;
                }

                case 'MOVE': {
                    const p = players.get(nickname);
                    if (!p) return;

                    p.inputDir = msg.dir || 'IDLE';

                    if (msg.jump) p.wantJump = true;

                    if (msg.frame !== undefined) p.frame = msg.frame;
                    break;
                }

                case 'LEAVE': {
                    if (players.has(nickname)) {
                        players.delete(nickname);
                        broadcastPlayerList();
                    }
                    break;
                }
            }
        });

        ws.on('close', () => {
            if (players.has(nickname)) {
                players.delete(nickname);
                broadcastPlayerList();
            }
        });
    });

    logger.info(`Servidor en puerto ${SERVER_PORT}`);
}

iniciarServidor();