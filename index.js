// ============================================================
// Blue Lock Rivals Discord Bot — Railway-ready standalone
// Commands: /scrim  /inhouse  /8vs8  /tryout
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

const POSITIONS              = ["CF", "RW", "LW", "CM", "GK"];
const TEAM_POSITIONS         = ["CF", "RW", "LW", "CM", "GK"];
const EIGHT_V_EIGHT_POSITIONS = ["CFR", "CFL", "LW", "RW", "LM", "RM", "CM", "GK"];
const TEAMS                  = ["HOME", "AWAY"];
const TRYOUT_DURATION        = 10 * 60 * 1000;

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

const active8v8s       = new Map(); // messageId → EightVEightSession
const channel8v8       = new Map(); // channelId → messageId

// ─────────────────────────────────────────────
// Shared helpers
// ─────────────────────────────────────────────

function emptyTeam(positions = TEAM_POSITIONS) {
  return Object.fromEntries(positions.map((position) => [position, null]));
}

function findPlayerInTeams(session, userId, positions = session.positions ?? TEAM_POSITIONS) {
  for (const team of TEAMS)
    for (const pos of positions)
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
      .setPlaceholder("Choose a character category")
      .addOptions(RARITY_KEYS.map((r) => ({ label: r, value: r })))
  );
}

