/**
 * SGTFBA Discord — email-gated join bot.
 *
 * Unlike sync-discord.js (which runs once and exits), this needs to run
 * continuously. Deploy it as a Render Web Service (see README.md).
 *
 * Two ways in are covered:
 *
 * 1. THE GATE (/join): a page that asks for an email before handing over
 *    a real invite. Submitting the form adds the email to Brevo, then
 *    mints a single-use, 1-hour invite link and redirects the browser
 *    straight to it. Share THIS page's URL wherever you currently share
 *    your Discord invite — see README.md for the "close the loophole"
 *    steps (deleting old permanent invites etc.), which this code can't
 *    do for you.
 *
 * 2. THE BACKUP BUTTON (in #welcome): for anyone who ends up in the
 *    server another way. Clicking it pops up the same email form as a
 *    Discord modal, and adds the email to the same Brevo list.
 *
 * 3. GIVEAWAYS (giveaways.js): a /giveaway slash command, owner-only.
 *    Posts an embed with an "Enter" button and automatically picks and
 *    announces winner(s) when it ends. See giveaways.js for details.
 *
 * Required environment variables (set these in Render, not in this file):
 *   DISCORD_TOKEN     - the same bot token used in sync-discord.js
 *   GUILD_ID          - the server ID (same as sync-discord.js — 1531634931833245746)
 *   BREVO_API_KEY     - from Brevo: account menu -> SMTP & API -> API Keys
 *   BREVO_LIST_NAME   - which Brevo list to add emails to (defaults to "discord")
 */

const path = require("path");
const {
  Client,
  GatewayIntentBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Events,
} = require("discord.js");
const express = require("express");
const giveaways = require("./giveaways");

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const GUILD_ID = process.env.GUILD_ID;
const BREVO_API_KEY = process.env.BREVO_API_KEY;
const BREVO_LIST_NAME = process.env.BREVO_LIST_NAME || "discord";

const BUTTON_CUSTOM_ID = "join_email_list";
const MODAL_CUSTOM_ID = "email_modal";
const EMAIL_INPUT_CUSTOM_ID = "email_input";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// How long a minted invite stays valid if it's never used (seconds).
// Generous enough that a slow redirect/click doesn't strand someone, but
// short enough that a leaked link doesn't stay open for long.
const INVITE_MAX_AGE_SECONDS = 60 * 60; // 1 hour

if (!DISCORD_TOKEN || !GUILD_ID || !BREVO_API_KEY) {
  console.error("Missing required environment variable(s). Need DISCORD_TOKEN, GUILD_ID, BREVO_API_KEY.");
  process.exit(1);
}

// ---- Web server ----
// Also doubles as the thing UptimeRobot pings to keep Render's free tier
// from spinning the service down.
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => res.send("SGTFBA email-capture bot is running."));

app.get("/join", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "join.html"));
});

app.post("/api/join", async (req, res) => {
  const email = (req.body?.email || "").trim();
  if (!EMAIL_PATTERN.test(email)) {
    return res.status(400).json({ error: "That doesn't look like a valid email address." });
  }
  if (!client.isReady()) {
    return res.status(503).json({ error: "The bot is still starting up — please try again in a few seconds." });
  }
  try {
    const brevoResult = await addEmailToBrevo(email, null);
    if (!brevoResult.ok) {
      console.error("Brevo add failed (join gate):", brevoResult.error);
      return res.status(502).json({ error: "Couldn't save your email right now — please try again in a moment." });
    }
    const invite = await createSingleUseInvite();
    return res.json({ url: invite.url });
  } catch (err) {
    console.error("Join-gate error:", err);
    return res.status(500).json({ error: "Something went wrong — please try again in a moment." });
  }
});

app.listen(process.env.PORT || 3000, () => console.log("Web server listening."));

// ---- Brevo ----
let cachedListId = null;

async function getBrevoListId() {
  if (cachedListId) return cachedListId;
  let offset = 0;
  const limit = 50;
  for (;;) {
    const res = await fetch(`https://api.brevo.com/v3/contacts/lists?limit=${limit}&offset=${offset}`, {
      headers: { "api-key": BREVO_API_KEY, Accept: "application/json" },
    });
    if (!res.ok) throw new Error(`Brevo list lookup failed: ${res.status} ${await res.text()}`);
    const data = await res.json();
    const lists = data.lists || [];
    const match = lists.find((l) => l.name.toLowerCase() === BREVO_LIST_NAME.toLowerCase());
    if (match) {
      cachedListId = match.id;
      return cachedListId;
    }
    if (lists.length < limit) break;
    offset += limit;
  }
  throw new Error(`Could not find a Brevo list named "${BREVO_LIST_NAME}".`);
}

