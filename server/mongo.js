const { MongoClient } = require('mongodb');

const DB_NAME = 'ietipark2';

let db = null;
let currentPartidaId = null;
let partidaStartMs = null;

async function connectMongo({ uri, log }) {
  try {
    const client = new MongoClient(uri);
    await client.connect();
    db = client.db(DB_NAME);
    log.info(`MongoDB conectado a la base de datos "${DB_NAME}"`);
    await ensureIndexes(log);
    return true;
  } catch (err) {
    log.warn(`MongoDB no disponible: ${err.message}. El servidor funciona sin persistencia.`);
    db = null;
    return false;
  }
}

async function ensureIndexes(log) {
  if (!db) return;

  try {
    await db.collection('jugadores').createIndex({ nickname: 1 }, { unique: true });
    await db.collection('partida_jugador').createIndex({ partidaId: 1, jugadorId: 1 }, { unique: true });
    log.info('Índices MongoDB verificados');
  } catch (err) {
    log.warn(`Error creando índices: ${err.message}`);
  }
}

async function getOrCreateDefaultCategory(log) {
  if (!db) return null;

  let categoria = await db.collection('categorias').findOne({ nombre: 'Junior' });
  if (categoria) return categoria;

  const categorias = [
    { nombre: 'Junior', color: 'Azul' },
    { nombre: 'Senior', color: 'Morado' },
    { nombre: 'Expert', color: 'Dorado' }
  ];

  const result = await db.collection('categorias').insertMany(categorias);
  const firstId = Object.values(result.insertedIds)[0];
  log.info('Categorías por defecto creadas en MongoDB');
  return { _id: firstId };
}

async function upsertJugador(nickname, log) {
  if (!db) return null;

  try {
    const categoria = await getOrCreateDefaultCategory(log);

    const result = await db.collection('jugadores').findOneAndUpdate(
      { nickname },
      { $setOnInsert: { nickname, id_categoria: categoria._id } },
      { upsert: true, returnDocument: 'after' }
    );

    // Según la versión del driver, puede devolver el documento directamente o dentro de .value.
    return result && result.value ? result.value : result;
  } catch (err) {
    log.warn(`upsertJugador error: ${err.message}`);
    return null;
  }
}

async function startMatch(log) {
  if (!db) return null;

  try {
    const result = await db.collection('partidas').insertOne({
      fecha: new Date(),
      duracion: null
    });

    currentPartidaId = result.insertedId;
    partidaStartMs = Date.now();
    log.info(`Partida iniciada en MongoDB con id ${currentPartidaId}`);
    return currentPartidaId;
  } catch (err) {
    log.warn(`iniciarPartida error: ${err.message}`);
    return null;
  }
}

async function registerPlayerInMatch(jugadorMongoId, log) {
  if (!db || !currentPartidaId || !jugadorMongoId) return;

  try {
    await db.collection('partida_jugador').updateOne(
      { partidaId: currentPartidaId, jugadorId: jugadorMongoId },
      { $setOnInsert: { partidaId: currentPartidaId, jugadorId: jugadorMongoId, pocion_obtenida: 0 } },
      { upsert: true }
    );
  } catch (err) {
    log.warn(`registrarJugadorEnPartida error: ${err.message}`);
  }
}

async function markPotionObtained(jugadorMongoId, log) {
  if (!db || !currentPartidaId || !jugadorMongoId) return;

  try {
    await db.collection('partida_jugador').updateOne(
      { partidaId: currentPartidaId, jugadorId: jugadorMongoId },
      { $set: { pocion_obtenida: 1 } }
    );
    log.info(`pocion_obtenida marcada para jugador ${jugadorMongoId}`);
  } catch (err) {
    log.warn(`marcarPotionObtenida error: ${err.message}`);
  }
}

async function finishMatch(log) {
  if (!db || !currentPartidaId || !partidaStartMs) return;

  try {
    const durationSeconds = Math.round((Date.now() - partidaStartMs) / 1000);

    await db.collection('partidas').updateOne(
      { _id: currentPartidaId },
      { $set: { duracion: durationSeconds } }
    );

    log.info(`Partida ${currentPartidaId} finalizada. Duración: ${durationSeconds}s`);
    currentPartidaId = null;
    partidaStartMs = null;
  } catch (err) {
    log.warn(`finalizarPartida error: ${err.message}`);
  }
}

module.exports = {
  connectMongo,
  upsertJugador,
  startMatch,
  registerPlayerInMatch,
  markPotionObtained,
  finishMatch
};
