// ============================================================
// Blue Lock Rivals Discord Bot — Railway-ready standalone
// Commands: /scrim  /inhouse  /tryout
// ============================================================
// Required env vars:
//   DISCORD_TOKEN      — bot token
//   DISCORD_CLIENT_ID  — application / client ID
// ============================================================

import {
  Client,
  Events,
  GatewayIntentBits,
  REST,
  Routes,
  SlashCommandBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  MessageFlags,
} from "discord.js";
import { createServer } from "http";

// ─────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────

const POSITIONS        = ["CF", "RW", "LW", "CM", "GK"];
const TEAMS            = ["HOME", "AWAY"];
const TRYOUT_DURATION  = 10 * 60 * 1000;

const RARITY_CHARACTERS = {
  RARE:        ["Isagi", "Gagamaru", "Chigiri"],
  EPIC:        ["Kurona", "Otoya", "Raichi", "Karasu"],
  LEGENDARY:   ["Ness", "Kiyora", "Nagi", "Hirori", "Bachira", "King"],
  MYTHIC:      ["Shidou", "Reo", "Aiku", "Rin", "Charles", "Yukimiya", "Kunigami"],
  WORLDCLASS:  ["Sae", "Don Lorenzo", "Kaiser"],
  MASTERCLASS: ["Loki", "Lavinho"],
  LIMITEDS: [
    "Elf Emperor", "Easter Yukimiya", "Reaper Sae", "Skeleton Nagi",
    "Phantom Isagi", "Demon Shidou", "Firework Bachira",
    "Subzero Loki", "Krampus Barou",
  ],
};
const RARITY_KEYS = Object.keys(RARITY_CHARACTERS);

// ─────────────────────────────────────────────
// In-memory session stores
// ─────────────────────────────────────────────

const activeScrims    = new Map(); // messageId → ScrimSession
const channelScrim    = new Map(); // channelId → messageId

const activeInhouses  = new Map(); // messageId → InhouseSession
const channelInhouse  = new Map(); // channelId → messageId
const lastInhouses    = new Map(); // channelId → completed InhouseSession

const activeTryouts   = new Map(); // messageId → TryoutSession
const channelTryout   = new Map(); // channelId → messageId

// ─────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────

function emptyTeam() {
  return { CF: null, RW: null, LW: null, CM: null, GK: null };
}

function findPlayerInTeams(session, userId) {
  for (const team of TEAMS)
    for (const pos of POSITIONS)
      if (session.teams[team][pos]?.userId === userId)
        return { team, position: pos };
  return null;
}

function clearTimer(session) {
  if (session.timer) { clearTimeout(session.timer); session.timer = null; }
}

// ─────────────────────────────────────────────
// Rarity / character select (shared)
// ─────────────────────────────────────────────

function raritySelect(prefix, sessionId, position) {
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${prefix}_rarity:${sessionId}:${position}`)
      .setPlaceholder("اختر فئة الشخصية")
      .addOptions(RARITY_KEYS.map((r) => ({ label: r, value: r })))
  );
}

function charSelect(prefix, sessionId, position, rarity) {
  const chars = RARITY_CHARACTERS[rarity] ?? [];
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${prefix}_char:${sessionId}:${position}`)
      .setPlaceholder(`اختر شخصيتك من ${rarity}`)
      .addOptions(chars.map((c) => ({ label: c, value: c })))
  );
}

// ═══════════════════════════════════════════
//  SCRIM
// ═══════════════════════════════════════════

function buildScrimContent(session) {
  const lines = ["# Scrim!", "**Choose your position**", ""];
  for (const pos of POSITIONS) {
    const e = session.positions[pos];
    if (e) {
      const char = e.character ? ` (${e.character})` : " (Choosing character...)";
      lines.push(`**${pos} :** <@${e.userId}>${char}`);
    } else {
      lines.push(`**${pos} :**`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function buildScrimComponents(sessionId, session) {
  const posSelect = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`scrim_pos:${sessionId}`)
      .setPlaceholder("...اختر المركز")
      .addOptions(POSITIONS.map((p) => ({ label: p, value: p })))
  );
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`scrim_changechar:${sessionId}`).setLabel("تغيير الشخصية").setEmoji("🔄").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`scrim_leave:${sessionId}`).setLabel("Leave Position").setEmoji("🚪").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`scrim_kick:${sessionId}`).setLabel("Kick Player").setStyle(ButtonStyle.Danger)
  );
  return [posSelect, buttons];
}

function buildScrimKickMenu(sessionId, session) {
  const opts = POSITIONS.filter((p) => session.positions[p] !== null).map((p) => {
    const e = session.positions[p];
    return { label: `${p}: ${e.username}`, value: `${p}:${e.userId}` };
  });
  if (!opts.length) opts.push({ label: "لا يوجد لاعبون", value: "none" });
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`scrim_kickmenu:${sessionId}`)
      .setPlaceholder("اختر لاعباً لطرده")
      .addOptions(opts)
  );
}

