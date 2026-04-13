'use strict';

const initSqlJs = require('sql.js');
const path      = require('path');
const fs        = require('fs');

const DB_PATH = path.join(__dirname, '..', '..', 'bot.sqlite');

// Instancia global de la base de datos (se llena en initDatabase)
let db = null;

/**
 * Guarda la base de datos en disco.
 * Se llama después de cada escritura para garantizar persistencia.
 */
function saveDb() {
  const data = db.export();
  fs.writeFileSync(DB_PATH, Buffer.from(data));
}

/**
 * Ejecuta una query sin retorno (CREATE, INSERT, UPDATE, DELETE).
 * Guarda en disco automáticamente.
 */
function run(sql, params = []) {
  db.run(sql, params);
  saveDb();
}

/**
 * Obtiene una sola fila. Retorna objeto o null.
 */
function get(sql, params = []) {
  const stmt   = db.prepare(sql);
  stmt.bind(params);
  const hasRow = stmt.step();
  const row    = hasRow ? stmt.getAsObject() : null;
  stmt.free();
  return row;
}

/**
 * Obtiene todas las filas. Retorna array de objetos.
 */
function all(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

/**
 * Inicializa la base de datos: carga el archivo si existe o crea uno nuevo.
 * Crea las tablas si no existen.
 */
async function initDatabase() {
  const SQL = await initSqlJs();

  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      user_id         TEXT    NOT NULL,
      guild_id        TEXT    NOT NULL,
      coins           INTEGER NOT NULL DEFAULT 0,
      total_collected INTEGER NOT NULL DEFAULT 0,
      created_at      INTEGER NOT NULL DEFAULT (strftime('%s', 'now')),
      PRIMARY KEY (user_id, guild_id)
    );

    CREATE TABLE IF NOT EXISTS ramitas (
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
    );

    CREATE TABLE IF NOT EXISTS platanos (
      user_id     TEXT    NOT NULL,
      guild_id    TEXT    NOT NULL,
      elementales INTEGER NOT NULL DEFAULT 0,
      avanzados   INTEGER NOT NULL DEFAULT 0,
      galacticos  INTEGER NOT NULL DEFAULT 0,
      esencia     INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, guild_id)
    );

    CREATE TABLE IF NOT EXISTS platano_points (
      user_id TEXT    PRIMARY KEY,
      points  INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ramitas_items (
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
    );
  `);

  saveDb();
  console.log('[DB] Base de datos lista.');
}

module.exports = { initDatabase, run, get, all, saveDb };
