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

function round(v) { return Math.round(Number(v || 0) * 100) / 100; }
function clampCat(v) { const n = Number(v || 0); return n >= 1 && n <= MAX_PLAYERS ? n : 1; }

class GameRoom {
  constructor({ log, mongo }) {
    this.log = log;
    this.mongo = mongo || {};
    this.players = new Map();
    this.nextId = 1;
    this.currentLevel = 0;
    this.levelChangeNonce = 0;
    this.lastLevelChangeAt = 0;
    this.resetWorldState();
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

  async addPlayer(msg, previousId = null) {
    const id = previousId || `p${this.nextId++}`;
    const cat = this.freeCat();
    const nickname = this.freeNick(msg.nickname);

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
      hasSentState: false,
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
      this.potionCarrierId = '';
      this.potionConsumed = false;
    }
    this.log.info(`${p.nickname} sale (${reason})`);
    if (this.players.size === 0) this.resetAll();
    return true;
  }

  resetAll() {
    this.currentLevel = 0;
    this.levelChangeNonce = 0;
    this.lastLevelChangeAt = 0;
    this.resetWorldState();
  }

  resetPlayersAndWorld() {
    this.players.clear();
    this.resetAll();
  }

  resetWorldState() {
    this.potionTaken = false;
    this.potionConsumed = false;
    this.potionCarrierId = '';
    this.doorOpen = false;
    this.treeOpenedAt = 0;
    this.levelUnlocked = false;
    this.allPlayersPassed = false;
    this.platformActive = false;
    this.buttonVisible = this.currentLevel === 1;
    this.buttonActive = false;
    this.changeReason = '';
    this.shouldChangeScreen = false;
    this.nextLevelIndex = -1;
    for (const p of this.players.values()) {
      p.level = this.currentLevel;
      p.crossedDoor = false;
      p.crossedLevel2 = false;
      p.hasSentState = false;
      p.x = 0; p.y = 0; p.vx = 0; p.vy = 0; p.anim = 'idle';
    }
  }

  setInput(playerId, msg) {
    // Ya no se usa para mover. El cliente envía CLIENT_STATE.
  }

  setMoveInput(playerId, msg) {
    // Compatibilidad antigua, no define posiciones de mapa.
  }

  setClientState(playerId, msg) {
    const p = this.players.get(playerId);
    if (!p) return;
    p.level = Number.isFinite(Number(msg.level)) ? Number(msg.level) : this.currentLevel;
    p.x = round(msg.x);
    p.y = round(msg.y);
    p.vx = round(msg.vx);
    p.vy = round(msg.vy);
    p.anim = String(msg.anim || 'idle');
    p.facingRight = msg.facingRight !== false;
    p.grounded = msg.grounded === true;
    p.standingOnPlayer = msg.standingOnPlayer === true;
    p.hasSentState = true;
  }

