'use strict';

const { createClient } = require('@libsql/client');

let client;

async function run(sql, params = []) {
  await client.execute({ sql, args: params });
}

async function get(sql, params = []) {
  const result = await client.execute({ sql, args: params });
  return result.rows.length > 0 ? result.rows[0] : null;
}

async function all(sql, params = []) {
  const result = await client.execute({ sql, args: params });
  return result.rows;
}

async function initDatabase() {
  if (!process.env.TURSO_DATABASE_URL) {
    throw new Error('[DB] ❌ Falta TURSO_DATABASE_URL en las variables de entorno.');
  }

  client = createClient({
    url:       process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  });

  await client.batch([
    `CREATE TABLE IF NOT EXISTS users (
      user_id         TEXT    NOT NULL,
      guild_id        TEXT    NOT NULL,
      coins           INTEGER NOT NULL DEFAULT 0,
      total_collected INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (user_id, guild_id)
    )`,
    `CREATE TABLE IF NOT EXISTS ramitas (
      user_id    TEXT    NOT NULL,
      guild_id   TEXT    NOT NULL,
      comun      INTEGER NOT NULL DEFAULT 0,
      poco_comun INTEGER NOT NULL DEFAULT 0,
      rara       INTEGER NOT NULL DEFAULT 0,
      extrana    INTEGER NOT NULL DEFAULT 0,
      mistica    INTEGER NOT NULL DEFAULT 0,
      epica      INTEGER NOT NULL DEFAULT 0,
      legendaria INTEGER NOT NULL DEFAULT 0,
      cosmica    INTEGER NOT NULL DEFAULT 0,
      divina     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, guild_id)
    )`,
    `CREATE TABLE IF NOT EXISTS platanos (
      user_id     TEXT    NOT NULL,
      guild_id    TEXT    NOT NULL,
      elementales INTEGER NOT NULL DEFAULT 0,
      avanzados   INTEGER NOT NULL DEFAULT 0,
      galacticos  INTEGER NOT NULL DEFAULT 0,
      esencia     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, guild_id)
    )`,
    `CREATE TABLE IF NOT EXISTS platano_points (
      user_id TEXT    PRIMARY KEY,
      points  INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE TABLE IF NOT EXISTS ramitas_items (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      TEXT    NOT NULL,
      guild_id     TEXT    NOT NULL,
      rareza       TEXT    NOT NULL,
      estilo       TEXT    NOT NULL,
      forma        TEXT    NOT NULL,
      largo        INTEGER NOT NULL,
      dano         INTEGER NOT NULL,
      grosor       INTEGER NOT NULL,
      fuerza_total INTEGER NOT NULL,
      created_at   INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )`,
    `CREATE TABLE IF NOT EXISTS inventario_items (
      user_id  TEXT    NOT NULL,
      item     TEXT    NOT NULL,
      cantidad INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, item)
    )`,
    `CREATE TABLE IF NOT EXISTS equipamiento (
      user_id TEXT    PRIMARY KEY,
      arma_id INTEGER DEFAULT NULL,
      escudo  TEXT    DEFAULT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS combate_stats (
      user_id TEXT    PRIMARY KEY,
      hp      INTEGER NOT NULL DEFAULT 100
    )`,
  ], 'write');

  console.log('[DB] Base de datos lista (Turso).');
}

async function getItemCantidad(userId, item) {
  const row = await get('SELECT cantidad FROM inventario_items WHERE user_id = ? AND item = ?', [userId, item]);
  return row?.cantidad ?? 0;
}

async function addItem(userId, item, cantidad = 1) {
  await run(
    `INSERT INTO inventario_items (user_id, item, cantidad) VALUES (?, ?, ?)
     ON CONFLICT(user_id, item) DO UPDATE SET cantidad = cantidad + excluded.cantidad`,
    [userId, item, cantidad]
  );
}

async function removeItem(userId, item, cantidad = 1) {
  const actual = await getItemCantidad(userId, item);
  if (actual < cantidad) return false;
  await run(
    'UPDATE inventario_items SET cantidad = cantidad - ? WHERE user_id = ? AND item = ?',
    [cantidad, userId, item]
  );
  return true;
}

async function getItemsUsuario(userId) {
  return all('SELECT item, cantidad FROM inventario_items WHERE user_id = ? AND cantidad > 0', [userId]);
}

async function getEquipamiento(userId) {
  const row = await get('SELECT arma_id, escudo FROM equipamiento WHERE user_id = ?', [userId]);
  return row ?? { arma_id: null, escudo: null };
}

async function setArma(userId, armaId) {
  await run(
    `INSERT INTO equipamiento (user_id, arma_id) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET arma_id = excluded.arma_id`,
    [userId, armaId]
  );
}

async function setEscudo(userId, escudo) {
  await run(
    `INSERT INTO equipamiento (user_id, escudo) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET escudo = excluded.escudo`,
    [userId, escudo]
  );
}

async function getPlayerHp(userId) {
  const row = await get('SELECT hp FROM combate_stats WHERE user_id = ?', [userId]);
  return row?.hp ?? 100;
}

async function setPlayerHp(userId, hp) {
  const clamped = Math.max(0, Math.min(100, hp));
  await run(
    `INSERT INTO combate_stats (user_id, hp) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET hp = excluded.hp`,
    [userId, clamped]
  );
}

async function resetAllHp() {
  await run('UPDATE combate_stats SET hp = 100');
}

module.exports = {
  initDatabase, run, get, all,
  getItemCantidad, addItem, removeItem, getItemsUsuario,
  getEquipamiento, setArma, setEscudo,
  getPlayerHp, setPlayerHp, resetAllHp,
};
