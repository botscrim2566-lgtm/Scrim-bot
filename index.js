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
    new ButtonBuilder().setCustomId(`${prefix}_swap:${sessionId}`).setLabel("Swap").setEmoji("🔁").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${prefix}_kick:${sessionId}`).setLabel("Kick Player").setStyle(ButtonStyle.Danger)
  );
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

function buildTeamSwapMenu(prefix, sessionId, session, requesterId) {
  const requester = findPlayerInTeams(session, requesterId);
  const requesterEntry = requester
    ? session.teams[requester.team][requester.position]
    : null;

  const opts = TEAMS.flatMap((team) =>
    POSITIONS.filter((p) => {
      const player = session.teams[team][p];
      return player
        && player.userId !== requesterId
        && requester
        && p === requester.position
        && player.character
        && requesterEntry?.character
        && player.character === requesterEntry.character;
    }).map((p) => {
      return {
        label: `${team} — ${p}`,
        value: `${team}:${p}`,
      };
    })
  );

  if (!opts.length) opts.push({ label: "لا يوجد لاعب مطابق", value: "none" });
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${prefix}_swapmenu:${sessionId}:${requesterId}`)
      .setPlaceholder("اختر اللاعب الذي تريد تبديل الفريق معه")
      .addOptions(opts.slice(0, 25))
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

async function teamSwapBtn(interaction, store, prefix) {
  const sessionId = interaction.customId.split(":")[1];
  const session = store.get(sessionId);
  if (!session) return interaction.reply({ content: "❌ الجلسة لم تعد موجودة.", flags: MessageFlags.Ephemeral });

  const requester = findPlayerInTeams(session, interaction.user.id);
  if (!requester) return interaction.reply({ content: "❌ يجب أن تكون داخل الجلسة أولاً.", flags: MessageFlags.Ephemeral });

  const requesterEntry = session.teams[requester.team][requester.position];
  const hasMatchingPlayer = TEAMS.some((team) =>
    POSITIONS.some((pos) => {
      const player = session.teams[team][pos];
      return player
        && player.userId !== interaction.user.id
        && pos === requester.position
        && requesterEntry?.character
        && player.character === requesterEntry.character
        && team !== requester.team;
    })
  );
  if (!hasMatchingPlayer)
    return interaction.reply({
      content: "❌ يجب أن يكون اللاعب الآخر في الفريق المقابل، وبنفس المركز ونفس الشخصية.",
      flags: MessageFlags.Ephemeral,
    });

  await interaction.reply({
    content: "اختر اللاعب الذي تريد تبديل الفريق معه:",
    components: [buildTeamSwapMenu(prefix, sessionId, session, interaction.user.id)],
    flags: MessageFlags.Ephemeral,
  });
}

