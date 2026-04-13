'use strict';

require('dotenv').config();

const {
  Client,
  GatewayIntentBits,
  Partials,
  ActivityType,
  EmbedBuilder,
  AttachmentBuilder,
  SlashCommandBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
} = require('discord.js');

const path = require('path');
const fs   = require('fs');

const { initDatabase, run, get, all } = require('./src/database/db');
const {
  RAMITAS,
  ESTILOS,
  FORMAS,
  RAREZA_COLORES,
  JERARQUIA_RAREZA,
  NOMBRES_RAREZA,
  getRamitaAleatoria,
  getPlatanoEvento,
  generarStats,
} = require('./src/utils/rng');

// Lookups rápidos: columna → objeto
const RAMITA_MAP = Object.fromEntries(RAMITAS.map(r => [r.columna, r]));

// ─────────────────────────────────────────────────────────────────────────────
// VARIABLES DE ENTORNO
// ─────────────────────────────────────────────────────────────────────────────
const TOKEN             = process.env.TOKEN;
const CLIENT_ID         = process.env.CLIENT_ID;
const OWNER_ID          = process.env.OWNER_ID ?? '';
const EVENT_CHANNEL_IDS = (process.env.EVENT_CHANNEL_IDS || process.env.EVENT_CHANNEL_ID || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

if (!TOKEN)     { console.error('[CONFIG] ❌ Falta TOKEN en .env');     process.exit(1); }
if (!CLIENT_ID) { console.error('[CONFIG] ❌ Falta CLIENT_ID en .env'); process.exit(1); }
if (!OWNER_ID)  { console.warn('[CONFIG] ⚠️  OWNER_ID no definido. /soltar_platano deshabilitado.'); }
console.log('[CONFIG] EVENT_CHANNEL_IDS raw:', JSON.stringify(process.env.EVENT_CHANNEL_IDS));
console.log('[CONFIG] EVENT_CHANNEL_ID  raw:', JSON.stringify(process.env.EVENT_CHANNEL_ID));
console.log('[CONFIG] canales detectados:', EVENT_CHANNEL_IDS);
console.log('[CONFIG] variables disponibles:', Object.keys(process.env).filter(k => !['TOKEN','CLIENT_ID','OWNER_ID'].includes(k)));

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTES DE TIEMPO
// ─────────────────────────────────────────────────────────────────────────────
const COOLDOWN_RECOLECTAR_MS  = 30 * 60 * 1000; // 30 min
const PLATANO_INTERVALO_MS    = 5 * 60 * 1000;   // 5 min
const AUTO_DELETE_MS          = 45_000;          // 45 segundos

function borrarDespues(msg) {
  setTimeout(() => msg.delete().catch(() => {}), AUTO_DELETE_MS);
}

// Intercambios pendientes: messageId → datos del trade
const pendingTrades = new Map();

// ─────────────────────────────────────────────────────────────────────────────
// SISTEMA DE COOLDOWNS — Map nativo en memoria
// ─────────────────────────────────────────────────────────────────────────────
const cooldowns = new Map();

function checkCooldown(userId, command, cooldownMs = COOLDOWN_RECOLECTAR_MS) {
  const key = `${userId}:${command}`;
  const now = Date.now();

  if (cooldowns.has(key)) {
    const expira = cooldowns.get(key);
    if (now < expira) {
      return { onCooldown: true, timeLeft: ((expira - now) / 1000).toFixed(1) };
    }
  }

  cooldowns.set(key, now + cooldownMs);
  return { onCooldown: false };
}

// Limpieza periódica del Map cada 10 minutos
setInterval(() => {
  const now = Date.now();
  for (const [key, expira] of cooldowns) {
    if (now > expira) cooldowns.delete(key);
  }
}, 10 * 60 * 1000);

// ─────────────────────────────────────────────────────────────────────────────
// WHITELIST DE COLUMNAS
// ─────────────────────────────────────────────────────────────────────────────
const VALID_RAMITA_COLS  = new Set(['comun','poco_comun','rara','extrana','mistica','epica','legendaria','cosmica','divina']);
const VALID_PLATANO_COLS = new Set(['elementales','avanzados','galacticos','esencia']);

// ─────────────────────────────────────────────────────────────────────────────
// OPERACIONES DE BASE DE DATOS
// ─────────────────────────────────────────────────────────────────────────────
async function ensureUser(userId, guildId) {
  await run('INSERT OR IGNORE INTO users    (user_id, guild_id) VALUES (?, ?)', [userId, guildId]);
  await run('INSERT OR IGNORE INTO ramitas  (user_id, guild_id) VALUES (?, ?)', [userId, guildId]);
  await run('INSERT OR IGNORE INTO platanos (user_id, guild_id) VALUES (?, ?)', [userId, guildId]);
}

async function addRamita(userId, guildId, columna, stats) {
  if (!VALID_RAMITA_COLS.has(columna)) throw new Error(`Columna inválida: ${columna}`);
  await run(`UPDATE ramitas SET ${columna} = ${columna} + 1 WHERE user_id = ? AND guild_id = ?`, [userId, guildId]);
  await run('UPDATE users SET total_collected = total_collected + 1 WHERE user_id = ? AND guild_id = ?', [userId, guildId]);
  await run(
    `INSERT INTO ramitas_items (user_id, guild_id, rareza, estilo, forma, largo, dano, grosor, fuerza_total)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, guildId, columna, stats.estilo.nombre, stats.forma.nombre,
     stats.largo, stats.dano, stats.grosor, stats.fuerzaTotal]
  );
}

// Valor en puntos por tipo de plátano (rangos no solapados)
const PLATANO_VALORES = Object.freeze({
  elementales: { min:   5, max:  15 },
  avanzados:   { min:  20, max:  45 },
  galacticos:  { min:  55, max:  95 },
  esencia:     { min: 110, max: 175 },
});

async function addPlatano(userId, guildId, columna) {
  if (!VALID_PLATANO_COLS.has(columna)) throw new Error(`Columna inválida: ${columna}`);
  await run(`UPDATE platanos SET ${columna} = ${columna} + 1 WHERE user_id = ? AND guild_id = ?`, [userId, guildId]);
  const { min, max } = PLATANO_VALORES[columna];
  const puntos = Math.floor(Math.random() * (max - min + 1)) + min;
  await run(
    `INSERT INTO platano_points (user_id, points) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET points = points + excluded.points`,
    [userId, puntos]
  );
  return puntos;
}

async function getPlatanoPoints(userId) {
  const row = await get('SELECT points FROM platano_points WHERE user_id = ?', [userId]);
  return row?.points ?? 0;
}

async function transferirPuntos(fromId, toId, puntos) {
  await run(
    `INSERT INTO platano_points (user_id, points) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET points = points - excluded.points`,
    [fromId, puntos]
  );
  await run(
    `INSERT INTO platano_points (user_id, points) VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET points = points + excluded.points`,
    [toId, puntos]
  );
}

// Por servidor — usado en intercambios
async function getRamitasGuild(userId, guildId) {
  return get('SELECT * FROM ramitas WHERE user_id = ? AND guild_id = ?', [userId, guildId]);
}

async function transferirRamita(fromId, toId, guildId, columna) {
  await run(`UPDATE ramitas SET ${columna} = ${columna} - 1 WHERE user_id = ? AND guild_id = ?`, [fromId, guildId]);
  await run(`UPDATE ramitas SET ${columna} = ${columna} + 1 WHERE user_id = ? AND guild_id = ?`, [toId, guildId]);
}

// Versiones globales (suma todos los servidores) — usadas en /perfil e /inventario
async function getRamitasGlobal(userId) {
  return get(
    `SELECT SUM(comun) AS comun, SUM(poco_comun) AS poco_comun, SUM(rara) AS rara,
            SUM(extrana) AS extrana, SUM(mistica) AS mistica, SUM(epica) AS epica,
            SUM(legendaria) AS legendaria, SUM(cosmica) AS cosmica, SUM(divina) AS divina
     FROM ramitas WHERE user_id = ?`,
    [userId]
  );
}

async function getPlatanasGlobal(userId) {
  return get(
    `SELECT SUM(elementales) AS elementales, SUM(avanzados) AS avanzados,
            SUM(galacticos) AS galacticos, SUM(esencia) AS esencia
     FROM platanos WHERE user_id = ?`,
    [userId]
  );
}

async function getUserGlobal(userId) {
  return get(
    'SELECT SUM(total_collected) AS total_collected FROM users WHERE user_id = ?',
    [userId]
  );
}

async function getTopRecolecciones(limit = 10) {
  return all(
    `SELECT user_id, SUM(total_collected) AS total
     FROM users GROUP BY user_id ORDER BY total DESC LIMIT ?`,
    [limit]
  );
}

async function getTopFuerza(limit = 10) {
  return all(
    `SELECT user_id, MAX(fuerza_total) AS max_fuerza, rareza
     FROM ramitas_items GROUP BY user_id ORDER BY max_fuerza DESC LIMIT ?`,
    [limit]
  );
}

async function getTopPrestige(limit = 10) {
  return all(
    `SELECT user_id,
       SUM(comun*1 + poco_comun*2 + rara*4 + extrana*8 + mistica*16
           + epica*32 + legendaria*64 + cosmica*128 + divina*256) AS score
     FROM ramitas GROUP BY user_id ORDER BY score DESC LIMIT ?`,
    [limit]
  );
}

async function getRamitasItems(userId, rareza, limit = 10) {
  if (rareza) {
    return all(
      `SELECT * FROM ramitas_items WHERE user_id = ? AND rareza = ? ORDER BY fuerza_total DESC LIMIT ?`,
      [userId, rareza, limit]
    );
  }
  return all(
    `SELECT * FROM ramitas_items WHERE user_id = ? ORDER BY fuerza_total DESC LIMIT ?`,
    [userId, limit]
  );
}

async function getRamitaItem(id) {
  return get('SELECT * FROM ramitas_items WHERE id = ?', [id]);
}

async function getPosicionRecolecciones(userId) {
  const row = await get(
    `SELECT COUNT(*) + 1 AS pos FROM (
       SELECT user_id, SUM(total_collected) AS total FROM users GROUP BY user_id
     ) AS r WHERE total > COALESCE((SELECT SUM(total_collected) FROM users WHERE user_id = ?), 0)`,
    [userId]
  );
  return row?.pos ?? null;
}

async function getPosicionFuerza(userId) {
  const row = await get(
    `SELECT COUNT(*) + 1 AS pos FROM (
       SELECT user_id, MAX(fuerza_total) AS max_fuerza FROM ramitas_items GROUP BY user_id
     ) AS r WHERE max_fuerza > COALESCE((SELECT MAX(fuerza_total) FROM ramitas_items WHERE user_id = ?), 0)`,
    [userId]
  );
  return row?.pos ?? null;
}

async function getPosicionPrestige(userId) {
  const row = await get(
    `SELECT COUNT(*) + 1 AS pos FROM (
       SELECT user_id,
         SUM(comun*1 + poco_comun*2 + rara*4 + extrana*8 + mistica*16
             + epica*32 + legendaria*64 + cosmica*128 + divina*256) AS score
       FROM ramitas GROUP BY user_id
     ) AS r WHERE score > COALESCE(
       (SELECT SUM(comun*1 + poco_comun*2 + rara*4 + extrana*8 + mistica*16
                + epica*32 + legendaria*64 + cosmica*128 + divina*256)
        FROM ramitas WHERE user_id = ?), 0)`,
    [userId]
  );
  return row?.pos ?? null;
}

// ─────────────────────────────────────────────────────────────────────────────
// IMÁGENES LOCALES
// ─────────────────────────────────────────────────────────────────────────────
function getImagenRamita(columna) {
  for (const ext of ['png', 'gif', 'jpg', 'webp']) {
    const filePath = path.join(__dirname, 'assets', 'ramas', `${columna}.${ext}`);
    if (fs.existsSync(filePath)) {
      return new AttachmentBuilder(filePath, { name: `ramita.${ext}` });
    }
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SLASH COMMANDS
// ─────────────────────────────────────────────────────────────────────────────
const slashCommands = [
  new SlashCommandBuilder()
    .setName('recolectar')
    .setDescription('🌿 Recolecta una ramita aleatoria (cooldown: 3 min)')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('inventario')
    .setDescription('📦 Muestra tu inventario completo de ramitas y plátanos')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('perfil')
    .setDescription('👤 Muestra tu perfil y estadísticas de recolección')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('top')
    .setDescription('🏆 Ver los tops globales de recolectores')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('inspeccionar')
    .setDescription('🔍 Inspecciona tus ramitas (solo visible para ti)')
    .addStringOption(opt =>
      opt.setName('rareza')
        .setDescription('Filtrar por rareza')
        .setRequired(false)
        .addChoices(
          { name: '🟤 Común',      value: 'comun'      },
          { name: '🟢 Poco Común', value: 'poco_comun' },
          { name: '🔵 Rara',       value: 'rara'       },
          { name: '🟣 Extraña',    value: 'extrana'    },
          { name: '⚪ Mística',    value: 'mistica'    },
          { name: '🟠 Épica',      value: 'epica'      },
          { name: '🟡 Legendaria', value: 'legendaria' },
          { name: '🌌 Cósmica',    value: 'cosmica'    },
          { name: '✨ Divina',     value: 'divina'     },
        )
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('soltar_platano')
    .setDescription('🔒 [Admin] Lanza un evento de plátano inmediatamente')
    .toJSON(),
  new SlashCommandBuilder()
    .setName('mostrar')
    .setDescription('📢 Muestra una de tus ramitas públicamente')
    .addIntegerOption(opt =>
      opt.setName('id')
        .setDescription('ID de la ramita (obtenida con /inspeccionar)')
        .setRequired(true)
        .setMinValue(1)
    )
    .toJSON(),
  new SlashCommandBuilder()
    .setName('intercambiar')
    .setDescription('🔄 Ofrece puntos de plátano a cambio de una ramita')
    .addUserOption(opt =>
      opt.setName('usuario').setDescription('Usuario con quien intercambiar').setRequired(true)
    )
    .addIntegerOption(opt =>
      opt.setName('platanos').setDescription('Cantidad de puntos de plátano que ofreces').setRequired(true).setMinValue(1)
    )
    .toJSON(),
];

// ─────────────────────────────────────────────────────────────────────────────
// CLIENTE DISCORD
// ─────────────────────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.GuildMessageReactions,
  ],
  partials: [Partials.Message, Partials.Reaction, Partials.User],
});

// ─────────────────────────────────────────────────────────────────────────────
// EVENTO: READY
// ─────────────────────────────────────────────────────────────────────────────
client.once('clientReady', async () => {
  console.log(`[BOT] ✅ ${client.user.tag} operativo.`);
  client.user.setActivity('🌿 Recolectando ramitas...', { type: ActivityType.Watching });

  const rest = new REST({ version: '10' }).setToken(TOKEN);
  try {
    await rest.put(Routes.applicationCommands(CLIENT_ID), { body: slashCommands });
    console.log('[CMD] Slash commands registrados.');
  } catch (err) {
    console.error('[CMD] Error al registrar comandos:', err.message);
  }

  iniciarEventoPlatano();
});

// ─────────────────────────────────────────────────────────────────────────────
// EVENTO DE PLÁTANO — cada 5 min
// ─────────────────────────────────────────────────────────────────────────────
async function lanzarEventoPlatano() {
  for (const channelId of EVENT_CHANNEL_IDS) {
    try {
      console.log(`[PLÁTANO] Intentando canal ${channelId}...`);
      const canal = await client.channels.fetch(channelId).catch((e) => { console.error('[PLÁTANO] fetch error:', e.message); return null; });
      if (!canal || !canal.isTextBased()) {
        console.warn(`[PLÁTANO] Canal ${channelId} no válido o no es texto. canal=${canal?.type}`);
        continue;
      }
      console.log(`[PLÁTANO] Canal OK: #${canal.name}`);

      const platano = getPlatanoEvento();

      const msg = await canal.send({
        content: `🍌 Ha caído un plátano **${platano.nombre}** ${platano.emoji} ¡agárrenlo reaccionando!`,
      });
      borrarDespues(msg);
      await msg.react('🍌');

      const collector = msg.createReactionCollector({
        filter: (reaction, user) => reaction.emoji.name === '🍌' && !user.bot,
        max:  1,
        time: 30_000,
      });

      collector.on('collect', async (_reaction, ganador) => {
        try {
          await ensureUser(ganador.id, canal.guild.id);
          const pts = await addPlatano(ganador.id, canal.guild.id, platano.columna);
          borrarDespues(await canal.send(`🐒 ¡El mono **${ganador.username}** lo ha agarrado! *(+${pts} 🍌)*`));
          console.log(`[PLÁTANO] Reclamado por ${ganador.username} → ${platano.nombre} (+${pts} pts)`);
        } catch (err) {
          console.error('[PLÁTANO] Error al procesar ganador:', err.message);
        }
      });

      collector.on('end', (collected) => {
        if (collected.size === 0) {
          canal.send('😔 Qué pena, nadie ha agarrado el plátano.').then(borrarDespues).catch(() => {});
        }
      });

      console.log(`[PLÁTANO] Lanzado en #${canal.name} → ${platano.nombre}`);
    } catch (err) {
      console.error('[PLÁTANO] Error:', err.message);
    }
  }
}