async function addEmailToBrevo(email, discordTag) {
  const listId = await getBrevoListId();
  const res = await fetch("https://api.brevo.com/v3/contacts", {
    method: "POST",
    headers: {
      "api-key": BREVO_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      email,
      listIds: [listId],
      updateEnabled: true,
      attributes: discordTag ? { DISCORD_USERNAME: discordTag } : undefined,
    }),
  });
  if (res.ok) return { ok: true };
  const body = await res.json().catch(() => ({}));
  // Brevo can return 400 "duplicate_parameter" if the contact already
  // exists — with updateEnabled:true that shouldn't normally trigger, but
  // treat it as success either way since the email ends up on the list.
  if (res.status === 400 && body.code === "duplicate_parameter") return { ok: true };
  return { ok: false, error: body.message || `Brevo error ${res.status}` };
}

// ---- Discord ----
const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Resolved once the bot is ready; reused both for the backup button and
// for minting invites from /api/join.
let welcomeChannel = null;

async function createSingleUseInvite() {
  if (!welcomeChannel) {
    throw new Error('No channel named "welcome" available to create an invite from.');
  }
  // unique:true stops Discord handing back a cached, already-used invite —
  // every gate submission gets its own fresh, single-use link.
  const invite = await welcomeChannel.createInvite({
    maxAge: INVITE_MAX_AGE_SECONDS,
    maxUses: 1,
    unique: true,
    reason: "Email-gated join link",
  });
  return invite;
}

async function ensureButtonMessage() {
  const guild = await client.guilds.fetch(GUILD_ID);
  const channels = await guild.channels.fetch();
  welcomeChannel = channels.find((c) => c && c.name === "welcome");
  if (!welcomeChannel) {
    console.error('No channel named "welcome" found — skipping button setup.');
    return;
  }

  const messages = await welcomeChannel.messages.fetch({ limit: 50 });
  const existing = messages.find(
    (m) =>
      m.author.id === client.user.id &&
      m.components.some((row) => row.components.some((c) => c.customId === BUTTON_CUSTOM_ID))
  );
  if (existing) return; // already posted, leave it alone

  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(BUTTON_CUSTOM_ID).setLabel("📧 Join the Email List").setStyle(ButtonStyle.Primary)
  );
  await welcomeChannel.send({
    content: "Want the odd update by email too? Click below and pop your email in — no spam, just the important stuff.",
    components: [row],
  });
  console.log('Posted the "Join the Email List" button in #welcome.');
}

client.once(Events.ClientReady, async () => {
  console.log(`Logged in as ${client.user.tag}`);
  try {
    await ensureButtonMessage();
  } catch (err) {
    console.error("Failed to ensure button message:", err);
  }
  giveaways.init(client, GUILD_ID);
});

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (interaction.isChatInputCommand()) {
      if (await giveaways.handleSlashCommand(interaction)) return;
    }

    if (interaction.isButton() && (await giveaways.handleButton(interaction))) {
      return;
    }

    if (interaction.isButton() && interaction.customId === BUTTON_CUSTOM_ID) {
      const modal = new ModalBuilder().setCustomId(MODAL_CUSTOM_ID).setTitle("Join the Email List");
      const emailInput = new TextInputBuilder()
        .setCustomId(EMAIL_INPUT_CUSTOM_ID)
        .setLabel("Your email address")
        .setStyle(TextInputStyle.Short)
        .setPlaceholder("you@example.com")
        .setRequired(true);
      modal.addComponents(new ActionRowBuilder().addComponents(emailInput));
      await interaction.showModal(modal);
      return;
    }

    if (interaction.isModalSubmit() && interaction.customId === MODAL_CUSTOM_ID) {
      const email = interaction.fields.getTextInputValue(EMAIL_INPUT_CUSTOM_ID).trim();
      if (!EMAIL_PATTERN.test(email)) {
        await interaction.reply({
          content: "That doesn't look like a valid email — mind clicking the button and trying again?",
          ephemeral: true,
        });
        return;
      }
      const result = await addEmailToBrevo(email, interaction.user.tag);
      if (result.ok) {
        await interaction.reply({ content: "You're on the list! ✅", ephemeral: true });
      } else {
        console.error("Brevo add failed:", result.error);
        await interaction.reply({
          content: "Something went wrong adding you to the list — please try again in a moment.",
          ephemeral: true,
        });
      }
      return;
    }
  } catch (err) {
    console.error("Interaction error:", err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      await interaction.reply({ content: "Something went wrong — please try again.", ephemeral: true }).catch(() => {});
    }
  }
});

client.login(DISCORD_TOKEN).catch((err) => {
  console.error("Failed to log in to Discord:", err.message || err);
  process.exit(1);
});