async function editScrimMessage(sessionId, session, client) {
  try {
    const ch = await client.channels.fetch(session.channelId);
    if (ch?.isTextBased()) {
      const msg = await ch.messages.fetch(sessionId);
      await msg.edit({ content: buildScrimContent(session), embeds: [], components: buildScrimComponents(sessionId, session) });
    }
  } catch { }
}

async function expireScrim(sessionId, client) {
  const s = activeScrims.get(sessionId);
  if (!s) return;
  clearTimer(s);
  activeScrims.delete(sessionId);
  channelScrim.delete(s.channelId);
  try {
    const ch = await client.channels.fetch(s.channelId);
    if (ch?.isTextBased()) {
      const msg = await ch.messages.fetch(sessionId);
      await msg.edit({ content: msg.content + "\n\n**Scrim has ended**", components: [] });
    }
  } catch { }
}

async function handleScrimCommand(interaction) {
  const chName = interaction.channel && "name" in interaction.channel ? interaction.channel.name : "";
  if (chName === "chat العام")
    return interaction.reply({ content: "❌ لا يمكن استخدام هذا الكوماند في **chat العام**!", flags: MessageFlags.Ephemeral });

  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (!member?.roles.cache.some((r) => r.name.toLowerCase() === "scrim hoster"))
    return interaction.reply({ content: "❌ هذا الكوماند مخصص لأصحاب رتبة **SCRIM HOSTER** فقط!", flags: MessageFlags.Ephemeral });

  const existingId = channelScrim.get(interaction.channelId);
  if (existingId) await expireScrim(existingId, interaction.client);

  const session = {
    messageId: "", channelId: interaction.channelId, hostId: interaction.user.id,
    positions: { CF: null, LW: null, RW: null, CM: null, GK: null },
    createdAt: new Date(), timer: null,
  };

  const response = await interaction.reply({ content: "⏳ جاري إنشاء السكريم...", withResponse: true });
  const messageId = response.resource?.message?.id;
  if (!messageId) return interaction.editReply({ content: "❌ فشل إنشاء السكريم." });

  session.messageId = messageId;
  activeScrims.set(messageId, session);
  channelScrim.set(interaction.channelId, messageId);

  await interaction.editReply({ content: buildScrimContent(session), embeds: [], components: buildScrimComponents(messageId, session) });
}

async function handleScrimInteraction(interaction) {
  const id = interaction.customId;
  if (id.startsWith("scrim_pos:"))        return scrimPosition(interaction);
  if (id.startsWith("scrim_rarity:"))     return scrimRarity(interaction);
  if (id.startsWith("scrim_char:"))       return scrimChar(interaction);
  if (id.startsWith("scrim_leave:"))      return scrimLeave(interaction);
  if (id.startsWith("scrim_kick:"))       return scrimKickBtn(interaction);
  if (id.startsWith("scrim_kickmenu:"))   return scrimKickMenu(interaction);
  if (id.startsWith("scrim_changechar:")) return scrimChangeChar(interaction);
}

async function scrimPosition(interaction) {
  const sessionId = interaction.customId.split(":")[1];
  const session = activeScrims.get(sessionId);
  if (!session) return interaction.reply({ content: "❌ هذا السكريم لم يعد موجوداً.", flags: MessageFlags.Ephemeral });
  const position = interaction.values[0];
  const { id: userId, username } = interaction.user;
  for (const pos of POSITIONS)
    if (session.positions[pos]?.userId === userId) session.positions[pos] = null;
  if (session.positions[position] !== null)
    return interaction.reply({ content: `❌ مركز **${position}** محجوز بالفعل!`, flags: MessageFlags.Ephemeral });
  session.positions[position] = { userId, username, character: null };
  await editScrimMessage(sessionId, session, interaction.client);
  await interaction.reply({
    content: `✅ اخترت مركز **${position}**! الآن اختر **فئة** شخصيتك:`,
    components: [raritySelect("scrim", sessionId, position)],
    flags: MessageFlags.Ephemeral,
  });
}

async function scrimRarity(interaction) {
  const [, sessionId, position] = interaction.customId.split(":");
  const rarity = interaction.values[0];
  if (!activeScrims.get(sessionId)) return interaction.update({ content: "❌ السكريم لم يعد موجوداً.", components: [] });
  await interaction.update({ content: `فئة **${rarity}** — اختر شخصيتك:`, components: [charSelect("scrim", sessionId, position, rarity)] });
}

