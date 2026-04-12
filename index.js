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
  REST,
  Routes,
} = require('discord.js');

const path = require('path');
const fs   = require('fs');

const { initDatabase, run, get, all } = require('./src/database/db');
const {
  RAREZA_COLORES,
  JERARQUIA_RAREZA,
  NOMBRES_RAREZA,
  getRamitaAleatoria,
  getPlatanoAleatorio,
  generarStats,
} = require('./src/utils/rng');

// ─────────────────────────────────────────────────────────────────────────────
// VARIABLES DE ENTORNO
// ─────────────────────────────────────────────────────────────────────────────
const TOKEN             = process.env.TOKEN;
const CLIENT_ID         = process.env.CLIENT_ID;
const EVENT_CHANNEL_IDS = (process.env.EVENT_CHANNEL_IDS || '')
  .split(',')
  .map(id => id.trim())
  .filter(Boolean);

if (!TOKEN)     { console.error('[CONFIG] ❌ Falta TOKEN en .env');     process.exit(1); }
if (!CLIENT_ID) { console.error('[CONFIG] ❌ Falta CLIENT_ID en .env'); process.exit(1); }

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTES DE TIEMPO
// ─────────────────────────────────────────────────────────────────────────────
const COOLDOWN_RECOLECTAR_MS = 60 * 60 * 1000; // 1 hora
const EVENTO_INTERVALO_MS    = 3_600_000;
const EVENTO_REACTION_TIME   = 30_000;

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

function getUser(userId, guildId) {
  return get('SELECT * FROM users WHERE user_id = ? AND guild_id = ?', [userId, guildId]);
}

function getRamitas(userId, guildId) {
  return get('SELECT * FROM ramitas WHERE user_id = ? AND guild_id = ?', [userId, guildId]);
}

function getPlatanos(userId, guildId) {
  return get('SELECT * FROM platanos WHERE user_id = ? AND guild_id = ?', [userId, guildId]);
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

  iniciarEventoHorario();
});

// ─────────────────────────────────────────────────────────────────────────────
// EVENTO HORARIO
// ─────────────────────────────────────────────────────────────────────────────
function iniciarEventoHorario() {
  if (EVENT_CHANNEL_IDS.length === 0) {
    console.warn('[EVENTO] EVENT_CHANNEL_IDS no definido. Evento horario deshabilitado.');
    return;
  }

  console.log(`[EVENTO] Iniciado (${EVENT_CHANNEL_IDS.length} canal(es), cada 60 min).`);

  setInterval(async () => {
    for (const channelId of EVENT_CHANNEL_IDS) {
      try {
        const canal = await client.channels.fetch(channelId).catch(() => null);
        if (!canal || !canal.isTextBased()) {
          console.warn(`[EVENTO] Canal ${channelId} no encontrado.`);
          continue;
        }

        const ramita  = getRamitaAleatoria();
        const platano = getPlatanoAleatorio();
        const imagen  = getImagenRamita(ramita.columna);

        const desc = [
          `> Una **Ramita ${ramita.nombre}** ${ramita.emoji} ha aparecido en el bosque!`,
          '',
          `Reacciona con 🍌 en los próximos **30 segundos** para reclamarla.`,
          platano ? `\n✨ **BONUS:** ¡También hay un **Plátano ${platano.nombre}** ${platano.emoji}!` : '',
        ].join('\n');

        const embed = new EmbedBuilder()
          .setTitle('🌿 ¡Evento de Recolección Horario!')
          .setDescription(desc)
          .setColor(RAREZA_COLORES[ramita.nombre] ?? 0x2F3136)
          .setTimestamp()
          .setFooter({ text: '⚡ Primer reaccionante se lo lleva • Cada hora' });

        if (imagen) embed.setImage('attachment://ramita.png');

        const msg = await canal.send({ embeds: [embed], files: imagen ? [imagen] : [] });
        await msg.react('🍌');

        const collector = msg.createReactionCollector({
          filter: (reaction, user) => reaction.emoji.name === '🍌' && !user.bot,
          max:  1,
          time: EVENTO_REACTION_TIME,
        });

        collector.on('collect', async (_reaction, ganador) => {
          try {
            ensureUser(ganador.id, canal.guild.id);
            addRamita(ganador.id, canal.guild.id, ramita.columna);

            let texto = `<@${ganador.id}> reclamó la **Ramita ${ramita.nombre}** ${ramita.emoji}!`;
            if (platano) {
              addPlatano(ganador.id, canal.guild.id, platano.columna);
              texto += `\n🎁 ¡Y también obtuvo un **Plátano ${platano.nombre}** ${platano.emoji}!`;
            }

            await canal.send({
              embeds: [new EmbedBuilder()
                .setTitle('🎉 ¡Evento Reclamado!')
                .setDescription(texto)
                .setColor(0x57F287)
                .setThumbnail(ganador.displayAvatarURL())
                .setTimestamp()],
            });
            console.log(`[EVENTO] Reclamado por ${ganador.tag} → ${ramita.nombre}`);
          } catch (err) {
            console.error('[EVENTO] Error al procesar ganador:', err.message);
          }
        });

        collector.on('end', (collected) => {
          if (collected.size === 0) {
            canal.send({
              embeds: [new EmbedBuilder()
                .setTitle('⏰ Evento Expirado')
                .setDescription('Nadie reaccionó a tiempo... Las ramitas volvieron al bosque.')
                .setColor(0xED4245)
                .setTimestamp()],
            }).catch(() => {});
          }
        });

        console.log(`[EVENTO] Lanzado en #${canal.name} → ${ramita.nombre}${platano ? ` + ${platano.nombre}` : ''}`);

      } catch (err) {
        console.error('[EVENTO] Error:', err.message);
      }
    }
  }, EVENTO_INTERVALO_MS);
}

