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
  ], 'write');

  console.log('[DB] Base de datos lista (Turso).');
}

module.exports = { initDatabase, run, get, all };
