SGTFBA Bot
Two ways this captures emails:
The gate (`/join`) — a page that asks for an email before handing
over a real Discord invite. Submitting the form adds the email to
Brevo, then mints a single-use, 1-hour invite link and sends the
browser straight to it. This is the one that stops people joining
without submitting their email first.
The backup button (in `#welcome`) — for anyone who ends up in the
server another way. Clicking it pops up the same email form as a
Discord modal.
It also auto-assigns a role — see Auto-role on join below.
This has to run continuously (unlike `sync-discord.js`, which you run
once yourself), so it needs hosting that keeps it online — Render's free
tier works fine.
Deploying to Render
Push this folder to GitHub. Create a new repo (e.g. under the same
GitHub account/org used for the rest of this project) and push these
files to it.
Create the Render service.
Go to render.com and sign up / log in.
Click New + → Web Service.
Connect the GitHub repo you just created.
Runtime: Node.
Build command: `npm install`
Start command: `npm start`
Instance type: Free is fine.
Set the environment variables. In the Render service's
Environment tab, add:
`DISCORD_TOKEN` — the same bot token used in `sync-discord.js`
`GUILD_ID` — `1531634931833245746`
`BREVO_API_KEY` — your Brevo API key
`BREVO_LIST_NAME` — `discord` (only needed if your Brevo list is
named something else)
`MEMBER_ROLE_NAME` — `member` (only needed if the role you want
auto-assigned isn't literally called "member")
Turn on the Server Members Intent. Go to the
Discord Developer Portal →
your application → Bot tab → scroll to Privileged Gateway
Intents → toggle Server Members Intent on → Save Changes.
This is required for auto-role on join to work at all — without it,
the bot will fail to log in once this feature is deployed.
Deploy. Render will install dependencies and start the bot. Check
the Logs tab — you should see `Logged in as <bot name>` and
`Auto-role on join is active — new members will get "member"`.
Keep it awake. Render's free tier spins a web service down after
15 minutes with no incoming traffic, which would disconnect the bot
and take the gate page down with it. Set up a free
UptimeRobot monitor to ping your Render
service's URL (shown at the top of the Render dashboard, something
like `https://sgtfba-email-bot.onrender.com`) every 5 minutes — same
approach as the ticket bot.
Closing the loophole — do this once the bot is deployed
The gate only works if the only way in is through `https://your-render-url/join`.
Right now people can still bypass it if:
You have old invite links floating around. Go to your Discord
server → Server Settings → Invites, and delete every existing
invite link. From then on, only share the `/join` page URL — anywhere
you currently have your Discord link (bio, website, socials), swap it
for that instead.
Members can generate their own invite links. By default, regular
members can right-click the server and create an invite themselves,
completely bypassing the gate. Let me know if you'd like me to extend
`sync-discord.js`'s permission lockdown to also strip the "Create
Invite" permission from every role — that closes this off too.
I can't do either of these from my end (no direct access to your live
server), so they're on you to action once this is deployed.
Giveaways
Type `/giveaway` in any channel to start one — only works for you (the
server owner); anyone else gets told no. It asks for:
prize — whatever you're giving away
duration — how long it runs, written like `10m`, `2h`, or `1d`
winners — how many winners (optional, defaults to 1)
It posts an embed with a live entrant count and an "🎉 Enter Giveaway"
button. When time's up, it automatically picks winner(s) at random from
everyone who entered, edits the embed to show them, and posts a
congratulations message tagging them.
One thing to know: giveaway state is saved to a file on the server so
it survives the bot crashing and restarting, but Render's free tier isn't
guaranteed to keep that file if you redeploy the bot (push new code)
while a giveaway is still running — so avoid redeploying mid-giveaway, or
keep giveaways short enough that this doesn't come up.
If `/giveaway` doesn't show up when you type it in Discord, the bot's
invite may be missing the `applications.commands` permission scope. You'd
need to re-invite the bot to the server with that scope included — let me
know if you hit this and I'll walk through it.
Auto-role on join
Every time someone joins the server — through the `/join` gate, the
backup button, or any other way — the bot automatically gives them a
single role (`member` by default, or whatever `MEMBER_ROLE_NAME` is set
to). Nothing else gets touched, so any additional roles are still down to
you to add by hand, person by person, as you said you'd rather do that.
Two things have to be true on Discord's side for this to actually work:
The role must exist already and match the name exactly (not
case-sensitive, but everything else has to match — "Member" and
"member " with a trailing space both count as different roles). Create
it first in Server Settings → Roles if it doesn't exist yet.
The bot's own role must sit above that role in the role list
(Server Settings → Roles — it's a drag-and-drop order, top = highest
permission). Discord won't let a bot assign a role that's positioned
higher than or equal to its own highest role, even if the bot has
"Manage Roles" permission. If you ever add the role and members aren't
getting it, this is almost always why — check the Render logs, it'll
print a line for every failed attempt explaining what went wrong.
How it works
`GET /join` serves the gate page (`public/join.html`).
Submitting the form calls `POST /api/join`, which validates the email,
adds it to the Brevo list named `BREVO_LIST_NAME`, mints a single-use
invite (valid for 1 hour or until first use, whichever comes first),
and returns its URL for the page to redirect to.
On startup, the bot also checks `#welcome` for the backup button and
posts one if it's missing — safe to restart or redeploy any time, it
won't post a duplicate.
The backup button opens a Discord "modal" asking for an email, and adds
it to the same Brevo list on submit. The person gets a private
("ephemeral") confirmation only they can see.
On startup, the bot also looks up the `MEMBER_ROLE_NAME` role once and
caches it. Whenever Discord tells it someone new has joined, it adds
that role to them straight away.