  handleClientEvent(playerId, msg) {
    const p = this.players.get(playerId);
    if (!p) return;
    const event = String(msg.event || '').toUpperCase();
    const level = Number.isFinite(Number(msg.level)) ? Number(msg.level) : this.currentLevel;
    if (level !== this.currentLevel && event !== 'READY_LEVEL') return;

    if (event === 'TAKE_POTION') {
      if (!this.potionTaken && !this.potionConsumed) {
        this.potionTaken = true;
        this.potionCarrierId = playerId;
        this.log.info(`${p.nickname} coge la pocion`);
      }
      return;
    }

    if (event === 'OPEN_TREE') {
      if (!this.doorOpen && this.potionCarrierId === playerId) {
        this.potionTaken = true;
        this.potionConsumed = true;
        this.potionCarrierId = '';
        this.doorOpen = true;
        this.treeOpenedAt = Date.now();
        this.levelUnlocked = true;
        this.allPlayersPassed = false;
        for (const player of this.players.values()) {
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
        this.buttonVisible = true;
        this.buttonActive = true;
        this.platformActive = true;
        this.log.info(`${p.nickname} activa la plataforma movil`);
      }
      return;
    }

    if (event === 'FELL') {
      this.log.info(`${p.nickname} cae al precipicio`);
      return;
    }

    if (event === 'CROSSED_DOOR') {
      if (this.currentLevel === 0 && this.doorOpen && !p.crossedDoor) {
        p.crossedDoor = true;
        this.log.info(`${p.nickname} ha cruzado el arbol`);
        this.checkLevel0Finished();
      }
      return;
    }

    if (event === 'CROSSED_LEVEL') {
      if (this.currentLevel === 1 && !p.crossedLevel2) {
        p.crossedLevel2 = true;
        this.log.info(`${p.nickname} ha cruzado el segundo nivel`);
        this.checkLevel1Finished();
      }
    }
  }

  tick() {
    // El servidor solo mantiene estado compartido; no simula mapa ni objetos.
    if (this.shouldChangeScreen && Date.now() - this.lastLevelChangeAt > 15000) {
      this.shouldChangeScreen = false;
      this.nextLevelIndex = -1;
    }
  }

  checkLevel0Finished() {
    const everyone = this.players.size > 0 && [...this.players.values()].every(p => p.crossedDoor);
    if (everyone && !this.allPlayersPassed) this.changeToLevel(1, 'ALL_PLAYERS_CROSSED_TREE');
  }

  checkLevel1Finished() {
    const everyone = this.players.size > 0 && [...this.players.values()].every(p => p.crossedLevel2);
    if (everyone && !this.allPlayersPassed) {
      this.allPlayersPassed = true;
      this.shouldChangeScreen = true;
      this.nextLevelIndex = -1;
      this.changeReason = 'ALL_PLAYERS_CROSSED_LEVEL_2';
      this.lastLevelChangeAt = Date.now();
      this.log.info('Todos los jugadores han cruzado el segundo nivel.');
      if (this.mongo.finishMatch) this.mongo.finishMatch().catch(() => {});
    }
  }

  changeToLevel(nextLevel, reason) {
    this.currentLevel = nextLevel;
    this.levelChangeNonce++;
    this.shouldChangeScreen = true;
    this.nextLevelIndex = nextLevel;
    this.lastLevelChangeAt = Date.now();
    this.resetWorldState();
    this.shouldChangeScreen = true;
    this.nextLevelIndex = nextLevel;
    this.changeReason = reason;
    this.log.info(`Cambiando al nivel ${nextLevel}`);
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
      cat: clampCat(p.cat),
      level: p.level,
      x: round(p.x),
      y: round(p.y),
      vx: round(p.vx),
      vy: round(p.vy),
      anim: p.anim || 'idle',
      facingRight: p.facingRight !== false,
      grounded: p.grounded === true,
      standingOnPlayer: p.standingOnPlayer === true,
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
      shouldChangeScreen: this.shouldChangeScreen === true,
      nextLevelIndex: this.nextLevelIndex == null ? -1 : this.nextLevelIndex,
      changeReason: this.changeReason || '',
      potionTaken: this.potionTaken === true,
      potionConsumed: this.potionConsumed === true,
      potionCarrierId: this.potionCarrierId || '',
      potionKind: this.currentLevel === 1 ? 'green' : 'red',
      doorOpen: this.doorOpen === true,
      treeOpening: this.doorOpen && Date.now() - this.treeOpenedAt < 1600,
      levelUnlocked: this.levelUnlocked === true,
      allPlayersPassed: this.allPlayersPassed === true,
      totalPlayers: this.players.size,
      passedPlayers: this.countPlayersPastDoor(),
      stackReady: [...this.players.values()].some(p => p.standingOnPlayer),
      platformActive: this.platformActive === true,
      buttonVisible: this.currentLevel === 1,
      buttonActive: this.buttonActive === true
    };
  }
}

module.exports = { GameRoom, MAX_PLAYERS, FPS, isViewer };
