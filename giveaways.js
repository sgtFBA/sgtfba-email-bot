/**
 * Giveaway feature for the SGTFBA bot.
 *
 * Adds a /giveaway slash command (owner-only) that posts an embed with an
 * "Enter" button, tracks entrants, and automatically picks winner(s) and
 * announces them when the giveaway ends.
 *
 * State is written to giveaways.json after every change, so a giveaway
 * survives the bot crashing and restarting on the SAME Render instance.
 * IMPORTANT CAVEAT: Render's free tier does not guarantee disk survives a
 * fresh deploy (pushing new code) — if you redeploy while a giveaway is
 * running, it may be lost. Keep giveaways short, or avoid redeploying
 * mid-giveaway.
 */
const fs = require("fs");
const path = require("path");
const {
  SlashCommandBuilder,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  REST,
  Routes,
} = require("discord.js");

const DATA_FILE = path.join(__dirname, "giveaways.json");
const CHECK_INTERVAL_MS = 15 * 1000;
const ENTER_BUTTON_PREFIX = "giveaway_enter_";
const EMBED_COLOR = 0xff9900;

// id -> { channelId, messageId, prize, winners, endsAt, entrants: [ids], ended, winnerIds, hostId }
let giveaways = {};

function load() {
  try {
    giveaways = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  } catch {
    giveaways = {};
  }
}

function save() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(giveaways, null, 2));
  } catch (err) {
    console.error("Failed to save giveaways.json:", err);
  }
}

function buildEmbed(g) {
  const endsAtSeconds = Math.floor(g.endsAt / 1000);
  const embed = new EmbedBuilder().setColor(EMBED_COLOR);

  if (g.ended) {
    embed.setTitle(`🎉 GIVEAWAY ENDED: ${g.prize}`);
    embed.setDescription(
      g.winnerIds && g.winnerIds.length
        ? `Winner${g.winnerIds.length > 1 ? "s" : ""}: ${g.winnerIds.map((id) => `<@${id}>`).join(", ")}`
        : "No valid entries — no winner could be picked."
    );
  } else {
    embed.setTitle(`🎉 GIVEAWAY: ${g.prize}`);
    embed.setDescription(
      `Click the button below to enter!\n\nEnds: <t:${endsAtSeconds}:R>\nWinners: ${g.winners}\nEntrants: ${g.entrants.length}`
    );
  }
  return embed;
}