function charSelect(prefix, sessionId, position, rarity) {
  const chars = RARITY_CHARACTERS[rarity] ?? [];
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${prefix}_char:${sessionId}:${position}`)
      .setPlaceholder(`Choose your character from ${rarity}`)
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
      .setPlaceholder("Choose a position...")
      .addOptions(POSITIONS.map((p) => ({ label: p, value: p })))
  );
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`scrim_changechar:${sessionId}`).setLabel("Change Character").setEmoji("🔄").setStyle(ButtonStyle.Primary),
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
   if (!opts.length) opts.push({ label: "No players", value: "none" });
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`scrim_kickmenu:${sessionId}`)
      .setPlaceholder("Choose a player to kick")
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
  if (chName === "chat \u0627\u0644\u0639\u0627\u0645")
    return interaction.reply({ content: "❌ This command cannot be used in **general chat**!", flags: MessageFlags.Ephemeral });

  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (!member?.roles.cache.some((r) => r.name.toLowerCase() === "scrim hoster"))
    return interaction.reply({ content: "❌ This command is only for members with the **SCRIM HOSTER** role!", flags: MessageFlags.Ephemeral });

  const existingId = channelScrim.get(interaction.channelId);
  if (existingId) await expireScrim(existingId, interaction.client);

  const session = {
    messageId: "", channelId: interaction.channelId, hostId: interaction.user.id,
    positions: { CF: null, LW: null, RW: null, CM: null, GK: null },
    createdAt: new Date(), timer: null,
  };

  const response = await interaction.reply({ content: "⏳ Creating scrim...", withResponse: true });
  const messageId = response.resource?.message?.id;
  if (!messageId) return interaction.editReply({ content: "❌ Failed to create the scrim." });

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
  if (!session) return interaction.reply({ content: "❌ This scrim no longer exists.", flags: MessageFlags.Ephemeral });
  const position = interaction.values[0];
  const { id: userId, username } = interaction.user;
  for (const pos of POSITIONS)
    if (session.positions[pos]?.userId === userId) session.positions[pos] = null;
  if (session.positions[position] !== null)
    return interaction.reply({ content: `❌ Position **${position}** is already taken!`, flags: MessageFlags.Ephemeral });
  session.positions[position] = { userId, username, character: null };
  await editScrimMessage(sessionId, session, interaction.client);
  await interaction.reply({
    content: `✅ You chose **${position}**! Now choose your character **category**:`,
    components: [raritySelect("scrim", sessionId, position)],
    flags: MessageFlags.Ephemeral,
  });
}

async function scrimRarity(interaction) {
  const [, sessionId, position] = interaction.customId.split(":");
  const rarity = interaction.values[0];
  if (!activeScrims.get(sessionId)) return interaction.update({ content: "❌ This scrim no longer exists.", components: [] });
  await interaction.update({ content: `Category **${rarity}** — choose your character:`, components: [charSelect("scrim", sessionId, position, rarity)] });
}

async function scrimChar(interaction) {
  const [, sessionId, position] = interaction.customId.split(":");
  const session = activeScrims.get(sessionId);
  if (!session) return interaction.update({ content: "❌ This scrim no longer exists.", components: [] });
  if (session.positions[position]?.userId !== interaction.user.id)
    return interaction.update({ content: "❌ This position is not assigned to you!", components: [] });
  session.positions[position].character = interaction.values[0];
  await interaction.update({ content: `✅ You chose **${interaction.values[0]}** for the **${position}** position!`, components: [] });
  await editScrimMessage(sessionId, session, interaction.client);
}

async function scrimLeave(interaction) {
  const sessionId = interaction.customId.split(":")[1];
  const session = activeScrims.get(sessionId);
  if (!session) return interaction.reply({ content: "❌ This scrim no longer exists.", flags: MessageFlags.Ephemeral });
  let found = false;
  for (const pos of POSITIONS)
    if (session.positions[pos]?.userId === interaction.user.id) { session.positions[pos] = null; found = true; }
  if (!found) return interaction.reply({ content: "❌ You are not in this scrim!", flags: MessageFlags.Ephemeral });
  await interaction.reply({ content: "✅ You left the scrim.", flags: MessageFlags.Ephemeral });
  await editScrimMessage(sessionId, session, interaction.client);
}

async function scrimKickBtn(interaction) {
  const sessionId = interaction.customId.split(":")[1];
  const session = activeScrims.get(sessionId);
  if (!session) return interaction.reply({ content: "❌ This scrim no longer exists.", flags: MessageFlags.Ephemeral });
  if (interaction.user.id !== session.hostId) return interaction.reply({ content: "❌ Only the scrim host can kick players!", flags: MessageFlags.Ephemeral });
  if (!POSITIONS.some((p) => session.positions[p])) return interaction.reply({ content: "❌ There are no players in this scrim.", flags: MessageFlags.Ephemeral });
  await interaction.reply({ content: "Choose a player:", components: [buildScrimKickMenu(sessionId, session)], flags: MessageFlags.Ephemeral });
}

async function scrimKickMenu(interaction) {
  const sessionId = interaction.customId.split(":")[1];
  const session = activeScrims.get(sessionId);
  if (!session) return interaction.update({ content: "❌ This scrim no longer exists.", components: [] });
  if (interaction.user.id !== session.hostId) return interaction.update({ content: "❌ Only the scrim host can kick players!", components: [] });
  const value = interaction.values[0];
  if (value === "none") return interaction.update({ content: "There are no players.", components: [] });
  const [pos] = value.split(":");
  const kicked = session.positions[pos];
  if (!kicked) return interaction.update({ content: "❌ This player is no longer in the scrim.", components: [] });
  session.positions[pos] = null;
  await interaction.update({ content: `✅ **${kicked.username}** was kicked from the **${pos}** position.`, components: [] });
  await editScrimMessage(sessionId, session, interaction.client);
}

async function scrimChangeChar(interaction) {
  const sessionId = interaction.customId.split(":")[1];
  const session = activeScrims.get(sessionId);
  if (!session) return interaction.reply({ content: "❌ This scrim no longer exists.", flags: MessageFlags.Ephemeral });
  const pos = POSITIONS.find((p) => session.positions[p]?.userId === interaction.user.id) ?? null;
  if (!pos) return interaction.reply({ content: "❌ You are not in this scrim! Choose a position first.", flags: MessageFlags.Ephemeral });
  await interaction.reply({ content: `Choose a **category** for your new character in the **${pos}** position:`, components: [raritySelect("scrim", sessionId, pos)], flags: MessageFlags.Ephemeral });
}

// ═══════════════════════════════════════════
//  Shared team content/components (Inhouse, 8vs8 & Tryout)
// ═══════════════════════════════════════════

function buildTeamContent(session, title, positions = TEAM_POSITIONS, teamLabels = {}) {
  const lines = [`# ${title}`, ""];
  for (const team of TEAMS) {
    lines.push(`# ${teamLabels[team] ?? team}`);
    for (const pos of positions) {
      const e = session.teams[team][pos];
      if (e) {
        const char = e.character ? ` (${e.character})` : " (Choosing character...)";
        lines.push(`**${pos} :** <@${e.userId}>${char}`);
      } else {
        lines.push(`**${pos} :**`);
      }
    }
    lines.push("");
  }
  return lines.join("\n");
}