function iniciarEventoPlatano() {
  if (EVENT_CHANNEL_IDS.length === 0) return;
  console.log('[PLÁTANO] Iniciado (cada 5 min).');
  lanzarEventoPlatano();
  setInterval(lanzarEventoPlatano, PLATANO_INTERVALO_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// SLASH COMMANDS HANDLER
// ─────────────────────────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {

  // ── Botones de intercambio ─────────────────────────────────────────────────
  if (interaction.isButton()) {
    const trade = pendingTrades.get(interaction.message.id);

    if (!trade) return interaction.reply({ content: '❌ Esta propuesta ya expiró.', ephemeral: true });

    // ─ Fase 1: Aceptar / Rechazar (solo el receptor)
    if (trade.phase === 'offer') {
      if (interaction.user.id !== trade.receiverUserId)
        return interaction.reply({ content: '❌ Esta propuesta no es para ti.', ephemeral: true });

      if (interaction.customId === 'trade_decline') {
        pendingTrades.delete(interaction.message.id);
        await interaction.update({ content: '❌ Intercambio rechazado.', embeds: [], components: [] });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 5_000);
        return;
      }

      // Aceptó → mostrar selector de ramita
      trade.phase = 'counter';
      const ramitasReceptor = await getRamitasGuild(trade.receiverUserId, trade.guildId);
      const botonesRamita = [];

      for (const [col, info] of Object.entries(RAMITA_MAP)) {
        if ((ramitasReceptor?.[col] ?? 0) > 0) {
          botonesRamita.push(
            new ButtonBuilder()
              .setCustomId(`trade_pick_${col}`)
              .setLabel(`${info.emoji} ${info.nombre}`)
              .setStyle(ButtonStyle.Primary)
          );
        }
      }

      if (botonesRamita.length === 0) {
        pendingTrades.delete(interaction.message.id);
        await interaction.update({ content: '❌ No tienes ninguna ramita para ofrecer.', embeds: [], components: [] });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 8_000);
        return;
      }

      botonesRamita.push(
        new ButtonBuilder().setCustomId('trade_cancel').setLabel('❌ Cancelar').setStyle(ButtonStyle.Danger)
      );

      const rows = [];
      for (let i = 0; i < botonesRamita.length; i += 5)
        rows.push(new ActionRowBuilder().addComponents(botonesRamita.slice(i, i + 5)));

      await interaction.update({
        content: `<@${trade.receiverUserId}> elige qué ramita darás a <@${trade.offererUserId}> a cambio de **${trade.puntos} 🍌 plátanos totales**:`,
        embeds: [],
        components: rows,
      });
      return;
    }

    // ─ Fase 2: Receptor elige ramita (solo el receptor)
    if (trade.phase === 'counter') {
      if (interaction.user.id !== trade.receiverUserId)
        return interaction.reply({ content: '❌ No eres tú quien debe elegir.', ephemeral: true });

      if (interaction.customId === 'trade_cancel') {
        pendingTrades.delete(interaction.message.id);
        await interaction.update({ content: '❌ Intercambio cancelado.', components: [] });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 5_000);
        return;
      }

      const rareza = interaction.customId.replace('trade_pick_', '');
      if (!VALID_RAMITA_COLS.has(rareza))
        return interaction.reply({ content: '❌ Rareza inválida.', ephemeral: true });

      pendingTrades.delete(interaction.message.id);

      // Verificar que ambos sigan teniendo lo acordado
      const ptsOferente     = await getPlatanoPoints(trade.offererUserId);
      const ramitasReceptor = await getRamitasGuild(trade.receiverUserId, trade.guildId);

      if (ptsOferente < trade.puntos) {
        await interaction.update({ content: '❌ El oferente ya no tiene suficientes puntos.', components: [] });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 8_000);
        return;
      }
      if ((ramitasReceptor?.[rareza] ?? 0) < 1) {
        await interaction.update({ content: '❌ Ya no tienes esa ramita.', components: [] });
        setTimeout(() => interaction.deleteReply().catch(() => {}), 8_000);
        return;
      }

      // Ejecutar intercambio
      await transferirPuntos(trade.offererUserId, trade.receiverUserId, trade.puntos);
      await transferirRamita(trade.receiverUserId, trade.offererUserId, trade.guildId, rareza);

      const ramitaInfo = RAMITA_MAP[rareza];
      const embed = new EmbedBuilder()
        .setTitle('✅ ¡Intercambio completado!')
        .setDescription(
          `<@${trade.offererUserId}> dio **${trade.puntos} 🍌 plátanos totales** y recibió ${ramitaInfo.emoji} **Ramita ${ramitaInfo.nombre}**\n` +
          `<@${trade.receiverUserId}> dio la ramita y recibió **${trade.puntos} 🍌 plátanos totales**`
        )
        .setColor(0x57F287)
        .setTimestamp();

      await interaction.update({ embeds: [embed], components: [] });
      setTimeout(() => interaction.deleteReply().catch(() => {}), AUTO_DELETE_MS);
      return;
    }
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName, user, guildId } = interaction;

  // ── /recolectar ────────────────────────────────────────────────────────────
  if (commandName === 'recolectar') {
    const cd = checkCooldown(user.id, 'recolectar');
    if (cd.onCooldown) {
      return interaction.reply({
        content: `⏳ Espera **${cd.timeLeft}s** antes de volver a recolectar.`,
        ephemeral: true,
      });
    }

    await interaction.deferReply();
    try {
      await ensureUser(user.id, guildId);
      const ramita = getRamitaAleatoria();
      const stats  = generarStats(ramita.columna);
      const imagen = getImagenRamita(ramita.columna);

      await addRamita(user.id, guildId, ramita.columna, stats);

      const embed = new EmbedBuilder()
        .setTitle(`🌿 ¡Ramita ${ramita.nombre} encontrada! ${ramita.emoji}`)
        .setDescription('¡Encontraste una ramita en el bosque!')
        .addFields(
          { name: `${stats.estilo.emoji} Estilo`,        value: `**${stats.estilo.nombre}**`,    inline: true  },
          { name: `${stats.forma.emoji} Forma`,          value: `**${stats.forma.nombre}**`,     inline: true  },
          { name: '\u200b',                              value: '\u200b',                         inline: true  },
          { name: '📏 Largo',                            value: `**${stats.largo}**`,             inline: true  },
          { name: '⚔️ Daño',                             value: `**${stats.dano}**`,              inline: true  },
          { name: '🪨 Grosor',                           value: `**${stats.grosor}**`,            inline: true  },
          { name: '⚡ Fuerza Total',                     value: `# ${stats.fuerzaTotal}`,         inline: false },
        )
        .setColor(RAREZA_COLORES[ramita.nombre] ?? 0x2F3136)
        .setThumbnail(user.displayAvatarURL())
        .setFooter({ text: 'Cooldown: 30 min • /inventario para ver tu colección' })
        .setTimestamp();

      if (imagen) embed.setImage('attachment://ramita.png');

      borrarDespues(await interaction.editReply({ embeds: [embed], files: imagen ? [imagen] : [] }));

    } catch (err) {
      console.error('[CMD] /recolectar error:', err.message);
      borrarDespues(await interaction.editReply({ content: '❌ Error al recolectar. Inténtalo de nuevo.' }));
    }
  }

  // ── /inventario ────────────────────────────────────────────────────────────
  else if (commandName === 'inventario') {
    await interaction.deferReply();
    try {
      await ensureUser(user.id, guildId);
      const ramitas  = await getRamitasGlobal(user.id);
      const platanos = await getPlatanasGlobal(user.id);

      const embed = new EmbedBuilder()
        .setTitle(`📦 Inventario de ${user.username}`)
        .addFields(
          {
            name: '🌿 Ramitas',
            value: [
              `🟤 Común:      **${ramitas.comun}**`,
              `🟢 Poco Común: **${ramitas.poco_comun}**`,
              `🔵 Rara:       **${ramitas.rara}**`,
              `🟣 Extraña:    **${ramitas.extrana}**`,
              `⚪ Mística:    **${ramitas.mistica}**`,
              `🟠 Épica:      **${ramitas.epica}**`,
              `🟡 Legendaria: **${ramitas.legendaria}**`,
              `🌌 Cósmica:    **${ramitas.cosmica}**`,
              `✨ Divina:     **${ramitas.divina}**`,
            ].join('\n'),
            inline: true,
          },
          {
            name: '🍌 Plátanos',
            value: [
              `🔥 Elementales: **${platanos.elementales}**`,
              `⚡ Avanzados:   **${platanos.avanzados}**`,
              `🌠 Galácticos:  **${platanos.galacticos}**`,
              `💠 Esencia:     **${platanos.esencia}**`,
            ].join('\n'),
            inline: true,
          },
        )
        .setColor(0x5865F2)
        .setThumbnail(user.displayAvatarURL())
        .setTimestamp();

      borrarDespues(await interaction.editReply({ embeds: [embed] }));

    } catch (err) {
      console.error('[CMD] /inventario error:', err.message);
      borrarDespues(await interaction.editReply({ content: '❌ Error al obtener el inventario.' }));
    }
  }

  // ── /perfil ────────────────────────────────────────────────────────────────
  else if (commandName === 'perfil') {
    await interaction.deferReply();
    try {
      await ensureUser(user.id, guildId);
      const userData = await getUserGlobal(user.id);
      const ramitas  = await getRamitasGlobal(user.id);

      const COLS_R = ['comun','poco_comun','rara','extrana','mistica','epica','legendaria','cosmica','divina'];

      const totalRamitas  = COLS_R.reduce((s, k) => s + (ramitas[k]  ?? 0), 0);
      const totalPlatanos = await getPlatanoPoints(user.id);

      let rarezaMax = '🟤 Común';
      for (const col of JERARQUIA_RAREZA) {
        if ((ramitas[col] ?? 0) > 0) { rarezaMax = NOMBRES_RAREZA[col]; break; }
      }

      const embed = new EmbedBuilder()
        .setTitle(`👤 Perfil de ${user.username}`)
        .setDescription(`> *"Recolector de ramitas desde los tiempos del bosque primigenio."*`)
        .addFields(
          { name: '🌿 Ramitas totales',  value: `**${totalRamitas}**`,             inline: true },
          { name: '🍌 Plátanos totales', value: `**${totalPlatanos}**`,            inline: true },
          { name: '📊 Acciones totales', value: `**${userData.total_collected}**`, inline: true },
          { name: '🏆 Rareza más alta',  value: rarezaMax,                          inline: false },
        )
        .setColor(0xFEE75C)
        .setThumbnail(user.displayAvatarURL())
        .setTimestamp();

      borrarDespues(await interaction.editReply({ embeds: [embed] }));

    } catch (err) {
      console.error('[CMD] /perfil error:', err.message);
      borrarDespues(await interaction.editReply({ content: '❌ Error al obtener el perfil.' }));
    }
  }

  // ── /top ───────────────────────────────────────────────────────────────────
  else if (commandName === 'top') {
    await interaction.deferReply();
    try {
      const MEDALLAS = ['🥇', '🥈', '🥉'];

      async function buildField(rows, valorFn, userId, userPos) {
        if (rows.length === 0) return '*Sin datos aún*';
        const lines = await Promise.all(rows.map(async (row, i) => {
          let nombre;
          try {
            const u = await client.users.fetch(row.user_id);
            nombre = u.username;
          } catch {
            nombre = `Usuario ···${row.user_id.slice(-4)}`;
          }
          const pos = MEDALLAS[i] ?? `**${i + 1}.**`;
          return `${pos} ${nombre} — ${valorFn(row)}`;
        }));
        const enTop = rows.some(r => r.user_id === userId);
        if (!enTop && userPos !== null) {
          lines.push(`\n📍 Tu posición: **#${userPos}**`);
        }
        return lines.join('\n');
      }

      const [posR, posF, posP] = await Promise.all([
        getPosicionRecolecciones(user.id),
        getPosicionFuerza(user.id),
        getPosicionPrestige(user.id),
      ]);

      const [recolecciones, fuerza, prestige] = await Promise.all([
        buildField(await getTopRecolecciones(3), row => `🌿 **${row.total}** recolecciones`,                                        user.id, posR),
        buildField(await getTopFuerza(3),        row => `⚡ **${row.max_fuerza}** fuerza *(${NOMBRES_RAREZA[row.rareza] ?? row.rareza})*`, user.id, posF),
        buildField(await getTopPrestige(3),      row => `✨ **${row.score}** pts`,                                                   user.id, posP),
      ]);

      const embed = new EmbedBuilder()
        .setTitle('🏆 Tops Globales')
        .addFields(
          { name: '🌿 Más Recolecciones', value: recolecciones, inline: false },
          { name: '⚡ Mayor Fuerza',       value: fuerza,        inline: false },
          { name: '✨ Mayor Prestige',     value: prestige,      inline: false },
        )
        .setColor(0xFFD700)
        .setFooter({ text: 'Ranking global · todos los servidores · top 3 por categoría' })
        .setTimestamp();

      borrarDespues(await interaction.editReply({ embeds: [embed] }));

    } catch (err) {
      console.error('[CMD] /top error:', err.message);
      borrarDespues(await interaction.editReply({ content: '❌ Error al obtener el ranking.' }));
    }
  }

  // ── /inspeccionar ──────────────────────────────────────────────────────────
  else if (commandName === 'inspeccionar') {
    try {
      const rareza = interaction.options.getString('rareza');
      const items  = await getRamitasItems(user.id, rareza, 10);

      if (items.length === 0) {
        return interaction.reply({
          content: rareza
            ? `📭 No tienes ramitas **${NOMBRES_RAREZA[rareza]}** todavía.`
            : '📭 Todavía no tienes ninguna ramita.',
          ephemeral: true,
        });
      }

      const tituloRareza = rareza ? NOMBRES_RAREZA[rareza] : 'Todas las rarezas';
      const lineas = items.map((item) => {
        const estiloEmoji  = ESTILOS.find(e => e.nombre === item.estilo)?.emoji ?? '⚔️';
        const formaEmoji   = FORMAS.find(f => f.nombre === item.forma)?.emoji   ?? '🌿';
        const nombreRareza = NOMBRES_RAREZA[item.rareza] ?? item.rareza;
        return `\`#${item.id}\` ${nombreRareza} · ${estiloEmoji} ${item.estilo} · ${formaEmoji} ${item.forma} — ⚡ **${item.fuerza_total}**`;
      });

      const ramitaInfo = rareza ? RAMITA_MAP[rareza] : null;
      const color = ramitaInfo ? (RAREZA_COLORES[ramitaInfo.nombre] ?? 0x5865F2) : 0x5865F2;

      const embed = new EmbedBuilder()
        .setTitle(`🔍 Tu inventario — ${tituloRareza}`)
        .setDescription(lineas.join('\n'))
        .setColor(color)
        .setFooter({ text: 'Usa /mostrar <id> para mostrarla públicamente · Solo visible para ti' })
        .setTimestamp();

      await interaction.reply({ embeds: [embed], ephemeral: true });

    } catch (err) {
      console.error('[CMD] /inspeccionar error:', err.message);
      await interaction.reply({ content: '❌ Error al inspeccionar.', ephemeral: true });
    }
  }

  // ── /mostrar ───────────────────────────────────────────────────────────────
  else if (commandName === 'mostrar') {
    await interaction.deferReply();
    try {
      const id   = interaction.options.getInteger('id');
      const item = await getRamitaItem(id);

      if (!item) {
        return interaction.editReply({ content: `❌ No existe ninguna ramita con ID \`#${id}\`.` });
      }
      if (item.user_id !== user.id) {
        return interaction.editReply({ content: '❌ Esa ramita no te pertenece.' });
      }

      const ramitaInfo = RAMITA_MAP[item.rareza] ?? { nombre: item.rareza, emoji: '🌿' };
      const estiloInfo = ESTILOS.find(e => e.nombre === item.estilo) ?? { emoji: '⚔️' };
      const formaInfo  = FORMAS.find(f => f.nombre === item.forma)  ?? { emoji: '🌿' };
      const imagen     = getImagenRamita(item.rareza);

      const embed = new EmbedBuilder()
        .setTitle(`🌿 Ramita ${ramitaInfo.nombre} ${ramitaInfo.emoji} de ${user.username}`)
        .addFields(
          { name: `${estiloInfo.emoji} Estilo`, value: `**${item.estilo}**`,     inline: true  },
          { name: `${formaInfo.emoji} Forma`,   value: `**${item.forma}**`,      inline: true  },
          { name: '\u200b',                      value: '\u200b',                  inline: true  },
          { name: '📏 Largo',                    value: `**${item.largo}**`,      inline: true  },
          { name: '⚔️ Daño',                     value: `**${item.dano}**`,       inline: true  },
          { name: '🪨 Grosor',                   value: `**${item.grosor}**`,     inline: true  },
          { name: '⚡ Fuerza Total',             value: `# ${item.fuerza_total}`, inline: false },
        )
        .setColor(RAREZA_COLORES[ramitaInfo.nombre] ?? 0x2F3136)
        .setThumbnail(user.displayAvatarURL())
        .setFooter({ text: `ID #${item.id} · Recolectada por ${user.username}` })
        .setTimestamp(item.created_at * 1000);

      if (imagen) embed.setImage('attachment://ramita.png');
      borrarDespues(await interaction.editReply({ embeds: [embed], files: imagen ? [imagen] : [] }));

    } catch (err) {
      console.error('[CMD] /mostrar error:', err.message);
      borrarDespues(await interaction.editReply({ content: '❌ Error al mostrar la ramita.' }));
    }
  }

  // ── /intercambiar ─────────────────────────────────────────────────────────
  else if (commandName === 'intercambiar') {
    await interaction.deferReply();
    try {
      const targetUser = interaction.options.getUser('usuario');
      const puntos     = interaction.options.getInteger('platanos');

      if (targetUser.id === user.id)
        return borrarDespues(await interaction.editReply({ content: '❌ No puedes intercambiar contigo mismo.' }));
      if (targetUser.bot)
        return borrarDespues(await interaction.editReply({ content: '❌ No puedes intercambiar con un bot.' }));

      const ptsOferente = await getPlatanoPoints(user.id);
      if (ptsOferente < puntos)
        return borrarDespues(await interaction.editReply({ content: `❌ No tienes suficientes 🍌 plátanos totales (tienes **${ptsOferente}**, necesitas **${puntos}**).` }));

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('trade_accept').setLabel('✅ Aceptar y elegir ramita').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('trade_decline').setLabel('❌ Rechazar').setStyle(ButtonStyle.Danger),
      );

      const embed = new EmbedBuilder()
        .setTitle('🔄 Propuesta de Intercambio')
        .setDescription(
          `<@${user.id}> te ofrece **${puntos} 🍌 plátanos totales** a cambio de una de tus ramitas.\n\n` +
          `Si aceptas, elige qué ramita darás a cambio.`
        )
        .setColor(0x5865F2)
        .setFooter({ text: `Solo ${targetUser.username} puede responder` })
        .setTimestamp();

      await ensureUser(user.id, guildId);
      await ensureUser(targetUser.id, guildId);

      const reply = await interaction.editReply({ embeds: [embed], components: [row] });

      pendingTrades.set(reply.id, {
        phase: 'offer',
        offererUserId:  user.id,
        receiverUserId: targetUser.id,
        puntos, guildId,
      });

      setTimeout(() => {
        pendingTrades.delete(reply.id);
        reply.delete().catch(() => {});
      }, AUTO_DELETE_MS);

    } catch (err) {
      console.error('[CMD] /intercambiar error:', err.message);
      borrarDespues(await interaction.editReply({ content: '❌ Error al proponer el intercambio.' }));
    }
  }

  // ── /soltar_platano ────────────────────────────────────────────────────────
  else if (commandName === 'soltar_platano') {
    if (!OWNER_ID || user.id !== OWNER_ID) {
      return interaction.reply({ content: '🔒 No tienes permiso para usar este comando.', ephemeral: true });
    }

    await interaction.reply({ content: '✅ Soltando plátano...', ephemeral: true });

    const platano = getPlatanoEvento();
    const texto = `🍌 Ha caído un plátano **${platano.nombre}** ${platano.emoji} ¡agárrenlo reaccionando!`;

    try {
      const msg = await interaction.channel.send({ content: texto });
      borrarDespues(msg);
      await msg.react('🍌');

      const collector = msg.createReactionCollector({
        filter: (reaction, u) => reaction.emoji.name === '🍌' && !u.bot,
        max:  1,
        time: 30_000,
      });

      collector.on('collect', async (_reaction, ganador) => {
        try {
          await ensureUser(ganador.id, guildId);
          const pts = await addPlatano(ganador.id, guildId, platano.columna);
          borrarDespues(await interaction.channel.send(`🐒 ¡El mono **${ganador.username}** lo ha agarrado! *(+${pts} 🍌)*`));
          console.log(`[ADMIN] Plátano manual reclamado por ${ganador.username} → ${platano.nombre} (+${pts} pts)`);
        } catch (err) {
          console.error('[ADMIN] Error al procesar ganador:', err.message);
        }
      });

      collector.on('end', (collected) => {
        if (collected.size === 0) {
          interaction.channel.send('😔 Qué pena, nadie ha agarrado el plátano.').then(borrarDespues).catch(() => {});
        }
      });

    } catch (err) {
      console.error('[ADMIN] /soltar_platano error:', err.message);
    }
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ERRORES GLOBALES
// ─────────────────────────────────────────────────────────────────────────────
process.on('unhandledRejection', (error) => {
  console.error('[ERROR] Promesa rechazada:', error?.message ?? error);
});

process.on('uncaughtException', (error) => {
  console.error('[ERROR] Excepción no capturada:', error.message);
});

// ─────────────────────────────────────────────────────────────────────────────
// ARRANQUE
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  await initDatabase();
  client.login(TOKEN).catch((err) => {
    console.error('[BOT] Error al iniciar sesión:', err.message);
    process.exit(1);
  });
})();
