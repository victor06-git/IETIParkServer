const MAX_PLAYERS = 8;
const FPS = 30;

function cleanNick(value) {
  const nick = String(value || 'Player').trim().replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 16);
  return nick || 'Player';
}

function isViewer(msg) {
  const text = String(msg.client || msg.role || '').toLowerCase();
  return msg.viewer === true || text.includes('viewer') || text.includes('flutter');
}

function num(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function round(v) {
  return Math.round(num(v) * 100) / 100;
}

class GameRoom {
  constructor({ log, mongo }) {
    this.log = log;
    this.mongo = mongo || {};
    this.players = new Map();
    this.nextId = 1;
    this.currentLevel = 0;
    this.levelChangeNonce = 0;
    this.lastLevelChangeAt = 0;
    this.resetWorld();
  }

  isFull() { return this.players.size >= MAX_PLAYERS; }
  getPlayerCount() { return this.players.size; }

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

  resetWorld() {
    this.potionTaken = false;
    this.potionConsumed = false;
    this.potionCarrierId = '';
    this.treeOpen = false;
    this.treeOpenedAt = 0;
    this.buttonActive = false;
    this.platformActive = false;
    this.goal = {
      unlocked: false,
      allPlayersPassed: false,
      shouldChangeScreen: false,
      nextLevelIndex: -1,
      levelChangeNonce: this.levelChangeNonce,
      crossedAt: 0,
      changeReason: ''
    };
  }

  resetPlayersAndWorld() {
    this.players.clear();
    this.currentLevel = 0;
    this.levelChangeNonce = 0;
    this.resetWorld();
  }

  async addPlayer(msg, previousId = null) {
    const id = previousId || `p${this.nextId++}`;
    const nickname = this.freeNick(msg.nickname);
    const cat = this.freeCat();

    if (this.players.size === 0 && this.mongo.startMatch) await this.mongo.startMatch();
    const jugadorDoc = this.mongo.upsertJugador ? await this.mongo.upsertJugador(nickname) : null;

    const player = {
      id,
      nickname,
      cat,
      level: this.currentLevel,
      x: 0,
      y: 0,
      vx: 0,
      vy: 0,
      anim: 'idle',
      facingRight: true,
      grounded: true,
      standingOnPlayer: false,
      hasPotion: false,
      crossedDoor: false,
      crossedLevel2: false,
      mongoId: jugadorDoc ? jugadorDoc._id : null
    };

    this.players.set(id, player);
    if (this.mongo.registerPlayerInMatch) await this.mongo.registerPlayerInMatch(player.mongoId);
    this.log.info(`${player.nickname} entra como cat${player.cat}`);
    return player;
  }

  removePlayer(id, reason) {
    const p = this.players.get(id);
    if (!p) return false;
    this.players.delete(id);
    if (this.potionCarrierId === id) {
      this.potionTaken = false;
      this.potionConsumed = false;
      this.potionCarrierId = '';
      for (const other of this.players.values()) other.hasPotion = false;
    }
    this.log.info(`${p.nickname} sale (${reason})`);
    if (this.players.size === 0) {
      this.currentLevel = 0;
      this.levelChangeNonce = 0;
      this.resetWorld();
    }
    return true;
  }

  setInput() {
    // El mapa y las físicas viven en el cliente. Se mantiene por compatibilidad.
  }

  setMoveInput() {
    // Compatibilidad con clientes antiguos.
  }

  updatePlayerState(playerId, msg) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.level = Math.max(0, Math.floor(num(msg.level, this.currentLevel)));
    p.x = round(msg.x);
    p.y = round(msg.y);
    p.vx = round(msg.vx);
    p.vy = round(msg.vy);
    p.anim = String(msg.anim || p.anim || 'idle');
    p.facingRight = msg.facingRight !== false;
    p.grounded = msg.grounded === true;
    p.standingOnPlayer = msg.standingOnPlayer === true;
  }

  handleClientEvent(playerId, msg) {
    const p = this.players.get(playerId);
    if (!p) return;
    const event = String(msg.event || '').toUpperCase();
    const level = Math.max(0, Math.floor(num(msg.level, this.currentLevel)));
    if (level !== this.currentLevel) return;

    p.x = round(msg.x != null ? msg.x : p.x);
    p.y = round(msg.y != null ? msg.y : p.y);

    if (event === 'FELL') {
      p.vx = 0;
      p.vy = 0;
      p.anim = 'idle';
      p.grounded = true;
      this.log.info(`${p.nickname} cae y vuelve al inicio`);
      return;
    }

    if (event === 'TAKE_POTION') {
      if (!this.potionTaken && !this.potionConsumed) {
        this.potionTaken = true;
        this.potionCarrierId = p.id;
        p.hasPotion = true;
        this.log.info(`${p.nickname} coge la pocion`);
      }
      return;
    }

    if (event === 'OPEN_TREE') {
      if (!this.treeOpen && this.potionCarrierId === p.id) {
        this.potionTaken = true;
        this.potionConsumed = true;
        this.potionCarrierId = '';
        this.treeOpen = true;
        this.treeOpenedAt = Date.now();
        this.goal.unlocked = true;
        for (const player of this.players.values()) {
          player.hasPotion = false;
          player.crossedDoor = false;
          player.crossedLevel2 = false;
        }
        this.log.info(`${p.nickname} cura el arbol con la pocion`);
        if (p.mongoId && this.mongo.markPotionObtained) this.mongo.markPotionObtained(p.mongoId).catch(() => {});
      }
      return;
    }

    if (event === 'BUTTON_PRESSED') {
      if (this.currentLevel === 1 && !this.buttonActive) {
        this.buttonActive = true;
        this.platformActive = true;
        this.log.info(`${p.nickname} activa la plataforma movil`);
      }
      return;
    }

    if (event === 'CROSSED_DOOR') {
      if (this.currentLevel === 0 && this.treeOpen && !p.crossedDoor) {
        p.crossedDoor = true;
        this.log.info(`${p.nickname} ha cruzado el arbol`);
        this.checkLevel0Complete();
      }
      return;
    }

    if (event === 'CROSSED_LEVEL') {
      if (this.currentLevel === 1 && this.treeOpen && !p.crossedLevel2) {
        p.crossedLevel2 = true;
        this.log.info(`${p.nickname} ha cruzado el segundo nivel`);
        this.checkLevel1Complete();
      }
    }
  }

  checkLevel0Complete() {
    const everyone = this.players.size > 0 && [...this.players.values()].every(p => p.crossedDoor === true);
    if (!everyone || this.goal.allPlayersPassed) return;
    this.goal.allPlayersPassed = true;
    this.changeToLevel(1, 'ALL_PLAYERS_CROSSED_TREE');
  }

  checkLevel1Complete() {
    const everyone = this.players.size > 0 && [...this.players.values()].every(p => p.crossedLevel2 === true);
    if (!everyone || this.goal.allPlayersPassed) return;
    this.goal.allPlayersPassed = true;
    this.goal.shouldChangeScreen = true;
    this.goal.nextLevelIndex = -1;
    this.goal.changeReason = 'ALL_PLAYERS_CROSSED_LEVEL_2';
    this.goal.crossedAt = Date.now();
    this.lastLevelChangeAt = Date.now();
    this.log.info('Todos los jugadores han cruzado el segundo nivel.');
    if (this.mongo.finishMatch) this.mongo.finishMatch().catch(() => {});
  }

  changeToLevel(nextLevelIndex, reason) {
    this.currentLevel = nextLevelIndex;
    this.levelChangeNonce++;
    this.lastLevelChangeAt = Date.now();
    this.resetWorld();
    this.goal.shouldChangeScreen = true;
    this.goal.nextLevelIndex = nextLevelIndex;
    this.goal.levelChangeNonce = this.levelChangeNonce;
    this.goal.changeReason = reason;
    for (const p of this.players.values()) {
      p.level = nextLevelIndex;
      p.crossedDoor = false;
      p.crossedLevel2 = false;
      p.hasPotion = false;
      p.vx = 0;
      p.vy = 0;
      p.anim = 'idle';
    }
    this.log.info(`Todos los jugadores han cruzado el arbol. Cambiando al nivel ${nextLevelIndex}`);
  }

  tick() {
    if (this.goal.shouldChangeScreen && Date.now() - this.lastLevelChangeAt > 15000) {
      this.goal.shouldChangeScreen = false;
      this.goal.nextLevelIndex = -1;
    }
  }

  countPassed() {
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
      hasPotion: this.potionCarrierId === p.id,
      crossedDoor: p.crossedDoor === true,
      crossedLevel2: p.crossedLevel2 === true,
      viewer: false
    }));
  }

  worldForClient() {
    return {
      currentLevel: this.currentLevel,
      levelChangeNonce: this.levelChangeNonce,
      shouldChangeScreen: this.goal.shouldChangeScreen,
      nextLevelIndex: this.goal.nextLevelIndex,
      changeReason: this.goal.changeReason,

      potionTaken: this.potionTaken,
      potionConsumed: this.potionConsumed,
      potionCarrierId: this.potionCarrierId || '',
      potionKind: this.currentLevel === 1 ? 'green' : 'red',
      potionX: 0,
      potionY: 0,

      doorOpen: this.treeOpen,
      treeOpening: this.treeOpen && Date.now() - this.treeOpenedAt < 1400,
      doorX: 0,
      doorY: 0,
      doorWidth: 0,
      doorHeight: 0,

      levelUnlocked: this.goal.unlocked,
      allPlayersPassed: this.goal.allPlayersPassed,
      totalPlayers: this.players.size,
      passedPlayers: this.countPassed(),
      stackReady: [...this.players.values()].some(p => p.standingOnPlayer),

      platformX: 0,
      platformY: 0,
      platformWidth: 0,
      platformHeight: 0,
      platformActive: this.platformActive,
      buttonX: 0,
      buttonY: 0,
      buttonWidth: 0,
      buttonHeight: 0,
      buttonVisible: this.currentLevel === 1,
      buttonActive: this.buttonActive
    };
  }
}

module.exports = { GameRoom, MAX_PLAYERS, FPS, isViewer };