// ─────────────────────────────────────────────────────────────────────────────
// SLASH COMMANDS HANDLER
// ─────────────────────────────────────────────────────────────────────────────
client.on('interactionCreate', async (interaction) => {
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
      const ramita  = getRamitaAleatoria();
      const platano = getPlatanoAleatorio();
      const stats   = generarStats(ramita.columna);
      const imagen  = getImagenRamita(ramita.columna);

      addRamita(user.id, guildId, ramita.columna, stats);

      const bonusTexto = platano
        ? `\n🎁 **¡BONUS!** También encontraste un **Plátano ${platano.nombre}** ${platano.emoji}!`
        : '';
      if (platano) addPlatano(user.id, guildId, platano.columna);

      const embed = new EmbedBuilder()
        .setTitle(`🌿 ¡Ramita ${ramita.nombre} encontrada! ${ramita.emoji}`)
        .setDescription(`¡Encontraste una ramita en el bosque!${bonusTexto}`)
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

      await interaction.editReply({ embeds: [embed], files: imagen ? [imagen] : [] });

    } catch (err) {
      console.error('[CMD] /recolectar error:', err.message);
      await interaction.editReply({ content: '❌ Error al recolectar. Inténtalo de nuevo.' });
    }
  }

  // ── /inventario ────────────────────────────────────────────────────────────
  else if (commandName === 'inventario') {
    await interaction.deferReply();
    try {
      ensureUser(user.id, guildId);
      const ramitas  = getRamitas(user.id, guildId);
      const platanos = getPlatanos(user.id, guildId);

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

      await interaction.editReply({ embeds: [embed] });

    } catch (err) {
      console.error('[CMD] /inventario error:', err.message);
      await interaction.editReply({ content: '❌ Error al obtener el inventario.' });
    }
  }

  // ── /perfil ────────────────────────────────────────────────────────────────
  else if (commandName === 'perfil') {
    await interaction.deferReply();
    try {
      ensureUser(user.id, guildId);
      const userData = getUser(user.id, guildId);
      const ramitas  = getRamitas(user.id, guildId);
      const platanos = getPlatanos(user.id, guildId);

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

      await interaction.editReply({ embeds: [embed] });

    } catch (err) {
      console.error('[CMD] /perfil error:', err.message);
      await interaction.editReply({ content: '❌ Error al obtener el perfil.' });
    }
  }

  // ── /top ───────────────────────────────────────────────────────────────────
  else if (commandName === 'top') {
    await interaction.deferReply();
    try {
      const MEDALLAS = ['🥇', '🥈', '🥉'];

      async function buildField(rows, valorFn) {
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
        return lines.join('\n');
      }

      const [recolecciones, fuerza, prestige] = await Promise.all([
        buildField(getTopRecolecciones(5), row => `🌿 **${row.total}** recolecciones`),
        buildField(getTopFuerza(5),        row => `⚡ **${row.max_fuerza}** fuerza *(${NOMBRES_RAREZA[row.rareza] ?? row.rareza})*`),
        buildField(getTopPrestige(5),      row => `✨ **${row.score}** pts`),
      ]);

      const embed = new EmbedBuilder()
        .setTitle('🏆 Tops Globales')
        .addFields(
          { name: '🌿 Más Recolecciones', value: recolecciones, inline: false },
          { name: '⚡ Mayor Fuerza',       value: fuerza,        inline: false },
          { name: '✨ Mayor Prestige',     value: prestige,      inline: false },
        )
        .setColor(0xFFD700)
        .setFooter({ text: 'Ranking global · todos los servidores · top 5 por categoría' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });

    } catch (err) {
      console.error('[CMD] /top error:', err.message);
      await interaction.editReply({ content: '❌ Error al obtener el ranking.' });
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
