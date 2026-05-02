const MAX_PLAYERS = 8;
const FPS = 30;
const DT = 1 / FPS;

const map = { width: 320, height: 180, floorY: 176 };

// x/y del jugador representa el centro inferior del gato.
const cat = { w: 26, h: 28, speed: 90, gravity: 900, jump: 310, maxFall: 520 };

// Ajustado al tamaño real al que queréis ver la poción en el juego.
const potionStart = { x: 181, y: 118, w: 18, h: 18 };

// Árbol cerrado. Mientras no esté curado, bloquea el paso.
const treeStart = { x: 241, y: 90, w: 90, h: 90 };

// Obstáculos del mapa. La rampa se trata como caja sólida.
const solidZones = [
  { name: 'rampa', x: 126, y: 132, w: 112, h: 48 }
];

const spawns = [
  { x: 22, y: 148 }, { x: 50, y: 148 }, { x: 78, y: 148 }, { x: 106, y: 148 },
  { x: 134, y: 148 }, { x: 162, y: 148 }, { x: 190, y: 148 }, { x: 218, y: 148 }
];

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function round(v) {
  return Math.round(v * 100) / 100;
}

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

    this.potion = { ...potionStart, taken: false, carrierId: null, consumed: false };
    this.tree = { ...treeStart, open: false, openedAt: 0 };
    this.goal = {
      unlocked: false,
      allPlayersPassed: false,
      shouldChangeScreen: false,
      crossedAt: 0,
      changeReason: ''
    };

    // El cruce cuenta cuando el gato pasa el punto donde antes chocaba con el árbol.
    this.doorCrossX = this.tree.x;
  }

  getPlayerCount() {
    return this.players.size;
  }

  isFull() {
    return this.players.size >= MAX_PLAYERS;
  }

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
    for (let i = 1; i <= MAX_PLAYERS; i++) {
      if (!used.has(i)) return i;
    }
    return 1;
  }

  async addPlayer(msg, previousId = null) {
    const id = previousId || `p${this.nextId++}`;
    const catId = this.freeCat();
    const spawn = spawns[catId - 1] || spawns[0];
    const nickname = this.freeNick(msg.nickname);

    if (this.players.size === 0 && this.mongo.startMatch) {
      await this.mongo.startMatch();
    }

    const jugadorDoc = this.mongo.upsertJugador
      ? await this.mongo.upsertJugador(nickname)
      : null;

    const player = {
      id,
      nickname,
      cat: catId,
      x: spawn.x,
      y: spawn.y,
      vx: 0,
      vy: 0,
      grounded: true,
      facingRight: true,
      anim: 'idle',
      crossedDoor: false,
      mongoId: jugadorDoc ? jugadorDoc._id : null,
      input: { moveX: 0, jumpPressed: false, jumpHeld: false }
    };

    this.players.set(id, player);

    if (this.mongo.registerPlayerInMatch) {
      await this.mongo.registerPlayerInMatch(player.mongoId);
    }

    this.log.info(`${player.nickname} entra como cat${player.cat}`);
    return player;
  }

  removePlayer(id, reason) {
    const player = this.players.get(id);
    if (!player) return false;

    this.players.delete(id);

    if (this.potion.carrierId === id) {
      this.resetWorld();
    }

    this.log.info(`${player.nickname} sale (${reason})`);

    if (this.players.size === 0) {
      this.resetWorld();
    }

    return true;
  }

  resetWorld() {
    this.potion.taken = false;
    this.potion.carrierId = null;
    this.potion.consumed = false;

    this.tree.open = false;
    this.tree.openedAt = 0;

    this.goal.unlocked = false;
    this.goal.allPlayersPassed = false;
    this.goal.shouldChangeScreen = false;
    this.goal.crossedAt = 0;
    this.goal.changeReason = '';

    for (const player of this.players.values()) {
      player.crossedDoor = false;
    }
  }

  resetPlayersAndWorld() {
    this.players.clear();
    this.resetWorld();
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

  handleClientEvent(playerId, msg) {
    const player = this.players.get(playerId);
    if (!player) return;

    const event = String(msg.event || '').toUpperCase();

    // El cliente conoce la posición real del árbol por sus JSON/assets.
    // Si el cliente que lleva la poción dice que ha tocado el árbol, el server
    // solo valida que realmente sea el portador y abre el paso para todos.
    if (event === 'OPEN_TREE') {
      if (!this.tree.open && this.potion.carrierId === player.id) {
        this.openTreeWithPotion(player);
      }
      return;
    }

    if (event === 'CROSSED_TREE') {
      if (this.goal.unlocked && !player.crossedDoor) {
        player.crossedDoor = true;
        this.log.info(`${player.nickname} ha cruzado el arbol`);
      }
    }
  }

  tick() {
    for (const player of this.players.values()) {
      this.updatePlayer(player);
    }
    this.updateGoalState();
  }

  updatePlayer(player) {
    const input = player.input || { moveX: 0, jumpPressed: false, jumpHeld: false };
    const move = clamp(Number(input.moveX || 0), -1, 1);

    player.vx = move * cat.speed;
    if (move < 0) player.facingRight = false;
    if (move > 0) player.facingRight = true;

    player.grounded = this.isStandingOnSomething(player);

    if (input.jumpPressed && player.grounded) {
      player.vy = -cat.jump;
      player.grounded = false;
    }
    input.jumpPressed = false;

    if (!player.grounded) {
      player.vy = Math.min(cat.maxFall, player.vy + cat.gravity * DT);
    }

    this.moveX(player, player.vx * DT);
    this.moveY(player, player.vy * DT);

    const playerRect = this.catRect(player);

    if (!this.potion.taken && !this.potion.consumed && rectsTouch(playerRect, this.potionRect())) {
      this.potion.taken = true;
      this.potion.carrierId = player.id;
      this.log.info(`${player.nickname} coge la pocion`);
    }

    if (!this.tree.open && this.potion.carrierId === player.id && rectsTouch(playerRect, this.treeRect())) {
      this.openTreeWithPotion(player);
    }

    player.x = clamp(player.x, cat.w * 0.5, map.width - cat.w * 0.5);
    player.y = clamp(player.y, 0, map.floorY);
    player.anim = !player.grounded ? 'jump' : (Math.abs(player.vx) > 1 ? 'run' : 'idle');
  }

  openTreeWithPotion(player) {
    this.potion.taken = true;
    this.potion.consumed = true;
    this.potion.carrierId = null;

    this.tree.open = true;
    this.tree.openedAt = Date.now();

    this.goal.unlocked = true;
    this.goal.allPlayersPassed = false;
    this.goal.shouldChangeScreen = false;
    this.goal.changeReason = '';

    for (const p of this.players.values()) {
      p.crossedDoor = false;
    }

    this.log.info(`${player.nickname} cura el arbol con la pocion`);

    if (player.mongoId && this.mongo.markPotionObtained) {
      this.mongo.markPotionObtained(player.mongoId).catch(() => {});
    }
  }

  updateGoalState() {
    if (!this.goal.unlocked) {
      this.goal.allPlayersPassed = false;
      this.goal.shouldChangeScreen = false;
      return;
    }

    for (const player of this.players.values()) {
      const playerLeft = player.x - cat.w * 0.5;
      if (!player.crossedDoor && playerLeft >= this.doorCrossX) {
        player.crossedDoor = true;
        this.log.info(`${player.nickname} ha cruzado el arbol`);
      }
    }

    const hasPlayers = this.players.size > 0;
    const everyonePassed = hasPlayers && [...this.players.values()].every(p => p.crossedDoor === true);

    if (everyonePassed && !this.goal.shouldChangeScreen) {
      this.goal.allPlayersPassed = true;
      this.goal.shouldChangeScreen = true;
      this.goal.crossedAt = Date.now();
      this.goal.changeReason = 'ALL_PLAYERS_CROSSED_TREE';
      this.log.info('Todos los jugadores han cruzado el arbol. La app ya puede preparar el cambio de pantalla.');

      if (this.mongo.finishMatch) {
        this.mongo.finishMatch().catch(() => {});
      }
      return;
    }

    if (!everyonePassed) {
      this.goal.allPlayersPassed = false;
      this.goal.shouldChangeScreen = false;
      this.goal.changeReason = '';
    }
  }

  moveX(player, dx) {
    if (dx === 0) return;

    let nextX = player.x + dx;
    let rect = this.catRect(player, nextX, player.y);

    if (this.touchesClosedTreeWithPotion(player, rect)) {
      this.openTreeWithPotion(player);
    }

    for (const box of this.collisionBoxes(player)) {
      if (!rectsTouch(rect, box)) continue;

      if (dx > 0) nextX = box.x - cat.w * 0.5;
      else nextX = box.x + box.w + cat.w * 0.5;

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

    if (this.touchesClosedTreeWithPotion(player, rect)) {
      this.openTreeWithPotion(player);
    }

    for (const box of this.collisionBoxes(player)) {
      if (!rectsTouch(rect, box)) continue;

      if (dy > 0) {
        nextY = box.y;
        player.grounded = true;
      } else {
        nextY = box.y + box.h + cat.h;
      }

      player.vy = 0;
      rect = this.catRect(player, player.x, nextY);
    }

    if (nextY >= map.floorY) {
      nextY = map.floorY;
      player.vy = 0;
      player.grounded = true;
    }

    player.y = clamp(nextY, 0, map.floorY);
  }

  isStandingOnSomething(player) {
    if (Math.abs(player.y - map.floorY) <= 0.5) return true;

    const foot = { x: player.x - cat.w * 0.5 + 1, y: player.y, w: cat.w - 2, h: 1.5 };
    for (const box of this.collisionBoxes(player)) {
      const top = { x: box.x, y: box.y - 0.5, w: box.w, h: 1.5 };
      if (rectsTouch(foot, top)) return true;
    }
    return false;
  }

  touchesClosedTreeWithPotion(player, rect) {
    return !this.tree.open && !this.potion.consumed && this.potion.carrierId === player.id && rectsTouch(rect, this.treeRect());
  }

  collisionBoxes(player) {
    return [...this.mapBoxes(), ...this.playerBoxes(player)];
  }

  mapBoxes() {
    const boxes = [
      { name: 'left_wall', x: -50, y: -100, w: 50, h: 400 },
      { name: 'right_wall', x: map.width, y: -100, w: 50, h: 400 },
      ...solidZones
    ];

    if (!this.tree.open) {
      boxes.push(this.treeRect());
    }

    return boxes;
  }

  playerBoxes(player) {
    const boxes = [];
    for (const other of this.players.values()) {
      if (other.id !== player.id) boxes.push({ name: 'player', ...this.catRect(other) });
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

  countPlayersPastDoor() {
    let total = 0;
    for (const p of this.players.values()) {
      if (p.crossedDoor === true) total++;
    }
    return total;
  }

  playersForClient() {
    return [...this.players.values()].map(p => ({
      id: p.id,
      nickname: p.nickname,
      cat: p.cat,
      x: round(p.x),
      y: round(p.y),
      vx: round(p.vx),
      vy: round(p.vy),
      anim: p.anim,
      facingRight: p.facingRight,
      grounded: p.grounded,
      hasPotion: this.potion.carrierId === p.id,
      crossedDoor: p.crossedDoor === true,
      viewer: false
    }));
  }

  crossedPlayersForClient() {
    return [...this.players.values()].map(p => ({
      id: p.id,
      nickname: p.nickname,
      crossedDoor: p.crossedDoor === true
    }));
  }

  worldForClient() {
    return {
      potionTaken: this.potion.taken,
      potionConsumed: this.potion.consumed,
      potionCarrierId: this.potion.carrierId || '',
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
      shouldChangeScreen: this.goal.shouldChangeScreen,
      crossedPlayers: this.crossedPlayersForClient(),
      totalPlayers: this.players.size,
      passedPlayers: this.countPlayersPastDoor(),
      changeReason: this.goal.changeReason
    };
  }
}

module.exports = {
  GameRoom,
  MAX_PLAYERS,
  FPS,
  isViewer
};