async function scrimChar(interaction) {
  const [, sessionId, position] = interaction.customId.split(":");
  const session = activeScrims.get(sessionId);
  if (!session) return interaction.update({ content: "❌ السكريم لم يعد موجوداً.", components: [] });
  if (session.positions[position]?.userId !== interaction.user.id)
    return interaction.update({ content: "❌ هذا المركز ليس لك!", components: [] });
  session.positions[position].character = interaction.values[0];
  await interaction.update({ content: `✅ اخترت **${interaction.values[0]}** في مركز **${position}**!`, components: [] });
  await editScrimMessage(sessionId, session, interaction.client);
}

async function scrimLeave(interaction) {
  const sessionId = interaction.customId.split(":")[1];
  const session = activeScrims.get(sessionId);
  if (!session) return interaction.reply({ content: "❌ السكريم لم يعد موجوداً.", flags: MessageFlags.Ephemeral });
  let found = false;
  for (const pos of POSITIONS)
    if (session.positions[pos]?.userId === interaction.user.id) { session.positions[pos] = null; found = true; }
  if (!found) return interaction.reply({ content: "❌ أنت لست في هذا السكريم!", flags: MessageFlags.Ephemeral });
  await interaction.reply({ content: "✅ غادرت السكريم.", flags: MessageFlags.Ephemeral });
  await editScrimMessage(sessionId, session, interaction.client);
}

async function scrimKickBtn(interaction) {
  const sessionId = interaction.customId.split(":")[1];
  const session = activeScrims.get(sessionId);
  if (!session) return interaction.reply({ content: "❌ السكريم لم يعد موجوداً.", flags: MessageFlags.Ephemeral });
  if (interaction.user.id !== session.hostId) return interaction.reply({ content: "❌ فقط مضيف السكريم يمكنه طرد اللاعبين!", flags: MessageFlags.Ephemeral });
  if (!POSITIONS.some((p) => session.positions[p])) return interaction.reply({ content: "❌ لا يوجد لاعبون في السكريم.", flags: MessageFlags.Ephemeral });
  await interaction.reply({ content: "اختر اللاعب:", components: [buildScrimKickMenu(sessionId, session)], flags: MessageFlags.Ephemeral });
}

async function scrimKickMenu(interaction) {
  const sessionId = interaction.customId.split(":")[1];
  const session = activeScrims.get(sessionId);
  if (!session) return interaction.update({ content: "❌ السكريم لم يعد موجوداً.", components: [] });
  if (interaction.user.id !== session.hostId) return interaction.update({ content: "❌ فقط مضيف السكريم يمكنه طرد اللاعبين!", components: [] });
  const value = interaction.values[0];
  if (value === "none") return interaction.update({ content: "لا يوجد لاعبون.", components: [] });
  const [pos] = value.split(":");
  const kicked = session.positions[pos];
  if (!kicked) return interaction.update({ content: "❌ اللاعب لم يعد موجوداً.", components: [] });
  session.positions[pos] = null;
  await interaction.update({ content: `✅ تم طرد **${kicked.username}** من مركز **${pos}**.`, components: [] });
  await editScrimMessage(sessionId, session, interaction.client);
}

async function scrimChangeChar(interaction) {
  const sessionId = interaction.customId.split(":")[1];
  const session = activeScrims.get(sessionId);
  if (!session) return interaction.reply({ content: "❌ السكريم لم يعد موجوداً.", flags: MessageFlags.Ephemeral });
  const pos = POSITIONS.find((p) => session.positions[p]?.userId === interaction.user.id) ?? null;
  if (!pos) return interaction.reply({ content: "❌ أنت لست في هذا السكريم! اختر مركزاً أولاً.", flags: MessageFlags.Ephemeral });
  await interaction.reply({ content: `اختر **فئة** شخصيتك الجديدة في مركز **${pos}**:`, components: [raritySelect("scrim", sessionId, pos)], flags: MessageFlags.Ephemeral });
}

// ═══════════════════════════════════════════
//  Shared team content/components (Inhouse & Tryout)
// ═══════════════════════════════════════════

