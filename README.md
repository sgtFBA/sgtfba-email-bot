# SGTFBA Email Capture Bot

Two ways this captures emails:

1. **The gate (`/join`)** — a page that asks for an email *before* handing
   over a real Discord invite. Submitting the form adds the email to
   Brevo, then mints a single-use, 1-hour invite link and sends the
   browser straight to it. This is the one that stops people joining
   without submitting their email first.
2. **The backup button (in `#welcome`)** — for anyone who ends up in the
   server another way. Clicking it pops up the same email form as a
   Discord modal.

This has to run continuously (unlike `sync-discord.js`, which you run
once yourself), so it needs hosting that keeps it online — Render's free
tier works fine.

## Deploying to Render

1. **Push this folder to GitHub.** Create a new repo (e.g. under the same
   GitHub account/org used for the rest of this project) and push these
   files to it.

2. **Create the Render service.**
   - Go to [render.com](https://render.com) and sign up / log in.
   - Click **New +** → **Web Service**.
   - Connect the GitHub repo you just created.
   - Runtime: **Node**.
   - Build command: `npm install`
   - Start command: `npm start`
   - Instance type: **Free** is fine.

3. **Set the environment variables.** In the Render service's
   **Environment** tab, add:
   - `DISCORD_TOKEN` — the same bot token used in `sync-discord.js`
   - `GUILD_ID` — `1531634931833245746`
   - `BREVO_API_KEY` — your Brevo API key
   - `BREVO_LIST_NAME` — `discord` (only needed if your Brevo list is
     named something else)

4. **Deploy.** Render will install dependencies and start the bot. Check
   the **Logs** tab — you should see `Logged in as <bot name>`.

5. **Keep it awake.** Render's free tier spins a web service down after
   15 minutes with no incoming traffic, which would disconnect the bot
   and take the gate page down with it. Set up a free
   [UptimeRobot](https://uptimerobot.com) monitor to ping your Render
   service's URL (shown at the top of the Render dashboard, something
   like `https://sgtfba-email-bot.onrender.com`) every 5 minutes — same
   approach as the ticket bot.

## Closing the loophole — do this once the bot is deployed

The gate only works if the *only* way in is through `https://your-render-url/join`.
Right now people can still bypass it if:

- **You have old invite links floating around.** Go to your Discord
  server → **Server Settings → Invites**, and delete every existing
  invite link. From then on, only share the `/join` page URL — anywhere
  you currently have your Discord link (bio, website, socials), swap it
  for that instead.
- **Members can generate their own invite links.** By default, regular
  members can right-click the server and create an invite themselves,
  completely bypassing the gate. Let me know if you'd like me to extend
  `sync-discord.js`'s permission lockdown to also strip the "Create
  Invite" permission from every role — that closes this off too.

I can't do either of these from my end (no direct access to your live
server), so they're on you to action once this is deployed.

## How it works

- `GET /join` serves the gate page (`public/join.html`).
- Submitting the form calls `POST /api/join`, which validates the email,
  adds it to the Brevo list named `BREVO_LIST_NAME`, mints a single-use
  invite (valid for 1 hour or until first use, whichever comes first),
  and returns its URL for the page to redirect to.
- On startup, the bot also checks `#welcome` for the backup button and
  posts one if it's missing — safe to restart or redeploy any time, it
  won't post a duplicate.
- The backup button opens a Discord "modal" asking for an email, and adds
  it to the same Brevo list on submit. The person gets a private
  ("ephemeral") confirmation only they can see.