async function teamSwapMenu(interaction, store, prefix) {
  const [, sessionId, requesterId] = interaction.customId.split(":");
  const session = store.get(sessionId);
  if (!session) return interaction.update({ content: "❌ الجلسة لم تعد موجودة.", components: [] });
  if (interaction.user.id !== requesterId)
    return interaction.update({ content: "❌ هذه القائمة ليست مخصصة لك.", components: [] });

  const value = interaction.values[0];
  if (value === "none") return interaction.update({ content: "❌ لا يوجد لاعبون آخرون.", components: [] });

  const [targetTeam, targetPosition] = value.split(":");
  const requester = findPlayerInTeams(session, requesterId);
  const targetEntry = session.teams[targetTeam]?.[targetPosition];
  const targetId = targetEntry?.userId;
  if (!requester || !targetEntry || !targetId)
    return interaction.update({ content: "❌ لم يعد أحد اللاعبين موجوداً في الجلسة.", components: [] });
  const requesterEntry = session.teams[requester.team][requester.position];
  const target = findPlayerInTeams(session, targetId);
  if (!target || requester.team === target.team || requester.position !== target.position
      || !requesterEntry?.character || requesterEntry.character !== targetEntry.character)
    return interaction.update({
      content: "❌ يمكن التبديل فقط بين لاعبين في الفريق المقابل وبنفس المركز ونفس الشخصية.",
      components: [],
    });

  if (!session.swapRequests) session.swapRequests = new Map();
  const requestId = interaction.id;
  session.swapRequests.set(requestId, {
    requesterId,
    targetId,
    requesterTeam: requester.team,
    targetTeam: target.team,
  });

  const requestButtons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${prefix}_swapaccept:${sessionId}:${requestId}`).setLabel("Accept").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`${prefix}_swapreject:${sessionId}:${requestId}`).setLabel("Reject").setStyle(ButtonStyle.Danger)
  );

  const targetUser = await interaction.client.users.fetch(targetId).catch(() => null);
  if (!targetUser) {
    session.swapRequests.delete(requestId);
    return interaction.update({ content: "❌ تعذر الوصول إلى اللاعب لإرسال الطلب في رسالة خاصة.", components: [] });
  }

  try {
    await targetUser.send({
      content: `<@${targetId}> لديك طلب تبديل فريق من <@${requesterId}>.\nالمركز: **${requester.position}** — الشخصية: **${requesterEntry.character}**\nاضغط **Accept** للموافقة أو **Reject** للرفض.`,
      components: [requestButtons],
      allowedMentions: { users: [targetId] },
    });
  } catch {
    session.swapRequests.delete(requestId);
    return interaction.update({
      content: "❌ تعذر إرسال الطلب في رسالة خاصة. تأكد من أن الرسائل الخاصة مفعّلة لديك.",
      components: [],
    });
  }

  await interaction.update({
    content: `✅ تم إرسال طلب التبديل إلى <@${targetId}> في رسالة خاصة.`,
    components: [],
  });
}

async function teamSwapDecision(interaction, store, editFn, prefix, accepted) {
  const [, sessionId, requestId] = interaction.customId.split(":");
  const session = store.get(sessionId);
  const request = session?.swapRequests?.get(requestId);
  if (!session || !request)
    return interaction.update({ content: "❌ انتهى هذا الطلب أو لم يعد موجوداً.", components: [] });
  if (interaction.user.id !== request.targetId)
    return interaction.reply({ content: "❌ هذا الطلب مخصص للاعب الذي تم منشنه فقط.", flags: MessageFlags.Ephemeral });

  session.swapRequests.delete(requestId);
  if (!accepted)
    return interaction.update({ content: `❌ <@${request.targetId}> رفض طلب تبديل الفريق.`, components: [] });

  const requester = findPlayerInTeams(session, request.requesterId);
  const target = findPlayerInTeams(session, request.targetId);
  if (!requester || !target || requester.team === target.team)
    return interaction.update({ content: "❌ تعذر التبديل لأن أحد اللاعبين غادر أو أصبح في نفس الفريق.", components: [] });

  const requesterEntry = session.teams[requester.team][requester.position];
  const targetEntry = session.teams[target.team][target.position];
  session.teams[requester.team][requester.position] = targetEntry;
  session.teams[target.team][target.position] = requesterEntry;

  await interaction.update({
    content: `✅ تم قبول طلب التبديل! <@${request.requesterId}> و <@${request.targetId}> بدّلا الفريقين.`,
    components: [],
  });
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
  try {
    const ch = await client.channels.fetch(s.channelId);
    if (ch?.isTextBased()) {
      const msg = await ch.messages.fetch(sessionId);
      await msg.edit({ content: msg.content + "\n\n**In-house has ended**", components: [] });
    }
  } catch { }
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

async function handleInhouseInteraction(interaction) {
  const id = interaction.customId;
  if (id.startsWith("inhouse_pos:"))        return teamPosition(interaction, activeInhouses, editInhouseMessage, "IN-HOUSE!", "inhouse");
  if (id.startsWith("inhouse_rarity:"))     return teamRarity(interaction, activeInhouses, "inhouse");
  if (id.startsWith("inhouse_char:"))       return teamChar(interaction, activeInhouses, editInhouseMessage, "IN-HOUSE!", "inhouse");
  if (id.startsWith("inhouse_leave:"))      return teamLeave(interaction, activeInhouses, editInhouseMessage, "IN-HOUSE!", "inhouse");
  if (id.startsWith("inhouse_kick:"))       return teamKickBtn(interaction, activeInhouses, "inhouse");
  if (id.startsWith("inhouse_kickmenu:"))   return teamKickMenu(interaction, activeInhouses, editInhouseMessage, "IN-HOUSE!", "inhouse");
  if (id.startsWith("inhouse_swap:"))       return teamSwapBtn(interaction, activeInhouses, "inhouse");
  if (id.startsWith("inhouse_swapmenu:"))   return teamSwapMenu(interaction, activeInhouses, "inhouse");
  if (id.startsWith("inhouse_swapaccept:")) return teamSwapDecision(interaction, activeInhouses, editInhouseMessage, "inhouse", true);
  if (id.startsWith("inhouse_swapreject:")) return teamSwapDecision(interaction, activeInhouses, editInhouseMessage, "inhouse", false);
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
  if (id.startsWith("tryout_swap:"))       return teamSwapBtn(interaction, activeTryouts, "tryout");
  if (id.startsWith("tryout_swapmenu:"))   return teamSwapMenu(interaction, activeTryouts, "tryout");
  if (id.startsWith("tryout_swapaccept:")) return teamSwapDecision(interaction, activeTryouts, editTryoutMessage, "tryout", true);
  if (id.startsWith("tryout_swapreject:")) return teamSwapDecision(interaction, activeTryouts, editTryoutMessage, "tryout", false);
  if (id.startsWith("tryout_changechar:")) return teamChangeChar(interaction, activeTryouts, "tryout");
}

// ═══════════════════════════════════════════
//  Register slash commands
// ═══════════════════════════════════════════

async function registerCommands(token, clientId) {
  const commands = [
    new SlashCommandBuilder().setName("scrim").setDescription("ابدأ سكريم جديد للعبة Blue Lock Rivals").toJSON(),
    new SlashCommandBuilder().setName("inhouse").setDescription("ابدأ إن-هاوس جديد فريقين HOME وAWAY").toJSON(),
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
        if (interaction.commandName === "tryout")  return handleTryoutCommand(interaction);
        return;
      }
      if (!interaction.isStringSelectMenu() && !interaction.isButton()) return;
      const id = interaction.customId;
      if (id.startsWith("scrim_"))   return handleScrimInteraction(interaction);
      if (id.startsWith("inhouse_")) return handleInhouseInteraction(interaction);
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