function buildTeamContent(session, title) {
  const lines = [`# ${title}`, ""];
  for (const team of TEAMS) {
    lines.push(`# ${team}`);
    for (const pos of POSITIONS) {
      const e = session.teams[team][pos];
      if (e) {
        const char = e.character ? ` (${e.character})` : " (Choosing character...)";
        lines.push(`**${pos}:** <@${e.userId}>${char}`);
      } else {
        lines.push(`**${pos}:**`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function buildTeamComponents(prefix, sessionId) {
  const posSelect = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${prefix}_pos:${sessionId}`)
      .setPlaceholder("...اختر مركزك")
      .addOptions(POSITIONS.map((p) => ({ label: p, value: p })))
  );
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${prefix}_changechar:${sessionId}`).setLabel("تغيير الشخصية").setEmoji("🔄").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${prefix}_leave:${sessionId}`).setLabel("Leave Position").setEmoji("🚪").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${prefix}_kick:${sessionId}`).setLabel("Kick Player").setStyle(ButtonStyle.Danger)
  );
  if (prefix === "inhouse") {
    buttons.addComponents(
      new ButtonBuilder().setCustomId(`inhouse_end:${sessionId}`).setLabel("إنهاء الإنهاوس").setEmoji("🏁").setStyle(ButtonStyle.Success)
    );
  }
  return [posSelect, buttons];
}

function buildTeamKickMenu(prefix, sessionId, session) {
  const opts = TEAMS.flatMap((team) =>
    POSITIONS.filter((p) => session.teams[team][p] !== null).map((p) => {
      const e = session.teams[team][p];
      return { label: `${team} - ${p}: ${e.username}`, value: `${team}:${p}:${e.userId}` };
    })
  );
  if (!opts.length) opts.push({ label: "لا يوجد لاعبون", value: "none" });
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${prefix}_kickmenu:${sessionId}`)
      .setPlaceholder("اختر لاعباً لطرده")
      .addOptions(opts)
  );
}

// ═══════════════════════════════════════════
//  Generic team interaction handlers
// ═══════════════════════════════════════════

async function teamPosition(interaction, store, editFn, title, prefix) {
  const sessionId = interaction.customId.split(":")[1];
  const session = store.get(sessionId);
  if (!session) return interaction.reply({ content: "❌ الجلسة لم تعد موجودة.", flags: MessageFlags.Ephemeral });
  const position = interaction.values[0];
  const { id: userId, username } = interaction.user;
  for (const t of TEAMS)
    for (const p of POSITIONS)
      if (session.teams[t][p]?.userId === userId) session.teams[t][p] = null;
  const freeTeams = TEAMS.filter((t) => session.teams[t][position] === null);
  if (!freeTeams.length)
    return interaction.reply({ content: `❌ مركز **${position}** ممتلئ في كلا الفريقين!`, flags: MessageFlags.Ephemeral });
  const assignedTeam = freeTeams[Math.floor(Math.random() * freeTeams.length)];
  session.teams[assignedTeam][position] = { userId, username, character: null };
  await editFn(sessionId, session, interaction.client);
  await interaction.reply({
    content: `✅ تم تعيينك في فريق **${assignedTeam}** مركز **${position}**!\nالآن اختر **فئة** شخصيتك:`,
    components: [raritySelect(prefix, sessionId, position)],
    flags: MessageFlags.Ephemeral,
  });
}

async function teamRarity(interaction, store, prefix) {
  const [, sessionId, position] = interaction.customId.split(":");
  const rarity = interaction.values[0];
  if (!store.get(sessionId)) return interaction.update({ content: "❌ الجلسة لم تعد موجودة.", components: [] });
  await interaction.update({ content: `فئة **${rarity}** — اختر شخصيتك:`, components: [charSelect(prefix, sessionId, position, rarity)] });
}

async function teamChar(interaction, store, editFn, title, prefix) {
  const [, sessionId, position] = interaction.customId.split(":");
  const session = store.get(sessionId);
  if (!session) return interaction.update({ content: "❌ الجلسة لم تعد موجودة.", components: [] });
  const found = findPlayerInTeams(session, interaction.user.id);
  if (!found || found.position !== position) return interaction.update({ content: "❌ هذا المركز ليس لك!", components: [] });
  const character = interaction.values[0];
  session.teams[found.team][position].character = character;
  await interaction.update({ content: `✅ اخترت **${character}** في **${found.team} - ${position}**!`, components: [] });
  await editFn(sessionId, session, interaction.client);
}

async function teamLeave(interaction, store, editFn, title, prefix) {
  const sessionId = interaction.customId.split(":")[1];
  const session = store.get(sessionId);
  if (!session) return interaction.reply({ content: "❌ الجلسة لم تعد موجودة.", flags: MessageFlags.Ephemeral });
  const found = findPlayerInTeams(session, interaction.user.id);
  if (!found) return interaction.reply({ content: "❌ أنت لست في هذه الجلسة!", flags: MessageFlags.Ephemeral });
  session.teams[found.team][found.position] = null;
  await interaction.reply({ content: "✅ غادرت بنجاح.", flags: MessageFlags.Ephemeral });
  await editFn(sessionId, session, interaction.client);
}

async function teamKickBtn(interaction, store, prefix) {
  const sessionId = interaction.customId.split(":")[1];
  const session = store.get(sessionId);
  if (!session) return interaction.reply({ content: "❌ الجلسة لم تعد موجودة.", flags: MessageFlags.Ephemeral });
  if (interaction.user.id !== session.hostId) return interaction.reply({ content: "❌ فقط من أنشأ الجلسة يمكنه طرد اللاعبين!", flags: MessageFlags.Ephemeral });
  const hasPlayers = TEAMS.some((t) => POSITIONS.some((p) => session.teams[t][p] !== null));
  if (!hasPlayers) return interaction.reply({ content: "❌ لا يوجد لاعبون.", flags: MessageFlags.Ephemeral });
  await interaction.reply({ content: "اختر اللاعب:", components: [buildTeamKickMenu(prefix, sessionId, session)], flags: MessageFlags.Ephemeral });
}

async function teamKickMenu(interaction, store, editFn, title, prefix) {
  const sessionId = interaction.customId.split(":")[1];
  const session = store.get(sessionId);
  if (!session) return interaction.update({ content: "❌ الجلسة لم تعد موجودة.", components: [] });
  if (interaction.user.id !== session.hostId) return interaction.update({ content: "❌ فقط من أنشأ الجلسة يمكنه طرد اللاعبين!", components: [] });
  const value = interaction.values[0];
  if (value === "none") return interaction.update({ content: "لا يوجد لاعبون.", components: [] });
  const [team, pos] = value.split(":");
  const kicked = session.teams[team][pos];
  if (!kicked) return interaction.update({ content: "❌ اللاعب لم يعد موجوداً.", components: [] });
  session.teams[team][pos] = null;
  await interaction.update({ content: `✅ تم طرد **${kicked.username}** من **${team} - ${pos}**.`, components: [] });
  await editFn(sessionId, session, interaction.client);
}

async function teamChangeChar(interaction, store, prefix) {
  const sessionId = interaction.customId.split(":")[1];
  const session = store.get(sessionId);
  if (!session) return interaction.reply({ content: "❌ الجلسة لم تعد موجودة.", flags: MessageFlags.Ephemeral });
  const found = findPlayerInTeams(session, interaction.user.id);
  if (!found) return interaction.reply({ content: "❌ أنت لست في هذه الجلسة! اختر مركزاً أولاً.", flags: MessageFlags.Ephemeral });
  await interaction.reply({
    content: `اختر **فئة** شخصيتك الجديدة في **${found.team} - ${found.position}**:`,
    components: [raritySelect(prefix, sessionId, found.position)],
    flags: MessageFlags.Ephemeral,
  });
}

// ═══════════════════════════════════════════
//  INHOUSE
// ═══════════════════════════════════════════

async function editInhouseMessage(sessionId, session, client) {
  try {
    const ch = await client.channels.fetch(session.channelId);
    if (ch?.isTextBased()) {
      const msg = await ch.messages.fetch(sessionId);
      await msg.edit({ content: buildTeamContent(session, "IN-HOUSE!"), embeds: [], components: buildTeamComponents("inhouse", sessionId) });
    }
  } catch { }
}

async function expireInhouse(sessionId, client) {
  const s = activeInhouses.get(sessionId);
  if (!s) return;
  clearTimer(s);
  activeInhouses.delete(sessionId);
  channelInhouse.delete(s.channelId);
  s.endedAt = new Date();
  lastInhouses.set(s.channelId, s);
  try {
    const ch = await client.channels.fetch(s.channelId);
    if (ch?.isTextBased()) {
      const msg = await ch.messages.fetch(sessionId);
      await msg.edit({ content: msg.content + "\n\n**In-house has ended**", components: [] });
    }
  } catch { }
}

function getInhousePlayers(session) {
  return TEAMS.flatMap((team) =>
    POSITIONS.filter((position) => session.teams[team][position]).map((position) => ({
      ...session.teams[team][position],
      team,
      position,
    }))
  );
}

function buildInresultView(session) {
  const players = getInhousePlayers(session);
  const embed = new EmbedBuilder()
    .setColor(0x1f8bff)
    .setTitle("🏆 تقييمات آخر إن-هاوس")
    .setDescription(
      `**المضيف:** <@${session.hostId}>\n` +
      `**عدد اللاعبين:** ${players.length}\n\n` +
      "اختر لاعباً من القائمة لكتابة تقييمه. التقييم لا يظهر إلا بعد حفظه."
    )
    .setFooter({ text: "Blue Lock Rivals • In-house Results" });

  const options = players.slice(0, 25).map((player) => ({
    label: `${player.username} • ${player.team} ${player.position}`.slice(0, 100),
    value: player.userId,
    description: player.character ? `الشخصية: ${player.character}`.slice(0, 100) : "لم يتم اختيار شخصية",
  }));
  if (!options.length) {
    options.push({ label: "لا يوجد لاعبون مسجلون", value: "none", description: "لا يمكن إضافة تقييمات" });
  }

  const select = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`inresult_player:${session.channelId}`)
      .setPlaceholder("اختر لاعباً لكتابة تقييمه")
      .addOptions(options)
  );
  const close = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`inresult_close:${session.channelId}`)
      .setLabel("إغلاق القائمة")
      .setEmoji("✖️")
      .setStyle(ButtonStyle.Secondary)
  );
  return { embeds: [embed], components: [select, close] };
}

function buildReviewModal(channelId, player) {
  return new ModalBuilder()
    .setCustomId(`inresult_modal:${channelId}:${player.userId}`)
    .setTitle(`تقييم ${player.username}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("rating")
          .setLabel("التقييم من 1 إلى 10")
          .setPlaceholder("مثال: 8")
          .setStyle(TextInputStyle.Short)
          .setMinLength(1)
          .setMaxLength(2)
          .setRequired(true)
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId("comment")
          .setLabel("اكتب تقييمك للاعب")
          .setPlaceholder("أداؤه، نقاط القوة، وما يمكن تحسينه...")
          .setStyle(TextInputStyle.Paragraph)
          .setMinLength(3)
          .setMaxLength(1000)
          .setRequired(true)
      )
    );
}

