const MAX_PLAYERS = 8;
const FPS = 30;
const DT = 1 / FPS;
const LEVEL0_ADVANCE_DELAY_MS = 2000;
const RESPAWN_FIRST_DELAY_MS = 300;
const RESPAWN_CHAIN_DELAY_MS = 650;
const RESPAWN_DROP_HEIGHT = 86;

// x/y del jugador representa el centro inferior del gato.
const cat = { w: 26, h: 28, speed: 90, gravity: 900, jump: 310, maxFall: 520 };
const map = { width: 320, height: 180 };

const level0 = {
  index: 0,
  floorY: 176,
  potion: { x: 181, y: 118, w: 18, h: 18 },
  tree: { x: 241, y: 90, w: 90, h: 90 },
  doorCrossX: 241,
  solidZones: [{ name: 'rampa', x: 126, y: 132, w: 112, h: 48 }],
  spawns: [
    { x: 22, y: 148 }, { x: 50, y: 148 }, { x: 78, y: 148 }, { x: 106, y: 148 },
    { x: 134, y: 148 }, { x: 162, y: 148 }, { x: 190, y: 148 }, { x: 218, y: 148 }
  ]
};

// Siguiente nivel
const level1 = {
  index: 1,
  floorY: 143,
  potion: { x: 181, y: 66, w: 18, h: 18 },
  tree: { x: 251, y: 47, w: 72, h: 95 },
  doorCrossX: 251,
  leftFloor: { name: 'floor_left', x: 2, y: 143, w: 77, h: 35 },
  rightFloor: { name: 'floor_right', x: 255, y: 142, w: 77, h: 35 },
  deathZone: { name: 'dead_zone', x: 75, y: 164, w: 182, h: 16 },
  platformStart: { x: 144, y: 80, w: 78, h: 11 },
  // Path definido en assets/levels/paths/level_001_paths.json.
  // Los puntos representan el centro de la plataforma, no su esquina superior izquierda.
  platformPath: [
    { x: 182, y: 85 },
    { x: 184, y: 143 },
    { x: 138, y: 143 }
  ],
  platformSpeed: 32,
  buttonOffsetX: 210 - 144,
  buttonOffsetY: 78 - 80,
  potionOffsetX: 181 - 144,
  potionOffsetY: 66 - 80,
  spawns: [
    { x: 18, y: 143 }, { x: 36, y: 143 }, { x: 54, y: 143 }, { x: 68, y: 143 },
    { x: 24, y: 115 }, { x: 46, y: 115 }, { x: 64, y: 115 }, { x: 34, y: 87 }
  ]
};

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function round(v) { return Math.round(v * 100) / 100; }
function rectsTouch(a, b) {
  const EPS = 0.001;
  return a.x < b.x + b.w - EPS && a.x + a.w > b.x + EPS && a.y < b.y + b.h - EPS && a.y + a.h > b.y + EPS;
}
function cleanNick(value) {
  const nick = String(value || 'Player').trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 16);
  return nick || 'Player';
}
function isViewer(msg) {
  const text = String(msg.client || msg.role || '').toLowerCase();
  return msg.viewer === true || text.includes('viewer') || text.includes('flutter');
}

class GameRoom {
  constructor({ log, mongo }) {
    this.log = log;
    this.mongo = mongo;
    this.players = new Map();
    this.nextId = 1;
    this.levelIndex = 0;
    this.nextRespawnAllowedAt = 0;
    this.resetWorld();
  }

  get config() { return this.levelIndex === 1 ? level1 : level0; }
  getPlayerCount() { return this.players.size; }
  isFull() { return this.players.size >= MAX_PLAYERS; }

  freeNick(base) {
    const used = new Set([...this.players.values()].map(p => p.nickname));
    const nick = cleanNick(base);
    if (!used.has(nick)) return nick;
    let i = 1;
    while (used.has(`${nick}_${i}`)) i++;
    return `${nick}_${i}`;
  }

