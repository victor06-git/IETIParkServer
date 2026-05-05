/**
 * nav-sync.js
 *
 * Exposes getSchema(db) which reads the 4 MongoDB collections and
 * returns them under ietipark2_* keys, ready for the /schema endpoint
 * consumed by sync-to-navision.js.
 */

async function getSchema(db) {
  if (!db) return null;

  const [categories, players, games, gamePlayers] = await Promise.all([
    db.collection('categorias').find({}).toArray(),
    db.collection('jugadores').find({}).toArray(),
    db.collection('partidas').find({}).toArray(),
    db.collection('partida_jugador').find({}).toArray(),
  ]);

  // Serialize ObjectIds to strings so JSON.stringify works cleanly
  function serialize(docs) {
    return docs.map(doc => {
      const out = {};
      for (const [k, v] of Object.entries(doc)) {
        out[k] = v && typeof v === 'object' && v.constructor && v.constructor.name === 'ObjectId'
          ? v.toString()
          : v;
      }
      return out;
    });
  }

  return {
    ietipark2_categories:    serialize(categories),
    ietipark2_players:       serialize(players),
    ietipark2_games:         serialize(games),
    ietipark2_game_players:  serialize(gamePlayers),
  };
}

module.exports = { getSchema };