async function sendInhouseResultMessage(session, client) {
  if (session.resultSent) return;
  const players = getInhousePlayers(session);
  if (!players.length || !session.reviews || session.reviews.size < players.length) return;

  session.resultSent = true;
  try {
    const channel = await client.channels.fetch(session.channelId);
    if (channel?.isTextBased()) {
      await channel.send({
        content: `# Result\n\n${buildTeamContent(session, "IN-HOUSE!")}`,
      });
    }
  } catch (error) {
    session.resultSent = false;
    console.error("[Bot] Could not send in-house result:", error);
  }
}

async function handleInresultCommand(interaction) {
  const session = lastInhouses.get(interaction.channelId);
  if (!session)
    return interaction.reply({ content: "❌ لا يوجد إن-هاوس منتهٍ في هذه القناة. أنهِ الإنهاوس أولاً باستخدام زر **إنهاء الإنهاوس**.", flags: MessageFlags.Ephemeral });
  if (interaction.user.id !== session.hostId)
    return interaction.reply({ content: "❌ كوماند **/inresult** متاح فقط لمن أنشأ آخر **/inhouse**.", flags: MessageFlags.Ephemeral });
  return interaction.reply({ ...buildInresultView(session), flags: MessageFlags.Ephemeral });
}

async function handleInresultInteraction(interaction) {
  const [, channelId] = interaction.customId.split(":");
  const session = lastInhouses.get(channelId);
  if (!session) return interaction.update({ content: "❌ انتهت صلاحية نتائج هذا الإنهاوس.", embeds: [], components: [] });
  if (interaction.user.id !== session.hostId)
    return interaction.reply({ content: "❌ فقط منشئ الإنهاوس يستطيع كتابة التقييمات.", flags: MessageFlags.Ephemeral });

  if (interaction.customId.startsWith("inresult_close:"))
    return interaction.update({ content: "✅ تم إغلاق قائمة التقييمات.", embeds: [], components: [] });

  if (interaction.customId.startsWith("inresult_player:")) {
    const player = getInhousePlayers(session).find((p) => p.userId === interaction.values[0]);
    if (!player) return interaction.reply({ content: "❌ هذا اللاعب غير موجود في نتائج الإنهاوس.", flags: MessageFlags.Ephemeral });
    return interaction.showModal(buildReviewModal(channelId, player));
  }

  if (interaction.customId.startsWith("inresult_modal:")) {
    const playerId = interaction.customId.split(":")[2];
    const player = getInhousePlayers(session).find((p) => p.userId === playerId);
    const rating = Number(interaction.fields.getTextInputValue("rating"));
    if (!player || !Number.isInteger(rating) || rating < 1 || rating > 10)
      return interaction.reply({ content: "❌ التقييم يجب أن يكون رقماً صحيحاً من **1 إلى 10**.", flags: MessageFlags.Ephemeral });
    session.reviews ??= new Map();
    session.reviews.set(playerId, {
      playerId,
      playerName: player.username,
      team: player.team,
      position: player.position,
      rating,
      comment: interaction.fields.getTextInputValue("comment"),
      reviewerId: interaction.user.id,
      updatedAt: new Date(),
    });
    await sendInhouseResultMessage(session, interaction.client);
    return interaction.reply({ content: `✅ تم حفظ تقييم **${player.username}** بدرجة **${rating}/10**.`, flags: MessageFlags.Ephemeral });
  }
}