  freeCat() {
    const used = new Set([...this.players.values()].map(p => p.cat));
    for (let i = 1; i <= MAX_PLAYERS; i++) if (!used.has(i)) return i;
    return 1;
  }

  async addPlayer(msg, previousId = null) {
    const id = previousId || `p${this.nextId++}`;
    const catId = this.freeCat();
    const spawn = this.spawnForCat(catId);
    const nickname = this.freeNick(msg.nickname);

    if (this.players.size === 0 && this.mongo.startMatch) await this.mongo.startMatch();
    const jugadorDoc = this.mongo.upsertJugador ? await this.mongo.upsertJugador(nickname) : null;

    const player = {
      id, nickname, cat: catId, x: spawn.x, y: spawn.y, vx: 0, vy: 0,
      grounded: true, facingRight: true, anim: 'idle', crossedDoor: false,
      mongoId: jugadorDoc ? jugadorDoc._id : null,
      input: { moveX: 0, jumpPressed: false, jumpHeld: false },
      respawnPendingUntil: 0
    };
    this.players.set(id, player);
    if (this.mongo.registerPlayerInMatch) await this.mongo.registerPlayerInMatch(player.mongoId);
    this.log.info(`${player.nickname} entra como cat${player.cat}`);
    return player;
  }

  spawnForCat(catId) {
    const list = this.config.spawns;
    return list[(catId - 1) % list.length] || list[0];
  }

  removePlayer(id, reason) {
    const player = this.players.get(id);
    if (!player) return false;
    this.players.delete(id);
    if (this.potion.carrierId === id) this.resetWorld(false);
    this.log.info(`${player.nickname} sale (${reason})`);
    if (this.players.size === 0) this.resetWorld();
    return true;
  }

  resetWorld(resetLevel = true) {
    if (resetLevel) this.levelIndex = 0;
    const c = this.config;
    this.potion = { ...c.potion, taken: false, carrierId: null, consumed: false };
    this.tree = { ...c.tree, open: false, openedAt: 0 };
    this.platform = {
      ...(level1.platformStart),
      active: false,
      dir: 1,
      previousX: level1.platformStart.x,
      previousY: level1.platformStart.y,
      dx: 0,
      dy: 0,
      pathIndex: 0,
      pathDir: 1
    };
    this.goal = { unlocked: false, allPlayersPassed: false, shouldChangeScreen: false, crossedAt: 0, changeReason: '', pendingAdvanceAt: 0 };
    this.nextRespawnAllowedAt = 0;
    for (const p of this.players.values()) {
      p.crossedDoor = false;
      p.respawnPendingUntil = 0;
    }
  }

  resetPlayersAndWorld() {
    this.players.clear();
    this.resetWorld(true);
  }

  setInput(playerId, msg) {
    const player = this.players.get(playerId);
    if (!player) return;
    player.input.moveX = clamp(Number(msg.moveX || 0), -1, 1);
    player.input.jumpPressed = Boolean(msg.jumpPressed) || player.input.jumpPressed;
    player.input.jumpHeld = Boolean(msg.jumpHeld);
  }

  setMoveInput(playerId, msg) {
    const player = this.players.get(playerId);
    if (!player) return;
    const dir = String(msg.dir || '').toUpperCase();
    player.input.moveX = dir === 'LEFT' ? -1 : (dir === 'RIGHT' ? 1 : 0);
    player.input.jumpPressed = dir === 'JUMP' || Boolean(msg.jumpPressed);
  }

  tick() {
    this.updatePlatform();
    for (const player of this.players.values()) this.updatePlayer(player);
    this.updateGoalState();
  }

