const fs = require('fs');
const path = require('path');

const MAX_PLAYERS = 8;
const FPS = 30;
const DT = 1 / FPS;
const LEVEL0_ADVANCE_DELAY_MS = 2000;
const RESPAWN_FIRST_DELAY_MS = 300;
const RESPAWN_CHAIN_DELAY_MS = 650;
const RESPAWN_DROP_HEIGHT = 86;

const cat = { w: 26, h: 28, speed: 90, gravity: 900, jump: 310, maxFall: 520 };

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
function normalize(value) {
  return String(value || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}
function hasAny(value, words) {
  const text = normalize(value);
  return words.some(w => text.includes(w));
}
function isViewer(msg) {
  const text = String(msg.client || msg.role || '').toLowerCase();
  return msg.viewer === true || text.includes('viewer') || text.includes('flutter');
}
function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
function exists(file) {
  try { return fs.existsSync(file); } catch (_) { return false; }
}
function findAssetsRoot() {
  const candidates = [
    path.join(__dirname, 'assets'),
    path.join(__dirname, 'assets', 'levels'),
    __dirname,
    path.join(process.cwd(), 'server', 'assets'),
    path.join(process.cwd(), 'server', 'assets', 'levels'),
    path.join(process.cwd(), 'server'),
    path.join(process.cwd(), 'assets'),
    path.join(process.cwd(), 'assets', 'levels'),
    process.cwd()
  ];
  for (const dir of candidates) {
    if (exists(path.join(dir, 'game_data.json'))) return dir;
  }
  return __dirname;
}
function resolveAssetPath(root, relativePath) {
  if (!relativePath) return null;
  const clean = String(relativePath).replace(/^levels\//, '');
  const candidates = [
    path.join(root, clean),
    path.join(root, 'assets', clean),
    path.join(root, 'assets', 'levels', clean),
    path.join(root, path.basename(clean)),
    path.join(root, clean.replace(/^animations\//, '')),
    path.join(root, 'animations', path.basename(clean)),
    path.join(root, 'zones', path.basename(clean)),
    path.join(root, 'paths', path.basename(clean)),
    path.join(root, 'tilemaps', path.basename(clean))
  ];
  return candidates.find(exists) || candidates[0];
}
function firstExisting(paths) { return paths.find(exists) || null; }

class AssetLevelProvider {
  constructor(log) {
    this.log = log || console;
    this.root = findAssetsRoot();
    this.gameData = null;
    this.animationsById = new Map();
    this.levels = [];
    this.load();
  }

  load() {
    const gameDataPath = path.join(this.root, 'game_data.json');
    this.gameData = readJson(gameDataPath);
    this.loadAnimations();
    const levels = Array.isArray(this.gameData.levels) ? this.gameData.levels : [];
    this.levels = levels.map((node, index) => this.parseLevel(node, index));
    if (this.log && this.log.info) this.log.info(`Assets de servidor cargados desde ${this.root} (${this.levels.length} niveles)`);
  }

  loadAnimations() {
    const explicit = this.gameData.animationsFile ? resolveAssetPath(this.root, this.gameData.animationsFile) : null;
    const candidates = [
      explicit,
      path.join(this.root, 'animations.json'),
      path.join(this.root, 'animations', 'animations.json')
    ].filter(Boolean);
    const file = firstExisting(candidates);
    if (!file) return;
    const root = readJson(file);
    for (const anim of root.animations || []) {
      if (anim && anim.id) this.animationsById.set(anim.id, anim);
    }
  }

  parseLevel(levelNode, index) {
    const viewportWidth = Number(levelNode.viewportWidth || 320);
    const viewportHeight = Number(levelNode.viewportHeight || 180);
    const zones = this.loadZones(levelNode.zonesFile);
    const paths = this.loadPaths(levelNode.pathsFile);
    const sprites = (levelNode.sprites || []).map(s => this.parseSprite(s));
    const layers = (levelNode.layers || []).map(l => this.parseLayer(l)).filter(Boolean);

    let width = viewportWidth;
    let height = viewportHeight;
    for (const z of zones) { width = Math.max(width, z.x + z.w); height = Math.max(height, z.y + z.h); }
    for (const s of sprites) { width = Math.max(width, s.rect.x + s.rect.w); height = Math.max(height, s.rect.y + s.rect.h); }

    const floorZones = zones.filter(z => hasAny(`${z.type} ${z.name}`, ['floor', 'platforma', 'plataforma']));
    const wallZones = zones.filter(z => hasAny(`${z.type} ${z.name}`, ['mur', 'wall', 'limit', 'solid', 'bloc', 'block']));
    const deathZones = zones.filter(z => hasAny(`${z.type} ${z.name}`, ['death', 'dead_zone', 'precipici', 'pit']));
    const treeZone = zones.find(z => hasAny(`${z.type} ${z.name}`, ['arbre', 'tree']));
    const platformZone = zones.find(z => hasAny(`${z.type} ${z.name}`, ['platform', 'plataforma']));
    const platformPath = (paths.find(p => hasAny(p.name, ['platform', 'plataforma'])) || paths[0] || { points: [] }).points || [];
    const treeSprite = sprites.find(s => hasAny(`${s.type} ${s.name}`, ['tree', 'arbre']));
    const potionSprite = sprites.find(s => hasAny(`${s.type} ${s.name}`, ['potion', 'pocio']));
    const buttonSprite = sprites.find(s => hasAny(`${s.type} ${s.name}`, ['button', 'boto', 'boton']));
    const catSprites = sprites.filter(s => hasAny(`${s.type} ${s.name}`, ['cat']));

    const terrainBoxes = this.buildTerrainBoxes(layers, width, height);
    const tree = treeZone || (treeSprite ? treeSprite.rect : null);
    const potion = potionSprite ? { x: potionSprite.x, y: potionSprite.y, w: Math.min(18, potionSprite.rect.w || 18), h: Math.min(18, potionSprite.rect.h || 18) } : { x: 0, y: 0, w: 18, h: 18 };
    const button = buttonSprite ? { x: buttonSprite.x, y: buttonSprite.y, w: Math.max(16, Math.min(28, buttonSprite.rect.w || 20)), h: Math.max(12, Math.min(24, buttonSprite.rect.h || 16)) } : null;
    const platform = platformZone ? { ...platformZone } : null;
    const floorY = this.resolveFloorY(floorZones, terrainBoxes, viewportHeight);
    // Solo tratamos como colisión los tiles de terreno cercanos a la zona jugable.
    // Evita que decoración/techo del tilemap se convierta en pared invisible.
    const relevantTerrainBoxes = (platform || deathZones.length > 0) ? [] : terrainBoxes.filter(b => b.y >= floorY - 70);

    const solidZones = [];
    solidZones.push(...wallZones);
    solidZones.push(...floorZones.filter(z => !platform || z !== platformZone));
    solidZones.push(...relevantTerrainBoxes);

    const spawns = this.buildSpawns(catSprites, floorZones, floorY, width, tree);
    const doorCrossX = tree ? tree.x : width - cat.w;

    let platformStart = platform;
    if (platformStart && platformPath.length > 0) {
      const first = platformPath[0];
      platformStart = { ...platformStart, x: first.x - platformStart.w * 0.5, y: first.y - platformStart.h * 0.5 };
    }

    return {
      index,
      name: levelNode.name || `Level ${index}`,
      width,
      height,
      floorY,
      potion,
      tree: tree ? { name: tree.name || 'tree', x: tree.x, y: tree.y, w: tree.w, h: tree.h } : { x: width - 80, y: floorY - 90, w: 80, h: 90 },
      doorCrossX,
      solidZones,
      deathZones,
      platformStart,
      platformPath,
      platformSpeed: 32,
      button,
      potionOffsetFromPlatform: platformStart && potionSprite ? { x: potionSprite.x - platformStart.x, y: potionSprite.y - platformStart.y } : null,
      buttonOffsetFromPlatform: platformStart && buttonSprite ? { x: buttonSprite.x - platformStart.x, y: buttonSprite.y - platformStart.y } : null,
      spawns
    };
  }

  parseSprite(spriteNode) {
    const animation = spriteNode.animationId ? this.animationsById.get(spriteNode.animationId) : null;
    const startFrame = animation ? Number(animation.startFrame || 0) : 0;
    const rig = animation && Array.isArray(animation.frameRigs)
      ? animation.frameRigs.find(r => Number(r.frame) === startFrame) || animation.frameRigs[0]
      : null;
    const anchorX = Number(rig && Number.isFinite(Number(rig.anchorX)) ? rig.anchorX : (animation && animation.anchorX != null ? animation.anchorX : 0.5));
    const anchorY = Number(rig && Number.isFinite(Number(rig.anchorY)) ? rig.anchorY : (animation && animation.anchorY != null ? animation.anchorY : 0.5));
    const w = Number(spriteNode.width || 0);
    const h = Number(spriteNode.height || 0);
    const x = Number(spriteNode.x || 0);
    const y = Number(spriteNode.y || 0);
    return {
      name: spriteNode.name || '',
      type: spriteNode.type || '',
      x, y, w, h, anchorX, anchorY,
      rect: { name: spriteNode.name || spriteNode.type || 'sprite', x: x - w * anchorX, y: y - h * anchorY, w, h }
    };
  }

  parseLayer(layerNode) {
    const tileMapFile = layerNode.tileMapFile;
    const tilesFile = layerNode.tilesSheetFile || '';
    if (!tileMapFile) return null;
    const file = resolveAssetPath(this.root, tileMapFile);
    if (!exists(file)) return null;
    const data = readJson(file);
    return {
      name: layerNode.name || '',
      tilesFile,
      x: Number(layerNode.x || 0),
      y: Number(layerNode.y || 0),
      tileWidth: Number(layerNode.tilesWidth || 0),
      tileHeight: Number(layerNode.tilesHeight || 0),
      tileMap: Array.isArray(data.tileMap) ? data.tileMap : []
    };
  }

  loadZones(zonesFile) {
    if (!zonesFile) return [];
    const file = resolveAssetPath(this.root, zonesFile);
    if (!exists(file)) return [];
    const data = readJson(file);
    return (data.zones || []).map(z => ({
      name: z.name || '', type: z.type || '', gameplayData: z.gameplayData || '',
      x: Number(z.x || 0), y: Number(z.y || 0), w: Number(z.width || 0), h: Number(z.height || 0)
    })).filter(z => z.w > 0 && z.h > 0);
  }

  loadPaths(pathsFile) {
    if (!pathsFile) return [];
    const file = resolveAssetPath(this.root, pathsFile);
    if (!exists(file)) return [];
    const data = readJson(file);
    return (data.paths || []).map(p => ({
      name: p.name || '',
      points: (p.points || []).map(pt => ({ x: Number(pt.x || 0), y: Number(pt.y || 0) }))
    })).filter(p => p.points.length > 0);
  }

  buildTerrainBoxes(layers) {
    const boxes = [];
    for (const layer of layers) {
      if (!hasAny(layer.name, ['level', 'terrain', 'suelo'])) continue;
      if (!layer.tileWidth || !layer.tileHeight || !Array.isArray(layer.tileMap)) continue;
      const rows = layer.tileMap.length;
      const visited = new Set();
      for (let r = 0; r < rows; r++) {
        const row = layer.tileMap[r] || [];
        for (let c = 0; c < row.length; c++) {
          if (Number(row[c]) < 0 || visited.has(`${r},${c}`)) continue;
          let endC = c;
          while (endC < row.length && Number(row[endC]) >= 0 && !visited.has(`${r},${endC}`)) endC++;
          for (let cc = c; cc < endC; cc++) visited.add(`${r},${cc}`);
          boxes.push({
            name: `tile_${r}_${c}`,
            x: layer.x + c * layer.tileWidth,
            y: layer.y + r * layer.tileHeight,
            w: (endC - c) * layer.tileWidth,
            h: layer.tileHeight
          });
          c = endC - 1;
        }
      }
    }
    return boxes;
  }

  resolveFloorY(floorZones, terrainBoxes, viewportHeight) {
    if (floorZones.length > 0) {
      const floorCandidates = floorZones.map(z => z.y).filter(Number.isFinite);
      if (floorCandidates.length > 0) return Math.max(...floorCandidates);
    }
    const terrainCandidates = terrainBoxes.map(b => b.y).filter(Number.isFinite);
    if (terrainCandidates.length > 0) return Math.max(...terrainCandidates);
    return viewportHeight;
  }

  buildSpawns(catSprites, floorZones, floorY, width, tree) {
    const sortedCats = [...catSprites].sort((a, b) => a.x - b.x);
    const spawnY = Number.isFinite(floorY) ? floorY : (sortedCats[0] ? sortedCats[0].y : 0);
    const spawns = sortedCats.map(s => ({
      x: clamp(s.x, cat.w * 0.5, width - cat.w * 0.5),
      y: spawnY
    }));

    const leftFloor = [...floorZones].sort((a, b) => a.x - b.x)[0];
    const spacing = Math.max(18, Math.min(28, cat.w + 2));
    let nextX;
    if (spawns.length > 0) {
      nextX = Math.max(...spawns.map(s => s.x)) + spacing;
    } else if (leftFloor) {
      nextX = leftFloor.x + cat.w * 0.5 + 4;
    } else {
      nextX = cat.w;
    }
    const minX = leftFloor ? leftFloor.x + cat.w * 0.5 : cat.w * 0.5;
    const maxXByFloor = leftFloor ? leftFloor.x + leftFloor.w - cat.w * 0.5 : width - cat.w * 0.5;
    const maxXByTree = tree ? tree.x - cat.w * 0.5 : width - cat.w * 0.5;
    const maxX = Math.max(minX, Math.min(maxXByFloor, maxXByTree, width - cat.w * 0.5));

    while (spawns.length < MAX_PLAYERS) {
      if (nextX > maxX) nextX = minX + ((spawns.length * spacing) % Math.max(spacing, maxX - minX + 1));
      spawns.push({ x: clamp(nextX, cat.w * 0.5, width - cat.w * 0.5), y: spawnY });
      nextX += spacing;
    }
    return spawns.slice(0, MAX_PLAYERS);
  }
}

class GameRoom {
  constructor({ log, mongo }) {
    this.log = log;
    this.mongo = mongo;
    this.levelProvider = new AssetLevelProvider(log);
    this.players = new Map();
    this.nextId = 1;
    this.levelIndex = 0;
    this.nextRespawnAllowedAt = 0;
    this.resetWorld();
  }

  get config() { return this.levelProvider.levels[this.levelIndex] || this.levelProvider.levels[0]; }
  get finalLevelIndex() { return Math.max(0, this.levelProvider.levels.length - 1); }
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
    const list = this.config.spawns || [{ x: cat.w, y: this.config.floorY || this.config.height }];
    return list[(catId - 1) % list.length] || list[0];
  }
  removePlayer(id, reason) {
    const player = this.players.get(id);
    if (!player) return false;
    this.players.delete(id);
    if (this.potion.carrierId === id) this.resetWorld(false);
    this.log.info(`${player.nickname} sale (${reason})`);
    if (this.players.size === 0) this.resetWorld(true);
    return true;
  }
  resetWorld(resetLevel = true) {
    if (resetLevel) this.levelIndex = 0;
    const c = this.config;
    this.potion = { ...c.potion, taken: false, carrierId: null, consumed: false };
    this.tree = { ...c.tree, open: false, openedAt: 0 };
    const p = c.platformStart || { x: 0, y: 0, w: 0, h: 0 };
    this.platform = { ...p, active: false, previousX: p.x, previousY: p.y, dx: 0, dy: 0, pathIndex: 0, pathDir: 1 };
    this.goal = { unlocked: false, allPlayersPassed: false, shouldChangeScreen: false, crossedAt: 0, changeReason: '', pendingAdvanceAt: 0 };
    this.nextRespawnAllowedAt = 0;
    for (const pl of this.players.values()) { pl.crossedDoor = false; pl.respawnPendingUntil = 0; }
  }
  resetPlayersAndWorld() { this.players.clear(); this.resetWorld(true); }
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
    const c = this.config;
    if (!c.platformStart || !this.platform.active) return;
    const pathPoints = c.platformPath || [];
    if (pathPoints.length < 2) return;
    let remaining = (c.platformSpeed || 32) * DT;
    while (remaining > 0.0001) {
      const currentCenter = this.platformCenter();
      let nextIndex = this.platform.pathIndex + this.platform.pathDir;
      if (nextIndex >= pathPoints.length) { this.platform.pathDir = -1; nextIndex = pathPoints.length - 2; }
      if (nextIndex < 0) { this.platform.pathDir = 1; nextIndex = 1; }
      const target = pathPoints[nextIndex];
      const vx = target.x - currentCenter.x;
      const vy = target.y - currentCenter.y;
      const distance = Math.sqrt(vx * vx + vy * vy);
      if (distance <= 0.0001) { this.platform.pathIndex = nextIndex; continue; }
      const step = Math.min(remaining, distance);
      const ratio = step / distance;
      this.setPlatformCenter(currentCenter.x + vx * ratio, currentCenter.y + vy * ratio);
      remaining -= step;
      if (step >= distance - 0.0001) this.platform.pathIndex = nextIndex;
    }
    this.platform.dx = this.platform.x - this.platform.previousX;
    this.platform.dy = this.platform.y - this.platform.previousY;
  }
  platformCenter() { return { x: this.platform.x + this.platform.w * 0.5, y: this.platform.y + this.platform.h * 0.5 }; }
  setPlatformCenter(x, y) { this.platform.x = x - this.platform.w * 0.5; this.platform.y = y - this.platform.h * 0.5; }
  updatePlayer(player) {
    if (this.handlePendingRespawn(player)) return;
    const input = player.input || { moveX: 0, jumpPressed: false, jumpHeld: false };
    const move = clamp(Number(input.moveX || 0), -1, 1);
    if (this.isOnMovingPlatform(player) && (this.platform.dx !== 0 || this.platform.dy !== 0)) { player.x += this.platform.dx; player.y += this.platform.dy; }
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
    this.handleInteractions(player, playerRect);
    player.x = clamp(player.x, cat.w * 0.5, this.config.width - cat.w * 0.5);
    player.anim = !player.grounded ? 'jump' : (Math.abs(player.vx) > 1 ? 'run' : 'idle');
  }
  handleInteractions(player, playerRect) {
    const c = this.config;
    for (const death of c.deathZones || []) {
      if (rectsTouch(playerRect, death) || player.y > c.height + 35) { this.scheduleRespawn(player); return; }
    }
    if (c.platformStart && !this.platform.active && rectsTouch(playerRect, this.buttonRect())) {
      this.platform.active = true;
      this.log.info(`${player.nickname} activa la plataforma movil`);
    }
    if (!this.potion.taken && !this.potion.consumed && rectsTouch(playerRect, this.potionRect())) {
      this.potion.taken = true; this.potion.carrierId = player.id;
      this.log.info(`${player.nickname} coge la pocion`);
    }
    if (!this.tree.open && this.potion.carrierId === player.id && rectsTouch(playerRect, this.treeRect())) this.openTreeWithPotion(player);
  }
  scheduleRespawn(player) {
    if (player.respawnPendingUntil && player.respawnPendingUntil > 0) return;
    const now = Date.now();
    const baseTime = Math.max(now + RESPAWN_FIRST_DELAY_MS, this.nextRespawnAllowedAt || 0);
    player.respawnPendingUntil = baseTime;
    this.nextRespawnAllowedAt = baseTime + RESPAWN_CHAIN_DELAY_MS;
    player.x = clamp(player.x, cat.w * 0.5, this.config.width - cat.w * 0.5);
    player.y = this.config.height + 45;
    player.vx = 0; player.vy = 0; player.grounded = false; player.anim = 'jump';
    player.input.jumpPressed = false; player.input.jumpHeld = false;
    this.log.info(`${player.nickname} ha caido. Respawn programado.`);
  }
  handlePendingRespawn(player) {
    if (!player.respawnPendingUntil || player.respawnPendingUntil <= 0) return false;
    if (Date.now() < player.respawnPendingUntil) { player.vx = 0; player.vy = 0; player.grounded = false; player.anim = 'jump'; return true; }
    this.respawnPlayerFromAbove(player);
    return false;
  }
  respawnPlayerFromAbove(player) {
    const base = this.spawnForCat(player.cat);
    player.x = clamp(base.x, cat.w * 0.5, this.config.width - cat.w * 0.5);
    player.y = clamp(base.y - RESPAWN_DROP_HEIGHT, 0, this.config.height + 60);
    player.vx = 0; player.vy = 0; player.grounded = false; player.anim = 'jump'; player.crossedDoor = false; player.respawnPendingUntil = 0;
    this.log.info(`${player.nickname} reaparece cayendo desde arriba.`);
  }
  openTreeWithPotion(player) {
    this.potion.taken = true; this.potion.consumed = true; this.potion.carrierId = null;
    this.tree.open = true; this.tree.openedAt = Date.now();
    this.goal.unlocked = true; this.goal.allPlayersPassed = false; this.goal.shouldChangeScreen = false; this.goal.changeReason = '';
    this.nextRespawnAllowedAt = 0;
    for (const p of this.players.values()) { p.crossedDoor = false; p.respawnPendingUntil = 0; }
    this.log.info(`${player.nickname} cura el arbol con la pocion`);
    if (player.mongoId && this.mongo.markPotionObtained) this.mongo.markPotionObtained(player.mongoId).catch(() => {});
  }
  updateGoalState() {
    if (!this.goal.unlocked) { this.goal.allPlayersPassed = false; this.goal.shouldChangeScreen = false; return; }
    const c = this.config;
    for (const player of this.players.values()) {
      const playerLeft = player.x - cat.w * 0.5;
      if (!player.crossedDoor && playerLeft >= c.doorCrossX) { player.crossedDoor = true; this.log.info(`${player.nickname} ha cruzado el arbol`); }
    }
    const hasPlayers = this.players.size > 0;
    const everyonePassed = hasPlayers && [...this.players.values()].every(p => p.crossedDoor === true);
    if (everyonePassed && !this.goal.shouldChangeScreen) {
      this.goal.allPlayersPassed = true;
      if (this.levelIndex < this.finalLevelIndex) {
        const now = Date.now();
        if (!this.goal.pendingAdvanceAt) { this.goal.pendingAdvanceAt = now + LEVEL0_ADVANCE_DELAY_MS; this.goal.changeReason = 'LEVEL_COMPLETE_WAITING_TREE_ANIMATION'; }
        if (now >= this.goal.pendingAdvanceAt) this.advanceToNextLevel();
      } else {
        this.goal.shouldChangeScreen = true;
        this.goal.crossedAt = Date.now();
        this.goal.changeReason = 'ALL_PLAYERS_FINISHED_FINAL_LEVEL';
        if (this.mongo.finishMatch) this.mongo.finishMatch().catch(() => {});
      }
      return;
    }
    if (!everyonePassed) { this.goal.allPlayersPassed = false; this.goal.shouldChangeScreen = false; this.goal.changeReason = ''; this.goal.pendingAdvanceAt = 0; }
  }
  advanceToNextLevel() {
    this.levelIndex = Math.min(this.finalLevelIndex, this.levelIndex + 1);
    this.resetWorld(false);
    for (const p of this.players.values()) {
      const spawn = this.spawnForCat(p.cat);
      p.x = spawn.x; p.y = spawn.y; p.vx = 0; p.vy = 0; p.grounded = true; p.crossedDoor = false; p.anim = 'idle'; p.respawnPendingUntil = 0;
    }
    this.goal.shouldChangeScreen = true;
    this.goal.changeReason = `LOAD_LEVEL_${this.levelIndex}`;
    this.log.info(`Cambiando al nivel ${this.levelIndex}.`);
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
    player.x = clamp(nextX, cat.w * 0.5, this.config.width - cat.w * 0.5);
  }
  moveY(player, dy) {
    if (dy === 0) return;
    let nextY = player.y + dy;
    let rect = this.catRect(player, player.x, nextY);
    player.grounded = false;
    if (this.touchesClosedTreeWithPotion(player, rect)) this.openTreeWithPotion(player);
    for (const box of this.collisionBoxes(player)) {
      if (!rectsTouch(rect, box)) continue;
      if (dy > 0) { nextY = box.y; player.grounded = true; } else { nextY = box.y + box.h + cat.h; }
      player.vy = 0;
      rect = this.catRect(player, player.x, nextY);
    }
    player.y = clamp(nextY, 0, this.config.height + 60);
  }
  isStandingOnSomething(player) {
    const foot = { x: player.x - cat.w * 0.5 + 1, y: player.y, w: cat.w - 2, h: 1.5 };
    for (const box of this.collisionBoxes(player)) {
      const top = { x: box.x, y: box.y - 0.5, w: box.w, h: 1.5 };
      if (rectsTouch(foot, top)) return true;
    }
    return false;
  }
  isOnMovingPlatform(player) {
    if (!this.config.platformStart) return false;
    const foot = { x: player.x - cat.w * 0.5 + 1, y: player.y, w: cat.w - 2, h: 2.5 };
    const currentTop = { x: this.platform.x, y: this.platform.y - 1.0, w: this.platform.w, h: 3.0 };
    const previousTop = { x: this.platform.previousX, y: this.platform.previousY - 1.0, w: this.platform.w, h: 3.0 };
    return rectsTouch(foot, currentTop) || rectsTouch(foot, previousTop);
  }
  touchesClosedTreeWithPotion(player, rect) { return !this.tree.open && !this.potion.consumed && this.potion.carrierId === player.id && rectsTouch(rect, this.treeRect()); }
  collisionBoxes(player) { return [...this.mapBoxes(), ...this.playerBoxes(player)]; }
  mapBoxes() {
    const c = this.config;
    const boxes = [...(c.solidZones || [])];
    if (c.platformStart) boxes.push({ name: 'platform', x: this.platform.x, y: this.platform.y, w: this.platform.w, h: this.platform.h });
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
    const c = this.config;
    let x = c.button ? c.button.x : 0;
    let y = c.button ? c.button.y : 0;
    let w = c.button ? c.button.w : 20;
    let h = c.button ? c.button.h : 16;
    if (c.platformStart && c.buttonOffsetFromPlatform) { x = this.platform.x + c.buttonOffsetFromPlatform.x; y = this.platform.y + c.buttonOffsetFromPlatform.y; }
    return { name: 'button', x: x - w * 0.5, y: y - h * 0.5, w, h };
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
    const c = this.config;
    let buttonX = c.button ? c.button.x : 0;
    let buttonY = c.button ? c.button.y : 0;
    if (c.platformStart && c.buttonOffsetFromPlatform) { buttonX = this.platform.x + c.buttonOffsetFromPlatform.x; buttonY = this.platform.y + c.buttonOffsetFromPlatform.y; }
    if (c.platformStart && c.potionOffsetFromPlatform && !this.potion.taken && !this.potion.consumed) {
      this.potion.x = this.platform.x + c.potionOffsetFromPlatform.x;
      this.potion.y = this.platform.y + c.potionOffsetFromPlatform.y;
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
      doorX: round(this.tree.x),
      doorY: round(this.tree.y),
      doorWidth: round(this.tree.w),
      doorHeight: round(this.tree.h),
      platformX: round(this.platform.x || 0),
      platformY: round(this.platform.y || 0),
      platformWidth: round(this.platform.w || 0),
      platformHeight: round(this.platform.h || 0),
      platformActive: Boolean(this.platform.active),
      buttonX: round(buttonX),
      buttonY: round(buttonY),
      buttonPressed: Boolean(this.platform.active),
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