async function handleInhouseCommand(interaction) {
  const chName = interaction.channel && "name" in interaction.channel ? interaction.channel.name : "";
  if (chName === "chat العام")
    return interaction.reply({ content: "❌ لا يمكن استخدام هذا الكوماند في **chat العام**!", flags: MessageFlags.Ephemeral });

  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (!member?.roles.cache.some((r) => r.name.toLowerCase() === "scrim hoster"))
    return interaction.reply({ content: "❌ هذا الكوماند مخصص لأصحاب رتبة **SCRIM HOSTER** فقط!", flags: MessageFlags.Ephemeral });

  const existingId = channelInhouse.get(interaction.channelId);
  if (existingId) await expireInhouse(existingId, interaction.client);

  const session = {
    messageId: "", channelId: interaction.channelId, hostId: interaction.user.id,
    teams: { HOME: emptyTeam(), AWAY: emptyTeam() }, createdAt: new Date(), timer: null,
  };

  const response = await interaction.reply({ content: "⏳ جاري إنشاء الإن-هاوس...", withResponse: true });
  const messageId = response.resource?.message?.id;
  if (!messageId) return interaction.editReply({ content: "❌ فشل إنشاء الإن-هاوس." });

  session.messageId = messageId;
  activeInhouses.set(messageId, session);
  channelInhouse.set(interaction.channelId, messageId);

  await interaction.editReply({ content: buildTeamContent(session, "IN-HOUSE!"), embeds: [], components: buildTeamComponents("inhouse", messageId) });
}