  updatePlatform() {
    this.platform.previousX = this.platform.x;
    this.platform.previousY = this.platform.y;
    this.platform.dx = 0;
    this.platform.dy = 0;
    if (this.levelIndex !== 1 || !this.platform.active) return;

    const path = level1.platformPath;
    if (!path || path.length < 2) return;

    let remaining = level1.platformSpeed * DT;
    while (remaining > 0.0001) {
      const currentCenter = this.platformCenter();
      let nextIndex = this.platform.pathIndex + this.platform.pathDir;
      if (nextIndex >= path.length) { this.platform.pathDir = -1; nextIndex = path.length - 2; }
      if (nextIndex < 0) { this.platform.pathDir = 1; nextIndex = 1; }

      const target = path[nextIndex];
      const vx = target.x - currentCenter.x;
      const vy = target.y - currentCenter.y;
      const distance = Math.sqrt(vx * vx + vy * vy);

      if (distance <= 0.0001) {
        this.platform.pathIndex = nextIndex;
        continue;
      }

      const step = Math.min(remaining, distance);
      const ratio = step / distance;
      const nextCenterX = currentCenter.x + vx * ratio;
      const nextCenterY = currentCenter.y + vy * ratio;
      this.setPlatformCenter(nextCenterX, nextCenterY);
      remaining -= step;

      if (step >= distance - 0.0001) this.platform.pathIndex = nextIndex;
    }

    this.platform.dx = this.platform.x - this.platform.previousX;
    this.platform.dy = this.platform.y - this.platform.previousY;
  }

  platformCenter() {
    return { x: this.platform.x + this.platform.w * 0.5, y: this.platform.y + this.platform.h * 0.5 };
  }

  setPlatformCenter(x, y) {
    this.platform.x = x - this.platform.w * 0.5;
    this.platform.y = y - this.platform.h * 0.5;
  }

  updatePlayer(player) {
    if (this.handlePendingRespawn(player)) return;

    const input = player.input || { moveX: 0, jumpPressed: false, jumpHeld: false };
    const move = clamp(Number(input.moveX || 0), -1, 1);

    if (this.isOnMovingPlatform(player) && (this.platform.dx !== 0 || this.platform.dy !== 0)) {
      player.x += this.platform.dx;
      player.y += this.platform.dy;
    }

    player.vx = move * cat.speed;
    if (move < 0) player.facingRight = false;
    if (move > 0) player.facingRight = true;

    player.grounded = this.isStandingOnSomething(player);
    if (input.jumpPressed && player.grounded) { player.vy = -cat.jump; player.grounded = false; }
    input.jumpPressed = false;

    if (!player.grounded) player.vy = Math.min(cat.maxFall, player.vy + cat.gravity * DT);

    this.moveX(player, player.vx * DT);
    this.moveY(player, player.vy * DT);

    const playerRect = this.catRect(player);
    if (this.levelIndex === 1) {
      this.handleLevel1Interactions(player, playerRect);
    } else {
      this.handleLevel0Interactions(player, playerRect);
    }

    player.x = clamp(player.x, cat.w * 0.5, map.width - cat.w * 0.5);
    player.anim = !player.grounded ? 'jump' : (Math.abs(player.vx) > 1 ? 'run' : 'idle');
  }

  handleLevel0Interactions(player, playerRect) {
    if (!this.potion.taken && !this.potion.consumed && rectsTouch(playerRect, this.potionRect())) {
      this.potion.taken = true; this.potion.carrierId = player.id;
      this.log.info(`${player.nickname} coge la pocion`);
    }
    if (!this.tree.open && this.potion.carrierId === player.id && rectsTouch(playerRect, this.treeRect())) this.openTreeWithPotion(player);
  }

  handleLevel1Interactions(player, playerRect) {
    if (rectsTouch(playerRect, level1.deathZone) || player.y > map.height + 35) {
      this.scheduleRespawn(player);
      return;
    }
    if (!this.platform.active && rectsTouch(playerRect, this.buttonRect())) {
      this.platform.active = true;
      this.log.info(`${player.nickname} activa la plataforma movil`);
    }
    if (!this.potion.taken && !this.potion.consumed && rectsTouch(playerRect, this.potionRect())) {
      this.potion.taken = true; this.potion.carrierId = player.id;
      this.log.info(`${player.nickname} coge la pocion verde`);
    }
    if (!this.tree.open && this.potion.carrierId === player.id && rectsTouch(playerRect, this.treeRect())) this.openTreeWithPotion(player);
  }

