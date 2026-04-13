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
  PLATANOS,
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
const RAMITA_MAP  = Object.fromEntries(RAMITAS.map(r => [r.columna, r]));
const PLATANO_MAP = Object.fromEntries(PLATANOS.map(p => [p.columna, p]));

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
const COOLDOWN_RECOLECTAR_MS  = 60 * 60 * 1000; // 1 hora
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
function ensureUser(userId, guildId) {
  run('INSERT OR IGNORE INTO users    (user_id, guild_id) VALUES (?, ?)', [userId, guildId]);
  run('INSERT OR IGNORE INTO ramitas  (user_id, guild_id) VALUES (?, ?)', [userId, guildId]);
  run('INSERT OR IGNORE INTO platanos (user_id, guild_id) VALUES (?, ?)', [userId, guildId]);
}

function addRamita(userId, guildId, columna, stats) {
  if (!VALID_RAMITA_COLS.has(columna)) throw new Error(`Columna inválida: ${columna}`);
  run(`UPDATE ramitas SET ${columna} = ${columna} + 1 WHERE user_id = ? AND guild_id = ?`, [userId, guildId]);
  run('UPDATE users SET total_collected = total_collected + 1 WHERE user_id = ? AND guild_id = ?', [userId, guildId]);
  run(
    `INSERT INTO ramitas_items (user_id, guild_id, rareza, estilo, forma, largo, dano, grosor, fuerza_total)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, guildId, columna, stats.estilo.nombre, stats.forma.nombre,
     stats.largo, stats.dano, stats.grosor, stats.fuerzaTotal]
  );
}

function addPlatano(userId, guildId, columna) {
  if (!VALID_PLATANO_COLS.has(columna)) throw new Error(`Columna inválida: ${columna}`);
  run(`UPDATE platanos SET ${columna} = ${columna} + 1 WHERE user_id = ? AND guild_id = ?`, [userId, guildId]);
}

// Por servidor — usado en intercambios
function getRamitasGuild(userId, guildId) {
  return get('SELECT * FROM ramitas WHERE user_id = ? AND guild_id = ?', [userId, guildId]);
}

function getPlatanasGuild(userId, guildId) {
  return get('SELECT * FROM platanos WHERE user_id = ? AND guild_id = ?', [userId, guildId]);
}

function transferirRamita(fromId, toId, guildId, columna) {
  run(`UPDATE ramitas SET ${columna} = ${columna} - 1 WHERE user_id = ? AND guild_id = ?`, [fromId, guildId]);
  run(`UPDATE ramitas SET ${columna} = ${columna} + 1 WHERE user_id = ? AND guild_id = ?`, [toId, guildId]);
}

function transferirPlatanos(fromId, toId, guildId, columna, cantidad) {
  run(`UPDATE platanos SET ${columna} = ${columna} - ? WHERE user_id = ? AND guild_id = ?`, [cantidad, fromId, guildId]);
  run(`UPDATE platanos SET ${columna} = ${columna} + ? WHERE user_id = ? AND guild_id = ?`, [cantidad, toId, guildId]);
}

// Versiones globales (suma todos los servidores) — usadas en /perfil e /inventario
function getRamitasGlobal(userId) {
  return get(
    `SELECT SUM(comun) AS comun, SUM(poco_comun) AS poco_comun, SUM(rara) AS rara,
            SUM(extrana) AS extrana, SUM(mistica) AS mistica, SUM(epica) AS epica,
            SUM(legendaria) AS legendaria, SUM(cosmica) AS cosmica, SUM(divina) AS divina
     FROM ramitas WHERE user_id = ?`,
    [userId]
  );
}

function getPlatanasGlobal(userId) {
  return get(
    `SELECT SUM(elementales) AS elementales, SUM(avanzados) AS avanzados,
            SUM(galacticos) AS galacticos, SUM(esencia) AS esencia
     FROM platanos WHERE user_id = ?`,
    [userId]
  );
}

function getUserGlobal(userId) {
  return get(
    'SELECT SUM(total_collected) AS total_collected FROM users WHERE user_id = ?',
    [userId]
  );
}

function getTopRecolecciones(limit = 10) {
  return all(
    `SELECT user_id, SUM(total_collected) AS total
     FROM users GROUP BY user_id ORDER BY total DESC LIMIT ?`,
    [limit]
  );
}

function getTopFuerza(limit = 10) {
  return all(
    `SELECT user_id, MAX(fuerza_total) AS max_fuerza, rareza
     FROM ramitas_items GROUP BY user_id ORDER BY max_fuerza DESC LIMIT ?`,
    [limit]
  );
}

function getTopPrestige(limit = 10) {
  return all(
    `SELECT user_id,
       SUM(comun*1 + poco_comun*2 + rara*4 + extrana*8 + mistica*16
           + epica*32 + legendaria*64 + cosmica*128 + divina*256) AS score
     FROM ramitas GROUP BY user_id ORDER BY score DESC LIMIT ?`,
    [limit]
  );
}

function getRamitasItems(userId, rareza, limit = 10) {
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

function getRamitaItem(id) {
  return get('SELECT * FROM ramitas_items WHERE id = ?', [id]);
}

function getPosicionRecolecciones(userId) {
  const row = get(
    `SELECT COUNT(*) + 1 AS pos FROM (
       SELECT user_id, SUM(total_collected) AS total FROM users GROUP BY user_id
     ) AS r WHERE total > COALESCE((SELECT SUM(total_collected) FROM users WHERE user_id = ?), 0)`,
    [userId]
  );
  return row?.pos ?? null;
}

function getPosicionFuerza(userId) {
  const row = get(
    `SELECT COUNT(*) + 1 AS pos FROM (
       SELECT user_id, MAX(fuerza_total) AS max_fuerza FROM ramitas_items GROUP BY user_id
     ) AS r WHERE max_fuerza > COALESCE((SELECT MAX(fuerza_total) FROM ramitas_items WHERE user_id = ?), 0)`,
    [userId]
  );
  return row?.pos ?? null;
}

function getPosicionPrestige(userId) {
  const row = get(
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
    .setDescription('🔄 Ofrece 1 ramita a cambio de plátanos de otro usuario')
    .addUserOption(opt =>
      opt.setName('usuario').setDescription('Usuario con quien intercambiar').setRequired(true)
    )
    .addStringOption(opt =>
      opt.setName('ramita').setDescription('Rareza de la ramita que ofreces').setRequired(true)
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
    .addStringOption(opt =>
      opt.setName('tipo_platano').setDescription('Tipo de plátano que pides').setRequired(true)
        .addChoices(
          { name: '🔥 Elementales', value: 'elementales' },
          { name: '⚡ Avanzados',   value: 'avanzados'   },
          { name: '🌠 Galácticos',  value: 'galacticos'  },
          { name: '💠 Esencia',     value: 'esencia'     },
        )
    )
    .addIntegerOption(opt =>
      opt.setName('cantidad').setDescription('Cantidad de plátanos que pides').setRequired(true).setMinValue(1)
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
// EVENTO DE PLÁTANO — cada 30 min
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
          ensureUser(ganador.id, canal.guild.id);
          addPlatano(ganador.id, canal.guild.id, platano.columna);
          borrarDespues(await canal.send(`🐒 ¡El mono **${ganador.username}** lo ha agarrado!`));
          console.log(`[PLÁTANO] Reclamado por ${ganador.username} → ${platano.nombre}`);
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
  console.log('[PLÁTANO] Iniciado (cada 15 min).');
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

    if (!trade) {
      return interaction.reply({ content: '❌ Esta propuesta ya expiró.', ephemeral: true });
    }
    if (interaction.user.id !== trade.receiverUserId) {
      return interaction.reply({ content: '❌ Esta propuesta no es para ti.', ephemeral: true });
    }

    pendingTrades.delete(interaction.message.id);

    if (interaction.customId === 'trade_decline') {
      await interaction.update({ content: '❌ Intercambio rechazado.', embeds: [], components: [] });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 5_000);
      return;
    }

    // Verificar que ambos sigan teniendo lo acordado
    const ramitasOferente  = getRamitasGuild(trade.offererUserId, trade.guildId);
    const platanasReceptor = getPlatanasGuild(trade.receiverUserId, trade.guildId);

    if ((ramitasOferente?.[trade.rareza] ?? 0) < 1) {
      await interaction.update({ content: '❌ El intercambio falló: el oferente ya no tiene esa ramita.', embeds: [], components: [] });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 8_000);
      return;
    }
    if ((platanasReceptor?.[trade.platanoColumna] ?? 0) < trade.cantidad) {
      await interaction.update({ content: '❌ El intercambio falló: ya no tienes suficientes plátanos.', embeds: [], components: [] });
      setTimeout(() => interaction.deleteReply().catch(() => {}), 8_000);
      return;
    }

    // Ejecutar intercambio
    transferirRamita(trade.offererUserId, trade.receiverUserId, trade.guildId, trade.rareza);
    transferirPlatanos(trade.receiverUserId, trade.offererUserId, trade.guildId, trade.platanoColumna, trade.cantidad);

    const ramitaInfo  = RAMITA_MAP[trade.rareza];
    const platanoInfo = PLATANO_MAP[trade.platanoColumna];

    const embed = new EmbedBuilder()
      .setTitle('✅ ¡Intercambio completado!')
      .setDescription(
        `<@${trade.offererUserId}> entregó ${ramitaInfo.emoji} **Ramita ${ramitaInfo.nombre}**\n` +
        `<@${trade.receiverUserId}> entregó **${trade.cantidad}x Plátano ${platanoInfo.nombre}** ${platanoInfo.emoji}`
      )
      .setColor(0x57F287)
      .setTimestamp();

    await interaction.update({ embeds: [embed], components: [] });
    setTimeout(() => interaction.deleteReply().catch(() => {}), AUTO_DELETE_MS);
    return;
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
      ensureUser(user.id, guildId);
      const ramita = getRamitaAleatoria();
      const stats  = generarStats(ramita.columna);
      const imagen = getImagenRamita(ramita.columna);

      addRamita(user.id, guildId, ramita.columna, stats);

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
        .setFooter({ text: 'Cooldown: 1 hora • /inventario para ver tu colección' })
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
      ensureUser(user.id, guildId);
      const ramitas  = getRamitasGlobal(user.id);
      const platanos = getPlatanasGlobal(user.id);

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
      ensureUser(user.id, guildId);
      const userData = getUserGlobal(user.id);
      const ramitas  = getRamitasGlobal(user.id);
      const platanos = getPlatanasGlobal(user.id);

      const COLS_R = ['comun','poco_comun','rara','extrana','mistica','epica','legendaria','cosmica','divina'];
      const COLS_P = ['elementales','avanzados','galacticos','esencia'];

      const totalRamitas  = COLS_R.reduce((s, k) => s + (ramitas[k]  ?? 0), 0);
      const totalPlatanos = COLS_P.reduce((s, k) => s + (platanos[k] ?? 0), 0);

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

      const [posR, posF, posP] = [
        getPosicionRecolecciones(user.id),
        getPosicionFuerza(user.id),
        getPosicionPrestige(user.id),
      ];

      const [recolecciones, fuerza, prestige] = await Promise.all([
        buildField(getTopRecolecciones(3), row => `🌿 **${row.total}** recolecciones`,                                        user.id, posR),
        buildField(getTopFuerza(3),        row => `⚡ **${row.max_fuerza}** fuerza *(${NOMBRES_RAREZA[row.rareza] ?? row.rareza})*`, user.id, posF),
        buildField(getTopPrestige(3),      row => `✨ **${row.score}** pts`,                                                   user.id, posP),
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
      const items  = getRamitasItems(user.id, rareza, 10);

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
      const item = getRamitaItem(id);

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
      const targetUser      = interaction.options.getUser('usuario');
      const rareza          = interaction.options.getString('ramita');
      const platanoColumna  = interaction.options.getString('tipo_platano');
      const cantidad        = interaction.options.getInteger('cantidad');

      if (targetUser.id === user.id)
        return borrarDespues(await interaction.editReply({ content: '❌ No puedes intercambiar contigo mismo.' }));
      if (targetUser.bot)
        return borrarDespues(await interaction.editReply({ content: '❌ No puedes intercambiar con un bot.' }));

      ensureUser(user.id, guildId);
      ensureUser(targetUser.id, guildId);

      const ramitasOferente  = getRamitasGuild(user.id, guildId);
      const platanasReceptor = getPlatanasGuild(targetUser.id, guildId);
      const ramitaInfo       = RAMITA_MAP[rareza];
      const platanoInfo      = PLATANO_MAP[platanoColumna];

      if ((ramitasOferente?.[rareza] ?? 0) < 1)
        return borrarDespues(await interaction.editReply({ content: `❌ No tienes ninguna **Ramita ${ramitaInfo.nombre}** en este servidor.` }));

      if ((platanasReceptor?.[platanoColumna] ?? 0) < cantidad)
        return borrarDespues(await interaction.editReply({ content: `❌ <@${targetUser.id}> no tiene ${cantidad}x **Plátano ${platanoInfo.nombre}** en este servidor.` }));

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('trade_accept').setLabel('✅ Aceptar').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('trade_decline').setLabel('❌ Rechazar').setStyle(ButtonStyle.Danger),
      );

      const embed = new EmbedBuilder()
        .setTitle('🔄 Propuesta de Intercambio')
        .setDescription(`<@${user.id}> quiere intercambiar con <@${targetUser.id}>`)
        .addFields(
          { name: `${user.username} ofrece`,        value: `${ramitaInfo.emoji} 1x Ramita **${ramitaInfo.nombre}**`,            inline: true },
          { name: `${targetUser.username} debe dar`, value: `${platanoInfo.emoji} ${cantidad}x Plátano **${platanoInfo.nombre}**`, inline: true },
        )
        .setColor(0x5865F2)
        .setFooter({ text: `Solo ${targetUser.username} puede responder` })
        .setTimestamp();

      const reply = await interaction.editReply({ embeds: [embed], components: [row] });

      pendingTrades.set(reply.id, {
        offererUserId: user.id,
        receiverUserId: targetUser.id,
        rareza, platanoColumna, cantidad, guildId,
      });

      // Expirar después de AUTO_DELETE_MS
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
    let texto = `🍌 Ha caído un plátano **${platano.nombre}** ${platano.emoji} ¡agárrenlo reaccionando!`;

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
          ensureUser(ganador.id, guildId);
          addPlatano(ganador.id, guildId, platano.columna);
          borrarDespues(await interaction.channel.send(`🐒 ¡El mono **${ganador.username}** lo ha agarrado!`));
          console.log(`[ADMIN] Plátano manual reclamado por ${ganador.username} → ${platano.nombre}`);
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
// ARRANQUE (async para poder await initDatabase)
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
  await initDatabase();
  client.login(TOKEN).catch((err) => {
    console.error('[BOT] Error al iniciar sesión:', err.message);
    process.exit(1);
  });
})();