async function endInhouse(interaction) {
  const sessionId = interaction.customId.split(":")[1];
  const session = activeInhouses.get(sessionId);
  if (!session) return interaction.reply({ content: "❌ هذا الإنهاوس منتهٍ بالفعل أو لم يعد موجوداً.", flags: MessageFlags.Ephemeral });
  if (interaction.user.id !== session.hostId)
    return interaction.reply({ content: "❌ فقط من أنشأ الإنهاوس يستطيع إنهاءه.", flags: MessageFlags.Ephemeral });
  await interaction.reply({ content: "🏁 تم إنهاء الإنهاوس وحفظ اللاعبين. استخدم **/inresult** لبدء التقييمات.", flags: MessageFlags.Ephemeral });
  await expireInhouse(sessionId, interaction.client);
}

async function handleInhouseInteraction(interaction) {
  const id = interaction.customId;
  if (id.startsWith("inhouse_end:"))          return endInhouse(interaction);
  if (id.startsWith("inhouse_pos:"))        return teamPosition(interaction, activeInhouses, editInhouseMessage, "IN-HOUSE!", "inhouse");
  if (id.startsWith("inhouse_rarity:"))     return teamRarity(interaction, activeInhouses, "inhouse");
  if (id.startsWith("inhouse_char:"))       return teamChar(interaction, activeInhouses, editInhouseMessage, "IN-HOUSE!", "inhouse");
  if (id.startsWith("inhouse_leave:"))      return teamLeave(interaction, activeInhouses, editInhouseMessage, "IN-HOUSE!", "inhouse");
  if (id.startsWith("inhouse_kick:"))       return teamKickBtn(interaction, activeInhouses, "inhouse");
  if (id.startsWith("inhouse_kickmenu:"))   return teamKickMenu(interaction, activeInhouses, editInhouseMessage, "IN-HOUSE!", "inhouse");
  if (id.startsWith("inhouse_changechar:")) return teamChangeChar(interaction, activeInhouses, "inhouse");
}

// ═══════════════════════════════════════════
//  TRYOUT
// ═══════════════════════════════════════════

async function editTryoutMessage(sessionId, session, client) {
  try {
    const ch = await client.channels.fetch(session.channelId);
    if (ch?.isTextBased()) {
      const msg = await ch.messages.fetch(sessionId);
      await msg.edit({ content: buildTeamContent(session, "TRYOUT!"), embeds: [], components: buildTeamComponents("tryout", sessionId) });
    }
  } catch { }
}

async function expireTryout(sessionId, client) {
  const s = activeTryouts.get(sessionId);
  if (!s) return;
  clearTimer(s);
  activeTryouts.delete(sessionId);
  channelTryout.delete(s.channelId);
  try {
    const ch = await client.channels.fetch(s.channelId);
    if (ch?.isTextBased()) {
      const msg = await ch.messages.fetch(sessionId);
      await msg.edit({ content: msg.content + "\n\n**Tryout has ended**", components: [] });
    }
  } catch { }
}