  scheduleRespawn(player) {
    if (player.respawnPendingUntil && player.respawnPendingUntil > 0) return;

    const now = Date.now();
    const baseTime = Math.max(now + RESPAWN_FIRST_DELAY_MS, this.nextRespawnAllowedAt || 0);
    player.respawnPendingUntil = baseTime;
    this.nextRespawnAllowedAt = baseTime + RESPAWN_CHAIN_DELAY_MS;

    // Mientras espera su turno no participa en colisiones ni se queda pegado a la death zone.
    player.x = clamp(player.x, cat.w * 0.5, map.width - cat.w * 0.5);
    player.y = map.height + 45;
    player.vx = 0;
    player.vy = 0;
    player.grounded = false;
    player.anim = 'jump';
    player.input.jumpPressed = false;
    player.input.jumpHeld = false;
    this.log.info(`${player.nickname} ha caido. Respawn programado.`);
  }

  handlePendingRespawn(player) {
    if (!player.respawnPendingUntil || player.respawnPendingUntil <= 0) return false;

    const now = Date.now();
    if (now < player.respawnPendingUntil) {
      player.vx = 0;
      player.vy = 0;
      player.grounded = false;
      player.anim = 'jump';
      return true;
    }

    this.respawnPlayerFromAbove(player);
    return false;
  }

  respawnPlayerFromAbove(player) {
    const base = this.spawnForCat(player.cat);
    player.x = clamp(base.x, cat.w * 0.5, map.width - cat.w * 0.5);
    player.y = clamp(base.y - RESPAWN_DROP_HEIGHT, 0, map.height + 60);
    player.vx = 0;
    player.vy = 0;
    player.grounded = false;
    player.anim = 'jump';
    player.crossedDoor = false;
    player.respawnPendingUntil = 0;
    this.log.info(`${player.nickname} reaparece cayendo desde arriba.`);
  }

  openTreeWithPotion(player) {
    this.potion.taken = true; this.potion.consumed = true; this.potion.carrierId = null;
    this.tree.open = true; this.tree.openedAt = Date.now();
    this.goal.unlocked = true; this.goal.allPlayersPassed = false; this.goal.shouldChangeScreen = false; this.goal.changeReason = '';
    this.nextRespawnAllowedAt = 0;
    for (const p of this.players.values()) {
      p.crossedDoor = false;
      p.respawnPendingUntil = 0;
    }
    this.log.info(`${player.nickname} cura el arbol con la pocion`);
    if (player.mongoId && this.mongo.markPotionObtained) this.mongo.markPotionObtained(player.mongoId).catch(() => {});
  }

  updateGoalState() {
    if (!this.goal.unlocked) { this.goal.allPlayersPassed = false; this.goal.shouldChangeScreen = false; return; }
    const c = this.config;
    for (const player of this.players.values()) {
      const playerLeft = player.x - cat.w * 0.5;
      if (!player.crossedDoor && playerLeft >= c.doorCrossX) {
        player.crossedDoor = true;
        this.log.info(`${player.nickname} ha cruzado el arbol`);
      }
    }
    const hasPlayers = this.players.size > 0;
    const everyonePassed = hasPlayers && [...this.players.values()].every(p => p.crossedDoor === true);
    if (everyonePassed && !this.goal.shouldChangeScreen) {
      this.goal.allPlayersPassed = true;
      if (this.levelIndex === 0) {
        const now = Date.now();
        if (!this.goal.pendingAdvanceAt) {
          this.goal.pendingAdvanceAt = now + LEVEL0_ADVANCE_DELAY_MS;
          this.goal.changeReason = 'LEVEL_0_COMPLETE_WAITING_TREE_ANIMATION';
        }
        if (now >= this.goal.pendingAdvanceAt) this.advanceToLevel1();
      } else {
        this.goal.shouldChangeScreen = true;
        this.goal.crossedAt = Date.now();
        this.goal.changeReason = 'ALL_PLAYERS_FINISHED_LEVEL_2';
        if (this.mongo.finishMatch) this.mongo.finishMatch().catch(() => {});
      }
      return;
    }
    if (!everyonePassed) {
      this.goal.allPlayersPassed = false;
      this.goal.shouldChangeScreen = false;
      this.goal.changeReason = '';
      this.goal.pendingAdvanceAt = 0;
    }
  }

