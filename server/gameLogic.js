const MAX_PLAYERS = 8;
const FPS = 30;
const DT = 1 / FPS;

// El servidor trabaja con coordenadas del editor: x normal, y hacia abajo.
// Cada jugador usa x/y como centro inferior de la hitbox.
const cat = { w: 26, h: 28, speed: 90, gravity: 900, jump: 310, maxFall: 520 };

const levels = [
  {
    index: 0,
    name: 'Tutorial level',
    map: { width: 320, height: 180, floorY: 176 },
    potion: { x: 181, y: 118, w: 18, h: 18, kind: 'red' },
    tree: { x: 241, y: 90, w: 90, h: 90 },
    doorCrossX: 241,
    spawns: [
      { x: 22, y: 148 }, { x: 50, y: 148 }, { x: 78, y: 148 }, { x: 106, y: 148 },
      { x: 134, y: 148 }, { x: 162, y: 148 }, { x: 190, y: 148 }, { x: 218, y: 148 }
    ],
    solids: [
      { name: 'left_wall', x: -50, y: -100, w: 50, h: 400 },
      { name: 'right_wall', x: 320, y: -100, w: 50, h: 400 },
      { name: 'rampa', x: 126, y: 132, w: 112, h: 48 }
    ],
    floors: [{ name: 'floor', x: -127, y: 176, w: 600, h: 30 }],
    deathZones: []
  },
  {
    index: 1,
    name: 'Level2',
    map: { width: 320, height: 180, floorY: 180 },
    potion: { x: 181, y: 66, w: 18, h: 18, kind: 'green' },
    tree: { x: 251, y: 47, w: 72, h: 95 },
    doorCrossX: 251,
    spawns: [
      { x: 18, y: 143 }, { x: 34, y: 143 }, { x: 50, y: 143 }, { x: 66, y: 143 },
      { x: 18, y: 114 }, { x: 34, y: 114 }, { x: 50, y: 114 }, { x: 66, y: 114 }
    ],
    solids: [
      { name: 'left_wall', x: -44, y: -3, w: 47, h: 151 },
      { name: 'right_wall', x: 318, y: -8, w: 47, h: 151 }
    ],
    floors: [
      { name: 'floor_left', x: 2, y: 143, w: 77, h: 35 },
      { name: 'floor_right', x: 255, y: 142, w: 77, h: 35 }
    ],
    deathZones: [{ name: 'precipicio', x: 75, y: 164, w: 182, h: 16 }],
    platform: { x: 144, y: 80, w: 78, h: 11, speed: 42, leftX: 138, rightX: 184, lowerY: 143 },
    button: { x: 210, y: 78, w: 22, h: 14 },
    finishX: 278
  }
];

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }
function round(v) { return Math.round(v * 100) / 100; }