async function handleTryoutCommand(interaction) {
  const chName = interaction.channel && "name" in interaction.channel ? interaction.channel.name : "";
  if (chName === "chat العام")
    return interaction.reply({ content: "❌ لا يمكن استخدام هذا الكوماند في **chat العام**!", flags: MessageFlags.Ephemeral });

  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (!member?.roles.cache.some((r) => r.name.toLowerCase() === "tryout hoster"))
    return interaction.reply({ content: "❌ هذا الكوماند مخصص لأصحاب رتبة **TRYOUT HOSTER** فقط!", flags: MessageFlags.Ephemeral });

  const existingId = channelTryout.get(interaction.channelId);
  if (existingId) await expireTryout(existingId, interaction.client);

  const session = {
    messageId: "", channelId: interaction.channelId, hostId: interaction.user.id,
    teams: { HOME: emptyTeam(), AWAY: emptyTeam() }, createdAt: new Date(), timer: null,
  };

  const response = await interaction.reply({ content: "⏳ جاري إنشاء الـ Tryout...", withResponse: true });
  const messageId = response.resource?.message?.id;
  if (!messageId) return interaction.editReply({ content: "❌ فشل إنشاء الـ Tryout." });

  session.messageId = messageId;
  activeTryouts.set(messageId, session);
  channelTryout.set(interaction.channelId, messageId);
  session.timer = setTimeout(() => expireTryout(messageId, interaction.client), TRYOUT_DURATION);

  await interaction.editReply({ content: buildTeamContent(session, "TRYOUT!"), embeds: [], components: buildTeamComponents("tryout", messageId) });
}

async function handleTryoutInteraction(interaction) {
  const id = interaction.customId;
  if (id.startsWith("tryout_pos:"))        return teamPosition(interaction, activeTryouts, editTryoutMessage, "TRYOUT!", "tryout");
  if (id.startsWith("tryout_rarity:"))     return teamRarity(interaction, activeTryouts, "tryout");
  if (id.startsWith("tryout_char:"))       return teamChar(interaction, activeTryouts, editTryoutMessage, "TRYOUT!", "tryout");
  if (id.startsWith("tryout_leave:"))      return teamLeave(interaction, activeTryouts, editTryoutMessage, "TRYOUT!", "tryout");
  if (id.startsWith("tryout_kick:"))       return teamKickBtn(interaction, activeTryouts, "tryout");
  if (id.startsWith("tryout_kickmenu:"))   return teamKickMenu(interaction, activeTryouts, editTryoutMessage, "TRYOUT!", "tryout");
  if (id.startsWith("tryout_changechar:")) return teamChangeChar(interaction, activeTryouts, "tryout");
}

// ═══════════════════════════════════════════
//  Register slash commands
// ═══════════════════════════════════════════

async function registerCommands(token, clientId) {
  const commands = [
    new SlashCommandBuilder().setName("scrim").setDescription("ابدأ سكريم جديد للعبة Blue Lock Rivals").toJSON(),
    new SlashCommandBuilder().setName("inhouse").setDescription("ابدأ إن-هاوس جديد فريقين HOME وAWAY").toJSON(),
    new SlashCommandBuilder().setName("inresult").setDescription("اكتب تقييمات لاعبي آخر إن-هاوس أنشأته").toJSON(),
    new SlashCommandBuilder().setName("tryout").setDescription("ابدأ Tryout جديد فريقين HOME وAWAY").toJSON(),
  ];
  const rest = new REST().setToken(token);
  console.log("[Bot] Registering slash commands...");
  await rest.put(Routes.applicationCommands(clientId), { body: commands });
  console.log("[Bot] Slash commands registered.");
}

// ═══════════════════════════════════════════
//  Main
// ═══════════════════════════════════════════

async function main() {
  const token    = process.env.DISCORD_TOKEN;
  const clientId = process.env.DISCORD_CLIENT_ID;

  if (!token || !clientId) {
    console.error("[Bot] ERROR: DISCORD_TOKEN and DISCORD_CLIENT_ID are required.");
    process.exit(1);
  }

  await registerCommands(token, clientId);

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildMembers],
  });

  client.once(Events.ClientReady, (c) => {
    console.log(`[Bot] Ready as ${c.user.tag}`);
    c.user.setPresence({ status: "idle" });
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        if (interaction.commandName === "scrim")   return handleScrimCommand(interaction);
        if (interaction.commandName === "inhouse") return handleInhouseCommand(interaction);
        if (interaction.commandName === "inresult") return handleInresultCommand(interaction);
        if (interaction.commandName === "tryout")  return handleTryoutCommand(interaction);
        return;
      }
      if (!interaction.isStringSelectMenu() && !interaction.isButton() && !interaction.isModalSubmit()) return;
      const id = interaction.customId;
      if (id.startsWith("scrim_"))   return handleScrimInteraction(interaction);
      if (id.startsWith("inhouse_")) return handleInhouseInteraction(interaction);
      if (id.startsWith("inresult_")) return handleInresultInteraction(interaction);
      if (id.startsWith("tryout_"))  return handleTryoutInteraction(interaction);
    } catch (err) {
      console.error("[Bot] Interaction error:", err);
    }
  });

  await client.login(token);

  // Keep Railway happy — expects a port to be bound
  const port = process.env.PORT || 3000;
  createServer((req, res) => {
    res.writeHead(200);
    res.end("Bot is running");
  }).listen(port, () => {
    console.log(`[Bot] Health server listening on port ${port}`);
  });
}

main().catch((err) => { console.error("[Bot] Fatal:", err); process.exit(1); });