  advanceToLevel1() {
    this.levelIndex = 1;
    this.resetWorld(false);
    for (const p of this.players.values()) {
      const spawn = this.spawnForCat(p.cat);
      p.x = spawn.x; p.y = spawn.y; p.vx = 0; p.vy = 0; p.grounded = true; p.crossedDoor = false; p.anim = 'idle';
    }
    this.goal.shouldChangeScreen = true;
    this.goal.changeReason = 'LOAD_LEVEL_1';
    this.log.info('Nivel 1 completado. Cambiando a Level2.');
  }

  moveX(player, dx) {
    if (dx === 0) return;
    let nextX = player.x + dx;
    let rect = this.catRect(player, nextX, player.y);
    if (this.touchesClosedTreeWithPotion(player, rect)) this.openTreeWithPotion(player);
    for (const box of this.collisionBoxes(player)) {
      if (!rectsTouch(rect, box)) continue;
      nextX = dx > 0 ? box.x - cat.w * 0.5 : box.x + box.w + cat.w * 0.5;
      player.vx = 0;
      rect = this.catRect(player, nextX, player.y);
    }
    player.x = clamp(nextX, cat.w * 0.5, map.width - cat.w * 0.5);
  }

  moveY(player, dy) {
    if (dy === 0) return;
    let nextY = player.y + dy;
    let rect = this.catRect(player, player.x, nextY);
    player.grounded = false;
    if (this.touchesClosedTreeWithPotion(player, rect)) this.openTreeWithPotion(player);
    for (const box of this.collisionBoxes(player)) {
      if (!rectsTouch(rect, box)) continue;
      if (dy > 0) { nextY = box.y; player.grounded = true; }
      else { nextY = box.y + box.h + cat.h; }
      player.vy = 0;
      rect = this.catRect(player, player.x, nextY);
    }
    if (this.levelIndex === 0 && nextY >= level0.floorY) { nextY = level0.floorY; player.vy = 0; player.grounded = true; }
    player.y = clamp(nextY, 0, map.height + 60);
  }

  isStandingOnSomething(player) {
    if (this.levelIndex === 0 && Math.abs(player.y - level0.floorY) <= 0.5) return true;
    const foot = { x: player.x - cat.w * 0.5 + 1, y: player.y, w: cat.w - 2, h: 1.5 };
    for (const box of this.collisionBoxes(player)) {
      const top = { x: box.x, y: box.y - 0.5, w: box.w, h: 1.5 };
      if (rectsTouch(foot, top)) return true;
    }
    return false;
  }

  isOnMovingPlatform(player) {
    if (this.levelIndex !== 1) return false;
    const foot = { x: player.x - cat.w * 0.5 + 1, y: player.y, w: cat.w - 2, h: 2.5 };
    const currentTop = { x: this.platform.x, y: this.platform.y - 1.0, w: this.platform.w, h: 3.0 };
    const previousTop = { x: this.platform.previousX, y: this.platform.previousY - 1.0, w: this.platform.w, h: 3.0 };
    return rectsTouch(foot, currentTop) || rectsTouch(foot, previousTop);
  }

  touchesClosedTreeWithPotion(player, rect) {
    return !this.tree.open && !this.potion.consumed && this.potion.carrierId === player.id && rectsTouch(rect, this.treeRect());
  }

  collisionBoxes(player) { return [...this.mapBoxes(), ...this.playerBoxes(player)]; }