function buildRow(id, disabled) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${ENTER_BUTTON_PREFIX}${id}`)
      .setLabel("🎉 Enter Giveaway")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!!disabled)
  );
}

function pickWinners(entrants, count) {
  const pool = [...entrants];
  const picked = [];
  while (pool.length && picked.length < count) {
    const i = Math.floor(Math.random() * pool.length);
    picked.push(pool.splice(i, 1)[0]);
  }
  return picked;
}

async function endGiveaway(client, id) {
  const g = giveaways[id];
  if (!g || g.ended) return;
  g.ended = true;
  g.winnerIds = pickWinners(g.entrants, g.winners);
  save();

  try {
    const channel = await client.channels.fetch(g.channelId);
    const message = await channel.messages.fetch(g.messageId);
    await message.edit({ embeds: [buildEmbed(g)], components: [buildRow(id, true)] });
    if (g.winnerIds.length) {
      await channel.send({
        content: `Congratulations ${g.winnerIds.map((wId) => `<@${wId}>`).join(", ")}! You won **${g.prize}** 🎉`,
      });
    } else {
      await channel.send({ content: `The giveaway for **${g.prize}** ended with no entrants.` });
    }
    console.log(`Giveaway "${g.prize}" (${id}) ended — winners: ${g.winnerIds.join(", ") || "none"}`);
  } catch (err) {
    console.error(`Failed to finish giveaway ${id}:`, err);
  }
}

function scheduleChecks(client) {
  setInterval(() => {
    const now = Date.now();
    for (const [id, g] of Object.entries(giveaways)) {
      if (!g.ended && g.endsAt <= now) {
        endGiveaway(client, id).catch((err) => console.error(`Error ending giveaway ${id}:`, err));
      }
    }
  }, CHECK_INTERVAL_MS);
}

function parseDuration(input) {
  const match = /^(\d+)\s*(m|h|d)$/i.exec(input.trim());
  if (!match) return null;
  const amount = parseInt(match[1], 10);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "m" ? 60 * 1000 : unit === "h" ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return amount * multiplier;
}

const slashCommand = new SlashCommandBuilder()
  .setName("giveaway")
  .setDescription("Start a giveaway (owner only)")
  .addStringOption((opt) => opt.setName("prize").setDescription("What are you giving away?").setRequired(true))
  .addStringOption((opt) =>
    opt.setName("duration").setDescription("How long it runs, e.g. 10m, 2h, 1d").setRequired(true)
  )
  .addIntegerOption((opt) =>
    opt.setName("winners").setDescription("How many winners (default 1)").setMinValue(1).setMaxValue(20)
  );

async function registerCommand(client, guildId) {
  const rest = new REST({ version: "10" }).setToken(client.token);
  await rest.put(Routes.applicationGuildCommands(client.application.id, guildId), {
    body: [slashCommand.toJSON()],
  });
  console.log("Registered /giveaway slash command.");
}

// Returns true if this interaction was a giveaway thing (handled or
// rejected), false if the caller should keep looking for another handler.
async function handleSlashCommand(interaction) {
  if (interaction.commandName !== "giveaway") return false;

  if (interaction.user.id !== interaction.guild.ownerId) {
    await interaction.reply({ content: "Only the server owner can start a giveaway.", ephemeral: true });
    return true;
  }

  const prize = interaction.options.getString("prize", true);
  const durationInput = interaction.options.getString("duration", true);
  const winners = interaction.options.getInteger("winners") || 1;

  const durationMs = parseDuration(durationInput);
  if (!durationMs) {
    await interaction.reply({ content: 'Duration needs to look like "10m", "2h", or "1d".', ephemeral: true });
    return true;
  }

  const id = `${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  const g = {
    channelId: interaction.channelId,
    messageId: null,
    prize,
    winners,
    endsAt: Date.now() + durationMs,
    entrants: [],
    ended: false,
    hostId: interaction.user.id,
  };
  giveaways[id] = g;

  await interaction.reply({ embeds: [buildEmbed(g)], components: [buildRow(id, false)] });
  const message = await interaction.fetchReply();
  g.messageId = message.id;
  save();
  return true;
}

async function handleButton(interaction) {
  if (!interaction.customId.startsWith(ENTER_BUTTON_PREFIX)) return false;
  const id = interaction.customId.slice(ENTER_BUTTON_PREFIX.length);
  const g = giveaways[id];

  if (!g) {
    await interaction.reply({ content: "This giveaway no longer exists.", ephemeral: true });
    return true;
  }
  if (g.ended) {
    await interaction.reply({ content: "This giveaway has already ended.", ephemeral: true });
    return true;
  }
  if (g.entrants.includes(interaction.user.id)) {
    await interaction.reply({ content: "You're already entered — good luck!", ephemeral: true });
    return true;
  }

  g.entrants.push(interaction.user.id);
  save();
  await interaction.reply({ content: "You're entered! Good luck 🎉", ephemeral: true });
  try {
    await interaction.message.edit({ embeds: [buildEmbed(g)] });
  } catch (err) {
    console.error("Failed to refresh giveaway entrant count:", err);
  }
  return true;
}

function init(client, guildId) {
  load();
  registerCommand(client, guildId).catch((err) => console.error("Failed to register /giveaway command:", err));
  scheduleChecks(client);
  // Catch up on anything that should already have ended while offline.
  const now = Date.now();
  for (const [id, g] of Object.entries(giveaways)) {
    if (!g.ended && g.endsAt <= now) {
      endGiveaway(client, id).catch((err) => console.error(`Error ending giveaway ${id}:`, err));
    }
  }
}

module.exports = { init, handleSlashCommand, handleButton };
