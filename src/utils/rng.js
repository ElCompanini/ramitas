'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// TABLA DE RAMITAS — Suma total: 100.00 %
// ─────────────────────────────────────────────────────────────────────────────
const RAMITAS = Object.freeze([
  { nombre: 'Común',      emoji: '🟤', columna: 'comun',      prob: 51.00 },
  { nombre: 'Poco Común', emoji: '🟢', columna: 'poco_comun', prob: 25.00 },
  { nombre: 'Rara',       emoji: '🔵', columna: 'rara',       prob: 12.00 },
  { nombre: 'Extraña',    emoji: '🟣', columna: 'extrana',    prob:  7.00 },
  { nombre: 'Mística',    emoji: '⚪', columna: 'mistica',    prob:  3.00 },
  { nombre: 'Épica',      emoji: '🟠', columna: 'epica',      prob:  1.50 },
  { nombre: 'Legendaria', emoji: '🟡', columna: 'legendaria', prob:  0.40 },
  { nombre: 'Cósmica',    emoji: '🌌', columna: 'cosmica',    prob:  0.09 },
  { nombre: 'Divina',     emoji: '✨', columna: 'divina',     prob:  0.01 },
]);

// ─────────────────────────────────────────────────────────────────────────────
// TABLA DE PLÁTANOS — Suma total: 30.50 %
// ─────────────────────────────────────────────────────────────────────────────
const PLATANOS = Object.freeze([
  { nombre: 'Elemental',  emoji: '🔥', columna: 'elementales', prob: 20.0 },
  { nombre: 'Avanzado',   emoji: '⚡', columna: 'avanzados',   prob:  8.0 },
  { nombre: 'Galáctico',  emoji: '🌠', columna: 'galacticos',  prob:  2.0 },
  { nombre: '💠 Esencia', emoji: '💠', columna: 'esencia',     prob:  0.5 },
]);

// ─────────────────────────────────────────────────────────────────────────────
// ESTILOS — Determinan el tipo de poder de la ramita
// ─────────────────────────────────────────────────────────────────────────────
const ESTILOS = Object.freeze([
  { nombre: 'Fuerza',   emoji: '💪', mult: 1.20 },
  { nombre: 'Magia',    emoji: '🔮', mult: 1.15 },
  { nombre: 'Destreza', emoji: '🌪️', mult: 1.10 },
  { nombre: 'Defensa',  emoji: '🛡️', mult: 1.05 },
]);

// ─────────────────────────────────────────────────────────────────────────────
// FORMAS — La silueta de la ramita, afecta su potencial
// ─────────────────────────────────────────────────────────────────────────────
const FORMAS = Object.freeze([
  { nombre: 'Recta',     emoji: '📏', mult: 1.00 },
  { nombre: 'Curva',     emoji: '🌙', mult: 1.08 },
  { nombre: 'Forma L',   emoji: '📐', mult: 1.12 },
  { nombre: 'Forma S',   emoji: '〰️', mult: 1.18 },
  { nombre: 'Zigzag',    emoji: '⚡', mult: 1.22 },
  { nombre: 'Espiral',   emoji: '🌀', mult: 1.28 },
  { nombre: 'Bifurcada', emoji: '🌿', mult: 1.35 },
  { nombre: 'Torcida',   emoji: '🪵', mult: 0.92 },
]);

// ─────────────────────────────────────────────────────────────────────────────
// RANGOS DE STATS POR RAREZA
// Las ramitas más raras tienen stats base más altos
// ─────────────────────────────────────────────────────────────────────────────
const STAT_RANGOS = Object.freeze({
  comun:      { min:  1, max:  15 },
  poco_comun: { min:  8, max:  28 },
  rara:       { min: 18, max:  45 },
  extrana:    { min: 30, max:  65 },
  mistica:    { min: 45, max:  85 },
  epica:      { min: 65, max: 110 },
  legendaria: { min: 90, max: 145 },
  cosmica:    { min: 120, max: 185 },
  divina:     { min: 160, max: 230 },
});

// ─────────────────────────────────────────────────────────────────────────────
// COLORES HEX por rareza
// ─────────────────────────────────────────────────────────────────────────────
const RAREZA_COLORES = Object.freeze({
  'Común':      0x8B6914,
  'Poco Común': 0x3BA55D,
  'Rara':       0x5865F2,
  'Extraña':    0x9B59B6,
  'Mística':    0xBDC3C7,
  'Épica':      0xE67E22,
  'Legendaria': 0xF1C40F,
  'Cósmica':    0x1A1A2E,
  'Divina':     0xFFFAFA,
});

// ─────────────────────────────────────────────────────────────────────────────
// JERARQUÍA para /perfil
// ─────────────────────────────────────────────────────────────────────────────
const JERARQUIA_RAREZA = Object.freeze([
  'divina', 'cosmica', 'legendaria', 'epica',
  'mistica', 'extrana', 'rara', 'poco_comun', 'comun',
]);

const NOMBRES_RAREZA = Object.freeze({
  divina:     '✨ Divina',
  cosmica:    '🌌 Cósmica',
  legendaria: '🟡 Legendaria',
  epica:      '🟠 Épica',
  mistica:    '⚪ Mística',
  extrana:    '🟣 Extraña',
  rara:       '🔵 Rara',
  poco_comun: '🟢 Poco Común',
  comun:      '🟤 Común',
});

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomFrom(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERADORES
// ─────────────────────────────────────────────────────────────────────────────
function getRamitaAleatoria() {
  const roll = Math.random() * 100;
  let acumulado = 0;
  for (const ramita of RAMITAS) {
    acumulado += ramita.prob;
    if (roll < acumulado) return ramita;
  }
  return RAMITAS[0];
}

function getPlatanoAleatorio() {
  const roll = Math.random() * 100;
  let acumulado = 0;
  for (const platano of PLATANOS) {
    acumulado += platano.prob;
    if (roll < acumulado) return platano;
  }
  return null;
}

/**
 * Genera estadísticas aleatorias para una ramita según su rareza.
 * Fórmula de fuerza total:
 *   base = (daño × 0.45) + (largo × 0.30) + (grosor × 0.25)
 *   fuerza_total = redondear(base × mult_estilo × mult_forma)
 *
 * @param {string} columna - Columna de rareza (ej: 'rara', 'epica')
 * @returns {{ estilo, forma, largo, dano, grosor, fuerzaTotal }}
 */
function generarStats(columna) {
  const rango  = STAT_RANGOS[columna] ?? STAT_RANGOS.comun;
  const estilo = randomFrom(ESTILOS);
  const forma  = randomFrom(FORMAS);

  const largo  = randomInt(rango.min, rango.max);
  const dano   = randomInt(rango.min, rango.max);
  const grosor = randomInt(rango.min, rango.max);

  const base        = (dano * 0.45) + (largo * 0.30) + (grosor * 0.25);
  const fuerzaTotal = Math.round(base * estilo.mult * forma.mult);

  return { estilo, forma, largo, dano, grosor, fuerzaTotal };
}

module.exports = {
  RAMITAS,
  PLATANOS,
  ESTILOS,
  FORMAS,
  RAREZA_COLORES,
  JERARQUIA_RAREZA,
  NOMBRES_RAREZA,
  getRamitaAleatoria,
  getPlatanoAleatorio,
  generarStats,
};