  mapBoxes() {
    if (this.levelIndex === 1) {
      const boxes = [
        { name: 'left_wall', x: -44, y: -3, w: 47, h: 151 },
        { name: 'right_wall', x: 318, y: -8, w: 47, h: 151 },
        level1.leftFloor,
        level1.rightFloor,
        { name: 'platform', x: this.platform.x, y: this.platform.y, w: this.platform.w, h: this.platform.h }
      ];
      if (!this.tree.open) boxes.push(this.treeRect());
      return boxes;
    }
    const boxes = [
      { name: 'left_wall', x: -50, y: -100, w: 50, h: 400 },
      { name: 'right_wall', x: map.width, y: -100, w: 50, h: 400 },
      ...level0.solidZones
    ];
    if (!this.tree.open) boxes.push(this.treeRect());
    return boxes;
  }

  playerBoxes(player) {
    const boxes = [];
    for (const other of this.players.values()) {
      if (other.id === player.id) continue;
      if (other.respawnPendingUntil && other.respawnPendingUntil > 0) continue;
      boxes.push({ name: 'player', ...this.catRect(other) });
    }
    return boxes;
  }

  catRect(player, x = player.x, y = player.y) { return { x: x - cat.w * 0.5, y: y - cat.h, w: cat.w, h: cat.h }; }
  potionRect() { return { x: this.potion.x - this.potion.w * 0.5, y: this.potion.y - this.potion.h * 0.5, w: this.potion.w, h: this.potion.h }; }
  treeRect() { return { name: 'tree', x: this.tree.x, y: this.tree.y, w: this.tree.w, h: this.tree.h }; }
  buttonRect() {
    const x = this.platform.x + level1.buttonOffsetX;
    const y = this.platform.y + level1.buttonOffsetY;
    return { name: 'button', x: x - 10, y: y - 8, w: 20, h: 16 };
  }

  countPlayersPastDoor() { let total = 0; for (const p of this.players.values()) if (p.crossedDoor === true) total++; return total; }

  playersForClient() {
    return [...this.players.values()].map(p => ({
      id: p.id, nickname: p.nickname, cat: p.cat, x: round(p.x), y: round(p.y), vx: round(p.vx), vy: round(p.vy),
      anim: p.anim, facingRight: p.facingRight, grounded: p.grounded, hasPotion: this.potion.carrierId === p.id,
      crossedDoor: p.crossedDoor === true, viewer: false
    }));
  }

  crossedPlayersForClient() { return [...this.players.values()].map(p => ({ id: p.id, nickname: p.nickname, crossedDoor: p.crossedDoor === true })); }

  worldForClient() {
    const buttonX = this.levelIndex === 1 ? this.platform.x + level1.buttonOffsetX : 0;
    const buttonY = this.levelIndex === 1 ? this.platform.y + level1.buttonOffsetY : 0;
    if (this.levelIndex === 1) {
      this.potion.x = this.platform.x + level1.potionOffsetX;
      this.potion.y = this.platform.y + level1.potionOffsetY;
    }
    return {
      levelIndex: this.levelIndex,
      potionTaken: this.potion.taken,
      potionConsumed: this.potion.consumed,
      potionCarrierId: this.potion.carrierId || '',
      potionX: round(this.potion.x),
      potionY: round(this.potion.y),
      doorOpen: this.tree.open,
      treeOpening: this.tree.open && Date.now() - this.tree.openedAt < 1100,
      doorX: this.tree.x,
      doorY: this.tree.y,
      doorWidth: this.tree.w,
      doorHeight: this.tree.h,
      platformX: round(this.platform.x),
      platformY: round(this.platform.y),
      platformWidth: this.platform.w,
      platformHeight: this.platform.h,
      platformActive: this.platform.active,
      buttonX: round(buttonX),
      buttonY: round(buttonY),
      buttonPressed: this.platform.active,
      levelUnlocked: this.goal.unlocked,
      allPlayersPassed: this.goal.allPlayersPassed,
      shouldChangeScreen: this.goal.shouldChangeScreen,
      crossedPlayers: this.crossedPlayersForClient(),
      totalPlayers: this.players.size,
      passedPlayers: this.countPlayersPastDoor(),
      changeReason: this.goal.changeReason
    };
  }
}

module.exports = { GameRoom, MAX_PLAYERS, FPS, isViewer };