function buildTeamComponents(prefix, sessionId, positions = TEAM_POSITIONS) {
  const posSelect = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${prefix}_pos:${sessionId}`)
      .setPlaceholder("Choose your position...")
      .addOptions(positions.map((p) => ({ label: p, value: p })))
  );
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`${prefix}_changechar:${sessionId}`).setLabel("Change Character").setEmoji("🔄").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId(`${prefix}_leave:${sessionId}`).setLabel("Leave Position").setEmoji("🚪").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`${prefix}_kick:${sessionId}`).setLabel("Kick Player").setStyle(ButtonStyle.Danger)
  );
  return [posSelect, buttons];
}

function buildTeamKickMenu(prefix, sessionId, session, positions = session.positions ?? TEAM_POSITIONS) {
  const opts = TEAMS.flatMap((team) =>
    positions.filter((p) => session.teams[team][p] !== null).map((p) => {
      const e = session.teams[team][p];
      return { label: `${team} - ${p}: ${e.username}`, value: `${team}:${p}:${e.userId}` };
    })
  );
  if (!opts.length) opts.push({ label: "No players", value: "none" });
  return new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId(`${prefix}_kickmenu:${sessionId}`)
      .setPlaceholder("Choose a player to kick")
      .addOptions(opts)
  );
}

// ═══════════════════════════════════════════
//  Generic team interaction handlers
// ═══════════════════════════════════════════

async function teamPosition(interaction, store, editFn, title, prefix, positions) {
  const sessionId = interaction.customId.split(":")[1];
  const session = store.get(sessionId);
  if (!session) return interaction.reply({ content: "❌ This session no longer exists.", flags: MessageFlags.Ephemeral });
  const teamPositions = positions ?? session.positions ?? TEAM_POSITIONS;
  const position = interaction.values[0];
  const { id: userId, username } = interaction.user;
  for (const t of TEAMS)
    for (const p of teamPositions)
      if (session.teams[t][p]?.userId === userId) session.teams[t][p] = null;
  const freeTeams = TEAMS.filter((t) => session.teams[t][position] === null);
  if (!freeTeams.length)
    return interaction.reply({ content: `❌ Position **${position}** is full on both teams!`, flags: MessageFlags.Ephemeral });
  const assignedTeam = freeTeams[Math.floor(Math.random() * freeTeams.length)];
  session.teams[assignedTeam][position] = { userId, username, character: null };
  await editFn(sessionId, session, interaction.client);
  await interaction.reply({
    content: `✅ You were assigned to **${assignedTeam}** at the **${position}** position!\nNow choose your character **category**:`,
    components: [raritySelect(prefix, sessionId, position)],
    flags: MessageFlags.Ephemeral,
  });
}

async function teamRarity(interaction, store, prefix) {
  const [, sessionId, position] = interaction.customId.split(":");
  const rarity = interaction.values[0];
  if (!store.get(sessionId)) return interaction.update({ content: "❌ This session no longer exists.", components: [] });
  await interaction.update({ content: `Category **${rarity}** — choose your character:`, components: [charSelect(prefix, sessionId, position, rarity)] });
}

async function teamChar(interaction, store, editFn, title, prefix, positions) {
  const [, sessionId, position] = interaction.customId.split(":");
  const session = store.get(sessionId);
  if (!session) return interaction.update({ content: "❌ This session no longer exists.", components: [] });
  const found = findPlayerInTeams(session, interaction.user.id, positions ?? session.positions ?? TEAM_POSITIONS);
  if (!found || found.position !== position) return interaction.update({ content: "❌ This position is not assigned to you!", components: [] });
  const character = interaction.values[0];
  session.teams[found.team][position].character = character;
  await interaction.update({ content: `✅ You chose **${character}** at **${found.team} - ${position}**!`, components: [] });
  await editFn(sessionId, session, interaction.client);
}

async function teamLeave(interaction, store, editFn, title, prefix, positions) {
  const sessionId = interaction.customId.split(":")[1];
  const session = store.get(sessionId);
  if (!session) return interaction.reply({ content: "❌ This session no longer exists.", flags: MessageFlags.Ephemeral });
  const found = findPlayerInTeams(session, interaction.user.id, positions ?? session.positions ?? TEAM_POSITIONS);
  if (!found) return interaction.reply({ content: "❌ You are not in this session!", flags: MessageFlags.Ephemeral });
  session.teams[found.team][found.position] = null;
  await interaction.reply({ content: "✅ You left successfully.", flags: MessageFlags.Ephemeral });
  await editFn(sessionId, session, interaction.client);
}

async function teamKickBtn(interaction, store, prefix, positions) {
  const sessionId = interaction.customId.split(":")[1];
  const session = store.get(sessionId);
  if (!session) return interaction.reply({ content: "❌ This session no longer exists.", flags: MessageFlags.Ephemeral });
  if (interaction.user.id !== session.hostId) return interaction.reply({ content: "❌ Only the session host can kick players!", flags: MessageFlags.Ephemeral });
  const teamPositions = positions ?? session.positions ?? TEAM_POSITIONS;
  const hasPlayers = TEAMS.some((t) => teamPositions.some((p) => session.teams[t][p] !== null));
  if (!hasPlayers) return interaction.reply({ content: "❌ There are no players.", flags: MessageFlags.Ephemeral });
  await interaction.reply({ content: "Choose a player:", components: [buildTeamKickMenu(prefix, sessionId, session, teamPositions)], flags: MessageFlags.Ephemeral });
}

async function teamKickMenu(interaction, store, editFn, title, prefix, positions) {
  const sessionId = interaction.customId.split(":")[1];
  const session = store.get(sessionId);
  if (!session) return interaction.update({ content: "❌ This session no longer exists.", components: [] });
  if (interaction.user.id !== session.hostId) return interaction.update({ content: "❌ Only the session host can kick players!", components: [] });
  const value = interaction.values[0];
  if (value === "none") return interaction.update({ content: "There are no players.", components: [] });
  const [team, pos] = value.split(":");
  const kicked = session.teams[team][pos];
  if (!kicked) return interaction.update({ content: "❌ This player is no longer in the session.", components: [] });
  session.teams[team][pos] = null;
  await interaction.update({ content: `✅ **${kicked.username}** was kicked from **${team} - ${pos}**.`, components: [] });
  await editFn(sessionId, session, interaction.client);
}

async function teamChangeChar(interaction, store, prefix, positions) {
  const sessionId = interaction.customId.split(":")[1];
  const session = store.get(sessionId);
  if (!session) return interaction.reply({ content: "❌ This session no longer exists.", flags: MessageFlags.Ephemeral });
  const found = findPlayerInTeams(session, interaction.user.id, positions ?? session.positions ?? TEAM_POSITIONS);
  if (!found) return interaction.reply({ content: "❌ You are not in this session! Choose a position first.", flags: MessageFlags.Ephemeral });
  await interaction.reply({
    content: `Choose a **category** for your new character at **${found.team} - ${found.position}**:`,
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
      await msg.edit({ content: buildTeamContent(session, "IN-HOUSE!", TEAM_POSITIONS), embeds: [], components: buildTeamComponents("inhouse", sessionId, TEAM_POSITIONS) });
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
  if (chName === "chat \u0627\u0644\u0639\u0627\u0645")
    return interaction.reply({ content: "❌ This command cannot be used in **general chat**!", flags: MessageFlags.Ephemeral });

  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (!member?.roles.cache.some((r) => r.name.toLowerCase() === "scrim hoster"))
    return interaction.reply({ content: "❌ This command is only for members with the **SCRIM HOSTER** role!", flags: MessageFlags.Ephemeral });

  const existingId = channelInhouse.get(interaction.channelId);
  if (existingId) await expireInhouse(existingId, interaction.client);

  const session = {
    messageId: "", channelId: interaction.channelId, hostId: interaction.user.id,
    positions: TEAM_POSITIONS,
    teams: { HOME: emptyTeam(TEAM_POSITIONS), AWAY: emptyTeam(TEAM_POSITIONS) }, createdAt: new Date(), timer: null,
  };

  const response = await interaction.reply({ content: "⏳ Creating in-house...", withResponse: true });
  const messageId = response.resource?.message?.id;
  if (!messageId) return interaction.editReply({ content: "❌ Failed to create the in-house session." });

  session.messageId = messageId;
  activeInhouses.set(messageId, session);
  channelInhouse.set(interaction.channelId, messageId);

  await interaction.editReply({ content: buildTeamContent(session, "IN-HOUSE!", TEAM_POSITIONS), embeds: [], components: buildTeamComponents("inhouse", messageId, TEAM_POSITIONS) });
}

async function handleInhouseInteraction(interaction) {
  const id = interaction.customId;
  if (id.startsWith("inhouse_pos:"))        return teamPosition(interaction, activeInhouses, editInhouseMessage, "IN-HOUSE!", "inhouse", TEAM_POSITIONS);
  if (id.startsWith("inhouse_rarity:"))     return teamRarity(interaction, activeInhouses, "inhouse");
  if (id.startsWith("inhouse_char:"))       return teamChar(interaction, activeInhouses, editInhouseMessage, "IN-HOUSE!", "inhouse", TEAM_POSITIONS);
  if (id.startsWith("inhouse_leave:"))      return teamLeave(interaction, activeInhouses, editInhouseMessage, "IN-HOUSE!", "inhouse", TEAM_POSITIONS);
  if (id.startsWith("inhouse_kick:"))       return teamKickBtn(interaction, activeInhouses, "inhouse", TEAM_POSITIONS);
  if (id.startsWith("inhouse_kickmenu:"))   return teamKickMenu(interaction, activeInhouses, editInhouseMessage, "IN-HOUSE!", "inhouse", TEAM_POSITIONS);
  if (id.startsWith("inhouse_changechar:")) return teamChangeChar(interaction, activeInhouses, "inhouse", TEAM_POSITIONS);
}

// ═══════════════════════════════════════════
//  8VS8
// ═══════════════════════════════════════════

async function edit8v8Message(sessionId, session, client) {
  try {
    const ch = await client.channels.fetch(session.channelId);
    if (ch?.isTextBased()) {
      const msg = await ch.messages.fetch(sessionId);
      await msg.edit({
        content: buildTeamContent(session, "8vs8", EIGHT_V_EIGHT_POSITIONS, { HOME: "Home", AWAY: "Away" }),
        embeds: [],
        components: buildTeamComponents("8vs8", sessionId, EIGHT_V_EIGHT_POSITIONS),
      });
    }
  } catch { }
}

async function expire8v8(sessionId, client) {
  const s = active8v8s.get(sessionId);
  if (!s) return;
  clearTimer(s);
  active8v8s.delete(sessionId);
  channel8v8.delete(s.channelId);
  try {
    const ch = await client.channels.fetch(s.channelId);
    if (ch?.isTextBased()) {
      const msg = await ch.messages.fetch(sessionId);
      await msg.edit({ content: msg.content + "\n\n**8vs8 has ended**", components: [] });
    }
  } catch { }
}

async function handle8v8Command(interaction) {
  const chName = interaction.channel && "name" in interaction.channel ? interaction.channel.name : "";
  if (chName === "chat \u0627\u0644\u0639\u0627\u0645")
    return interaction.reply({ content: "❌ This command cannot be used in **general chat**!", flags: MessageFlags.Ephemeral });

  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (!member?.roles.cache.some((r) => r.name.toLowerCase() === "scrim hoster"))
    return interaction.reply({ content: "❌ This command is only for members with the **SCRIM HOSTER** role!", flags: MessageFlags.Ephemeral });

  const existingId = channel8v8.get(interaction.channelId);
  if (existingId) await expire8v8(existingId, interaction.client);

  const session = {
    messageId: "", channelId: interaction.channelId, hostId: interaction.user.id,
    positions: EIGHT_V_EIGHT_POSITIONS,
    teams: { HOME: emptyTeam(EIGHT_V_EIGHT_POSITIONS), AWAY: emptyTeam(EIGHT_V_EIGHT_POSITIONS) },
    createdAt: new Date(), timer: null,
  };

  const response = await interaction.reply({ content: "⏳ Creating 8vs8...", withResponse: true });
  const messageId = response.resource?.message?.id;
  if (!messageId) return interaction.editReply({ content: "❌ Failed to create the 8vs8 session." });

  session.messageId = messageId;
  active8v8s.set(messageId, session);
  channel8v8.set(interaction.channelId, messageId);

  await interaction.editReply({
    content: buildTeamContent(session, "8vs8", EIGHT_V_EIGHT_POSITIONS, { HOME: "Home", AWAY: "Away" }),
    embeds: [],
    components: buildTeamComponents("8vs8", messageId, EIGHT_V_EIGHT_POSITIONS),
  });
}

async function handle8v8Interaction(interaction) {
  const id = interaction.customId;
  if (id.startsWith("8vs8_pos:"))        return teamPosition(interaction, active8v8s, edit8v8Message, "8vs8", "8vs8", EIGHT_V_EIGHT_POSITIONS);
  if (id.startsWith("8vs8_rarity:"))    return teamRarity(interaction, active8v8s, "8vs8");
  if (id.startsWith("8vs8_char:"))      return teamChar(interaction, active8v8s, edit8v8Message, "8vs8", "8vs8", EIGHT_V_EIGHT_POSITIONS);
  if (id.startsWith("8vs8_leave:"))     return teamLeave(interaction, active8v8s, edit8v8Message, "8vs8", "8vs8", EIGHT_V_EIGHT_POSITIONS);
  if (id.startsWith("8vs8_kick:"))      return teamKickBtn(interaction, active8v8s, "8vs8", EIGHT_V_EIGHT_POSITIONS);
  if (id.startsWith("8vs8_kickmenu:"))  return teamKickMenu(interaction, active8v8s, edit8v8Message, "8vs8", "8vs8", EIGHT_V_EIGHT_POSITIONS);
  if (id.startsWith("8vs8_changechar:")) return teamChangeChar(interaction, active8v8s, "8vs8", EIGHT_V_EIGHT_POSITIONS);
}

// ═══════════════════════════════════════════
//  TRYOUT
// ═══════════════════════════════════════════

async function editTryoutMessage(sessionId, session, client) {
  try {
    const ch = await client.channels.fetch(session.channelId);
    if (ch?.isTextBased()) {
      const msg = await ch.messages.fetch(sessionId);
      await msg.edit({ content: buildTeamContent(session, "TRYOUT!", TEAM_POSITIONS), embeds: [], components: buildTeamComponents("tryout", sessionId, TEAM_POSITIONS) });
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
  if (chName === "chat \u0627\u0644\u0639\u0627\u0645")
    return interaction.reply({ content: "❌ This command cannot be used in **general chat**!", flags: MessageFlags.Ephemeral });

  const member = interaction.guild?.members.cache.get(interaction.user.id)
    ?? await interaction.guild?.members.fetch(interaction.user.id).catch(() => null);
  if (!member?.roles.cache.some((r) => r.name.toLowerCase() === "tryout hoster"))
    return interaction.reply({ content: "❌ This command is only for members with the **TRYOUT HOSTER** role!", flags: MessageFlags.Ephemeral });

  const existingId = channelTryout.get(interaction.channelId);
  if (existingId) await expireTryout(existingId, interaction.client);

  const session = {
    messageId: "", channelId: interaction.channelId, hostId: interaction.user.id,
    positions: TEAM_POSITIONS,
    teams: { HOME: emptyTeam(TEAM_POSITIONS), AWAY: emptyTeam(TEAM_POSITIONS) }, createdAt: new Date(), timer: null,
  };

  const response = await interaction.reply({ content: "⏳ Creating tryout...", withResponse: true });
  const messageId = response.resource?.message?.id;
  if (!messageId) return interaction.editReply({ content: "❌ Failed to create the tryout session." });

  session.messageId = messageId;
  activeTryouts.set(messageId, session);
  channelTryout.set(interaction.channelId, messageId);
  session.timer = setTimeout(() => expireTryout(messageId, interaction.client), TRYOUT_DURATION);

  await interaction.editReply({ content: buildTeamContent(session, "TRYOUT!", TEAM_POSITIONS), embeds: [], components: buildTeamComponents("tryout", messageId, TEAM_POSITIONS) });
}

async function handleTryoutInteraction(interaction) {
  const id = interaction.customId;
  if (id.startsWith("tryout_pos:"))        return teamPosition(interaction, activeTryouts, editTryoutMessage, "TRYOUT!", "tryout", TEAM_POSITIONS);
  if (id.startsWith("tryout_rarity:"))     return teamRarity(interaction, activeTryouts, "tryout");
  if (id.startsWith("tryout_char:"))       return teamChar(interaction, activeTryouts, editTryoutMessage, "TRYOUT!", "tryout", TEAM_POSITIONS);
  if (id.startsWith("tryout_leave:"))      return teamLeave(interaction, activeTryouts, editTryoutMessage, "TRYOUT!", "tryout", TEAM_POSITIONS);
  if (id.startsWith("tryout_kick:"))       return teamKickBtn(interaction, activeTryouts, "tryout", TEAM_POSITIONS);
  if (id.startsWith("tryout_kickmenu:"))   return teamKickMenu(interaction, activeTryouts, editTryoutMessage, "TRYOUT!", "tryout", TEAM_POSITIONS);
  if (id.startsWith("tryout_changechar:")) return teamChangeChar(interaction, activeTryouts, "tryout", TEAM_POSITIONS);
}

// ═══════════════════════════════════════════
//  Register slash commands
// ═══════════════════════════════════════════

async function registerCommands(token, clientId) {
  const commands = [
    new SlashCommandBuilder().setName("scrim").setDescription("Start a new Blue Lock Rivals scrim").toJSON(),
    new SlashCommandBuilder().setName("inhouse").setDescription("Start a new in-house match with HOME and AWAY teams").toJSON(),
    new SlashCommandBuilder().setName("8vs8").setDescription("Start a new 8vs8 match with Home and Away teams").toJSON(),
    new SlashCommandBuilder().setName("tryout").setDescription("Start a new tryout with HOME and AWAY teams").toJSON(),
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
        if (interaction.commandName === "8vs8")    return handle8v8Command(interaction);
        if (interaction.commandName === "tryout")  return handleTryoutCommand(interaction);
        return;
      }
      if (!interaction.isStringSelectMenu() && !interaction.isButton()) return;
      const id = interaction.customId;
      if (id.startsWith("scrim_"))   return handleScrimInteraction(interaction);
      if (id.startsWith("inhouse_")) return handleInhouseInteraction(interaction);
      if (id.startsWith("8vs8_"))    return handle8v8Interaction(interaction);
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