function rectsTouch(a, b) {
  const EPS = 0.001;
  return a.x < b.x + b.w - EPS &&
    a.x + a.w > b.x + EPS &&
    a.y < b.y + b.h - EPS &&
    a.y + a.h > b.y + EPS;
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
    this.currentLevel = 0;
    this.levelChangeNonce = 0;
    this.lastLevelChangeAt = 0;
    this.respawnSerial = 0;
    this.resetLevelState(0);
  }

  level() { return levels[this.currentLevel] || levels[0]; }
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

  spawnFor(catId) {
    const spawns = this.level().spawns;
    return spawns[(catId - 1) % spawns.length] || spawns[0];
  }

  async addPlayer(msg, previousId = null) {
    const id = previousId || `p${this.nextId++}`;
    const catId = this.freeCat();
    const spawn = this.spawnFor(catId);
    const nickname = this.freeNick(msg.nickname);

    if (this.players.size === 0 && this.mongo.startMatch) await this.mongo.startMatch();
    const jugadorDoc = this.mongo.upsertJugador ? await this.mongo.upsertJugador(nickname) : null;

    const player = {
      id,
      nickname,
      cat: catId,
      level: this.currentLevel,
      x: spawn.x,
      y: spawn.y,
      vx: 0,
      vy: 0,
      grounded: true,
      standingOnPlayer: false,
      facingRight: true,
      anim: 'idle',
      crossedDoor: false,
      crossedLevel2: false,
      mongoId: jugadorDoc ? jugadorDoc._id : null,
      input: { moveX: 0, jumpPressed: false, jumpHeld: false }
    };

    this.players.set(id, player);
    if (this.mongo.registerPlayerInMatch) await this.mongo.registerPlayerInMatch(player.mongoId);
    this.log.info(`${player.nickname} entra como cat${player.cat}`);
    return player;
  }

  removePlayer(id, reason) {
    const player = this.players.get(id);
    if (!player) return false;
    this.players.delete(id);
    if (this.potion.carrierId === id) this.dropPotionOrReset();
    this.log.info(`${player.nickname} sale (${reason})`);
    if (this.players.size === 0) this.resetAll();
    return true;
  }

  resetAll() {
    this.currentLevel = 0;
    this.levelChangeNonce = 0;
    this.resetLevelState(0);
  }

  resetPlayersAndWorld() {
    this.players.clear();
    this.resetAll();
  }

  resetLevelState(levelIndex) {
    const level = levels[levelIndex] || levels[0];
    this.potion = { ...level.potion, taken: false, carrierId: null, consumed: false };
    this.tree = { ...level.tree, open: false, openedAt: 0 };
    this.goal = {
      unlocked: false,
      allPlayersPassed: false,
      shouldChangeScreen: false,
      nextLevelIndex: -1,
      levelChangeNonce: this.levelChangeNonce,
      crossedAt: 0,
      changeReason: ''
    };
    this.platform = level.platform ? { ...level.platform, active: false, phase: 'idle', dir: -1 } : null;
    this.button = level.button ? { ...level.button, visible: false, active: false } : null;
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
    this.clearOldChangeFlag();
    this.updatePlatform();
    for (const player of this.players.values()) this.updatePlayer(player);
    this.updateGoalState();
  }

  clearOldChangeFlag() {
    if (this.goal.shouldChangeScreen && Date.now() - this.lastLevelChangeAt > 1800) {
      this.goal.shouldChangeScreen = false;
      this.goal.nextLevelIndex = -1;
    }
  }

  updatePlayer(player) {
    if (player.level !== this.currentLevel) {
      this.respawnPlayer(player);
      player.level = this.currentLevel;
    }

    const input = player.input || { moveX: 0, jumpPressed: false, jumpHeld: false };
    const move = clamp(Number(input.moveX || 0), -1, 1);

    player.vx = move * cat.speed;
    if (move < 0) player.facingRight = false;
    if (move > 0) player.facingRight = true;

    const support = this.findSupport(player);
    player.grounded = support.grounded;
    player.standingOnPlayer = support.name === 'player';

    if (input.jumpPressed && player.grounded) {
      player.vy = -cat.jump;
      player.grounded = false;
    }
    input.jumpPressed = false;

    if (!player.grounded) player.vy = Math.min(cat.maxFall, player.vy + cat.gravity * DT);

    this.moveX(player, player.vx * DT);
    this.moveY(player, player.vy * DT);
    this.applyLevelInteractions(player);

    const level = this.level();
    player.x = clamp(player.x, cat.w * 0.5, level.map.width - cat.w * 0.5);
    player.y = clamp(player.y, 0, level.map.height + 80);
    player.anim = !player.grounded ? 'jump' : (Math.abs(player.vx) > 1 ? 'run' : 'idle');
  }

  applyLevelInteractions(player) {
    const rect = this.catRect(player);

    // Nivel 0: poción roja + árbol.
    if (this.currentLevel === 0) {
      if (!this.potion.taken && !this.potion.consumed && rectsTouch(rect, this.potionRect())) {
        this.takePotion(player);
      }
      if (!this.tree.open && this.potion.carrierId === player.id && rectsTouch(rect, this.treeRect())) {
        this.openTreeWithPotion(player);
      }
      return;
    }

    // Nivel 1: si caen al precipicio vuelven al inicio, separados para no aparecer apilados.
    for (const death of this.level().deathZones) {
      if (rectsTouch(rect, death)) {
        this.log.info(`${player.nickname} cae al precipicio y vuelve al inicio`);
        this.respawnPlayer(player);
        return;
      }
    }

    // La poción verde solo se puede coger si algún jugador está apilado encima de otro.
    if (!this.potion.taken && !this.potion.consumed && rectsTouch(rect, this.potionRect())) {
      if (this.isStackReady()) {
        this.takePotion(player);
      }
    }

    // La poción verde abre el árbol de salida del nivel 1.
    if (!this.tree.open && this.potion.carrierId === player.id && rectsTouch(rect, this.treeRect())) {
      this.openTreeWithPotion(player);
    }

    // El botón aparece cuando alguien ha llegado a la derecha. Al tocarlo, arranca la plataforma móvil.
    if (this.button) {
      if (!this.button.visible && player.x > 235) {
        this.button.visible = true;
        this.log.info('El boton del segundo nivel ya es visible');
      }
      if (this.button.visible && !this.button.active && rectsTouch(rect, this.buttonRect())) {
        this.button.active = true;
        if (this.platform) {
          this.platform.active = true;
          this.platform.phase = 'drop';
        }
        this.log.info(`${player.nickname} activa la plataforma movil`);
      }
    }
  }

  isStackReady() {
    if (this.players.size < 2) return false;
    for (const player of this.players.values()) {
      if (player.standingOnPlayer) return true;
    }
    return false;
  }

  takePotion(player) {
    this.potion.taken = true;
    this.potion.carrierId = player.id;
    this.log.info(`${player.nickname} coge la pocion`);
  }

  openTreeWithPotion(player) {
    this.potion.taken = true;
    this.potion.consumed = true;
    this.potion.carrierId = null;
    this.tree.open = true;
    this.tree.openedAt = Date.now();
    this.goal.unlocked = true;
    this.goal.allPlayersPassed = false;
    this.goal.changeReason = '';

    for (const p of this.players.values()) {
      p.crossedDoor = false;
      if (this.currentLevel === 1) p.crossedLevel2 = false;
    }

    const label = this.currentLevel === 0 ? 'arbol' : 'arbol del segundo nivel';
    this.log.info(`${player.nickname} cura el ${label} con la pocion`);
    if (player.mongoId && this.mongo.markPotionObtained) this.mongo.markPotionObtained(player.mongoId).catch(() => {});
  }

  dropPotionOrReset() {
    this.potion.taken = false;
    this.potion.carrierId = null;
    this.potion.consumed = false;
    this.tree.open = false;
    this.tree.openedAt = 0;
    this.goal.unlocked = false;
  }

  updateGoalState() {
    if (this.currentLevel === 0) return this.updateLevel0Goal();
    return this.updateLevel1Goal();
  }

  updateLevel0Goal() {
    if (!this.goal.unlocked) return;

    for (const player of this.players.values()) {
      const playerLeft = player.x - cat.w * 0.5;
      if (!player.crossedDoor && playerLeft >= this.level().doorCrossX) {
        player.crossedDoor = true;
        this.log.info(`${player.nickname} ha cruzado el arbol`);
      }
    }

    const everyonePassed = this.players.size > 0 && [...this.players.values()].every(p => p.crossedDoor);
    if (everyonePassed && !this.goal.allPlayersPassed) {
      this.goal.allPlayersPassed = true;
      this.changeToLevel(1, 'ALL_PLAYERS_CROSSED_TREE');
    }
  }

  updateLevel1Goal() {
    if (!this.tree.open) return;

    for (const player of this.players.values()) {
      if (!player.crossedLevel2 && player.x >= this.level().finishX) {
        player.crossedLevel2 = true;
        this.log.info(`${player.nickname} ha cruzado el segundo nivel`);
      }
    }

    const everyonePassed = this.players.size > 0 && [...this.players.values()].every(p => p.crossedLevel2);
    if (everyonePassed && !this.goal.allPlayersPassed) {
      this.goal.allPlayersPassed = true;
      this.goal.shouldChangeScreen = true;
      this.goal.nextLevelIndex = -1;
      this.goal.changeReason = 'ALL_PLAYERS_CROSSED_LEVEL_2';
      this.goal.crossedAt = Date.now();
      this.lastLevelChangeAt = Date.now();
      this.log.info('Todos los jugadores han cruzado el segundo nivel. La app puede preparar la siguiente pantalla.');
      if (this.mongo.finishMatch) this.mongo.finishMatch().catch(() => {});
    }
  }

  changeToLevel(nextLevelIndex, reason) {
    this.currentLevel = nextLevelIndex;
    this.levelChangeNonce++;
    this.lastLevelChangeAt = Date.now();
    this.resetLevelState(nextLevelIndex);
    this.goal.shouldChangeScreen = true;
    this.goal.nextLevelIndex = nextLevelIndex;
    this.goal.levelChangeNonce = this.levelChangeNonce;
    this.goal.changeReason = reason;

    for (const player of this.players.values()) {
      player.level = nextLevelIndex;
      player.crossedDoor = false;
      player.crossedLevel2 = false;
      this.respawnPlayer(player);
    }

    this.log.info(`Todos los jugadores han cruzado el arbol. Cambiando al nivel ${nextLevelIndex}`);
  }

  respawnPlayer(player) {
    const level = this.level();
    const base = this.spawnFor(player.cat);
    const offsetIndex = this.respawnSerial++ % Math.max(1, level.spawns.length);
    const offsetX = (offsetIndex % 4) * 8;
    const offsetY = Math.floor(offsetIndex / 4) * -cat.h;
    player.x = clamp(base.x + offsetX, cat.w * 0.5, level.map.width - cat.w * 0.5);
    player.y = base.y + offsetY;
    player.vx = 0;
    player.vy = 0;
    player.grounded = true;
    player.standingOnPlayer = false;
    player.anim = 'idle';
  }

  updatePlatform() {
    if (!this.platform || !this.platform.active) return;

    if (this.platform.phase === 'drop') {
      this.platform.y += this.platform.speed * DT;
      if (this.platform.y >= this.platform.lowerY) {
        this.platform.y = this.platform.lowerY;
        this.platform.phase = 'move';
        this.platform.dir = -1;
      }
      return;
    }

    this.platform.x += this.platform.dir * this.platform.speed * DT;
    if (this.platform.x <= this.platform.leftX) {
      this.platform.x = this.platform.leftX;
      this.platform.dir = 1;
    } else if (this.platform.x >= this.platform.rightX) {
      this.platform.x = this.platform.rightX;
      this.platform.dir = -1;
    }
  }

  moveX(player, dx) {
    if (dx === 0) return;
    let nextX = player.x + dx;
    let rect = this.catRect(player, nextX, player.y);

    if (this.touchesClosedTreeWithPotion(player, rect)) this.openTreeWithPotion(player);

    for (const box of this.collisionBoxes(player)) {
      if (!rectsTouch(rect, box)) continue;
      if (dx > 0) nextX = box.x - cat.w * 0.5;
      else nextX = box.x + box.w + cat.w * 0.5;
      player.vx = 0;
      rect = this.catRect(player, nextX, player.y);
    }
    player.x = clamp(nextX, cat.w * 0.5, this.level().map.width - cat.w * 0.5);
  }

  moveY(player, dy) {
    if (dy === 0) return;
    let nextY = player.y + dy;
    let rect = this.catRect(player, player.x, nextY);
    player.grounded = false;
    player.standingOnPlayer = false;

    if (this.touchesClosedTreeWithPotion(player, rect)) this.openTreeWithPotion(player);

    for (const box of this.collisionBoxes(player)) {
      if (!rectsTouch(rect, box)) continue;

      if (dy > 0) {
        nextY = box.y;
        player.grounded = true;
        player.standingOnPlayer = box.name === 'player';
      } else {
        nextY = box.y + box.h + cat.h;
      }

      player.vy = 0;
      rect = this.catRect(player, player.x, nextY);
    }
    player.y = nextY;
  }

  findSupport(player) {
    const foot = { x: player.x - cat.w * 0.5 + 1, y: player.y, w: cat.w - 2, h: 2 };
    for (const box of this.collisionBoxes(player)) {
      const top = { x: box.x, y: box.y - 0.5, w: box.w, h: 2 };
      if (rectsTouch(foot, top)) return { grounded: true, name: box.name };
    }
    return { grounded: false, name: '' };
  }

  collisionBoxes(player) {
    return [...this.mapBoxes(), ...this.playerBoxes(player)];
  }

  mapBoxes() {
    const level = this.level();
    const boxes = [...level.solids, ...level.floors];
    if (this.platform) boxes.push(this.platformRect());
    if (!this.tree.open) boxes.push(this.treeRect());
    return boxes;
  }

  playerBoxes(player) {
    const boxes = [];
    for (const other of this.players.values()) {
      if (other.id !== player.id && other.level === this.currentLevel) boxes.push({ name: 'player', ...this.catRect(other) });
    }
    return boxes;
  }

  catRect(player, x = player.x, y = player.y) {
    return { x: x - cat.w * 0.5, y: y - cat.h, w: cat.w, h: cat.h };
  }

  potionRect() {
    return { x: this.potion.x - this.potion.w * 0.5, y: this.potion.y - this.potion.h * 0.5, w: this.potion.w, h: this.potion.h };
  }

  treeRect() {
    return { name: 'tree', x: this.tree.x, y: this.tree.y, w: this.tree.w, h: this.tree.h };
  }

  platformRect() {
    return { name: 'platform', x: this.platform.x, y: this.platform.y, w: this.platform.w, h: this.platform.h };
  }

  buttonRect() {
    return { name: 'button', x: this.button.x, y: this.button.y, w: this.button.w, h: this.button.h };
  }

  touchesClosedTreeWithPotion(player, rect) {
    return !this.tree.open && !this.potion.consumed && this.potion.carrierId === player.id && rectsTouch(rect, this.treeRect());
  }

  countPlayersPastDoor() {
    let total = 0;
    for (const p of this.players.values()) if (p.crossedDoor || p.crossedLevel2) total++;
    return total;
  }

  playersForClient() {
    return [...this.players.values()].map(p => ({
      id: p.id,
      nickname: p.nickname,
      cat: p.cat,
      level: p.level,
      x: round(p.x),
      y: round(p.y),
      vx: round(p.vx),
      vy: round(p.vy),
      anim: p.anim,
      facingRight: p.facingRight,
      grounded: p.grounded,
      standingOnPlayer: p.standingOnPlayer,
      hasPotion: this.potion.carrierId === p.id,
      crossedDoor: p.crossedDoor === true,
      crossedLevel2: p.crossedLevel2 === true,
      viewer: false
    }));
  }

  crossedPlayersForClient() {
    return [...this.players.values()].map(p => ({
      id: p.id,
      nickname: p.nickname,
      crossedDoor: p.crossedDoor === true,
      crossedLevel2: p.crossedLevel2 === true
    }));
  }

  worldForClient() {
    return {
      currentLevel: this.currentLevel,
      levelChangeNonce: this.levelChangeNonce,
      shouldChangeScreen: this.goal.shouldChangeScreen,
      nextLevelIndex: this.goal.nextLevelIndex,
      changeReason: this.goal.changeReason,

      potionTaken: this.potion.taken,
      potionConsumed: this.potion.consumed,
      potionCarrierId: this.potion.carrierId || '',
      potionKind: this.potion.kind || 'red',
      potionX: this.potion.x,
      potionY: this.potion.y,

      doorOpen: this.tree.open,
      treeOpening: this.tree.open && Date.now() - this.tree.openedAt < 1100,
      doorX: this.tree.x,
      doorY: this.tree.y,
      doorWidth: this.tree.w,
      doorHeight: this.tree.h,

      levelUnlocked: this.goal.unlocked,
      allPlayersPassed: this.goal.allPlayersPassed,
      crossedPlayers: this.crossedPlayersForClient(),
      totalPlayers: this.players.size,
      passedPlayers: this.countPlayersPastDoor(),

      platformX: this.platform ? this.platform.x : 0,
      platformY: this.platform ? this.platform.y : 0,
      platformWidth: this.platform ? this.platform.w : 0,
      platformHeight: this.platform ? this.platform.h : 0,
      platformActive: this.platform ? this.platform.active : false,
      buttonX: this.button ? this.button.x : 0,
      buttonY: this.button ? this.button.y : 0,
      buttonWidth: this.button ? this.button.w : 0,
      buttonHeight: this.button ? this.button.h : 0,
      buttonVisible: this.button ? this.button.visible : false,
      buttonActive: this.button ? this.button.active : false,
      stackReady: this.isStackReady()
    };
  }
}

module.exports = { GameRoom, MAX_PLAYERS, FPS, isViewer };
