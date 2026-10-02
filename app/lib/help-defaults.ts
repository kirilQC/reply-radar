// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The Help articles that ship with QC Command. They show up with no setup, and "Edit help" can change or
 * delete any of them: an edited copy is stored under the same id and wins, a deleted one is remembered.
 * Keep them short, quote button labels exactly as the UI writes them, and never use em dashes.
 * Screenshots live in public/help/.
 */

import type { HelpArticle } from "./help-shared";

type Seed = Omit<HelpArticle, "order" | "updatedAt" | "loomUrl" | "images" | "builtIn"> & {
  loomUrl?: string;
  images?: HelpArticle["images"];
};

const shot = (name: string, caption: string) => ({ src: `/help/${name.includes(".") ? name : `${name}.png`}`, caption });

export const BUILT_IN_HELP: Seed[] = [
  // ── Walkthroughs ──────────────────────────────────────────────────────────
  {
    id: "w-getting-around",
    kind: "walkthrough",
    title: "Getting around QC Command",
    page: "/",
    keywords: ["start", "navigate", "sidebar", "client", "switch client", "overview"],
    images: [shot("dashboard.jpg", "The Dashboard: reply counts, teammate profiles and every client.")],
    body: `QC Command is where we work every client's LinkedIn outreach: replies, leads, meetings, calls and reporting.

1. The **sidebar** lists every page. Use **←** to collapse it to icons and **→** to expand it.
2. **Pick a client** by clicking it in the sidebar's **Clients** list, or a card under **Client workspaces** on the Dashboard. Pages like Meetings, Cold calling and Reports open with a grid of client cards. Click one, and use **← All clients** to go back.
3. The **Dashboard** shows reply counts for today, this week and this month across every client.
4. Stuck? Search this page, or ask **@QC Bot** in Slack.`,
  },
  {
    id: "w-inbox",
    kind: "walkthrough",
    title: "Working the reply queue",
    page: "/inbox",
    keywords: ["inbox", "replies", "queue", "respond", "today", "follow-ups", "custom dates"],
    images: [shot("inbox.jpg", "The Inbox: the reply queue on the left, the open conversation on the right.")],
    body: `1. Open **Inbox**. With no client picked you see the **General inbox** across every client. Pick a client in the sidebar to see only theirs.
2. Choose a range above the queue: **Today**, **This week**, **All replies**, **Follow-ups** or **Custom** (pick dates on the calendar).
3. Click a row to open the conversation on the right. A **✓ Replied** mark means someone already answered.
4. Read the thread, check the **AI DRAFT**, edit it, and send. See *Drafting and sending a reply*.
5. Click **★** to star a lead you want to come back to. Stars are yours only, not shared with the team.

**Tip:** **Follow-ups** lists leads who have gone quiet, ranked by urgency, with the reason a follow-up is recommended.`,
  },
  {
    id: "w-ai-draft",
    kind: "walkthrough",
    title: "Drafting and sending a reply",
    page: "/inbox",
    keywords: ["ai", "draft", "send", "reply", "regenerate", "message", "heyreach"],
    images: [shot("inbox-draft.jpg", "The AI DRAFT under the conversation. Edit it, then Send reply.")],
    body: `1. Open a conversation in the **Inbox**. An **AI DRAFT** is written automatically from the thread and the client's brief.
2. Not right? Click **Regenerate ↻** for a fresh draft, or just edit the text.
3. Click **Send reply**. You are asked to confirm who it goes to and from which sender. Click **Yes, send it**.
4. The message goes out through HeyReach from that sender's LinkedIn, exactly as written. No signature is added.

**Good to know**
- If you edit the text after clicking Send reply, the confirmation is cancelled. Click it again.
- If the lead was already replied to you'll see **Lead has been replied to!** Click it to write a follow-up anyway.
- Better drafts come from a better **Client brief** (Configuration → client → Client profile).`,
  },
  {
    id: "w-tags",
    kind: "walkthrough",
    title: "Tagging a lead (DQ, Scheduling and more)",
    page: "/inbox",
    keywords: ["tag", "dq", "disqualify", "label", "scheduling", "discuss"],
    images: [shot("tag-menu.jpg", "The + Tag menu: tick a tag, or create a new one.")],
    body: `1. Open the conversation in the **Inbox**.
2. Click **+ Tag** in the conversation header.
3. Pick a tag, or type a new name and click **+ Create tag** (choose a colour, then **Create tag**).
4. To remove one, click **✕** on its chip.

**Good to know**
- Tags are shared with the whole team. A lead marked DQ is DQ for everyone.
- Tagging does not hide the conversation. To see only one tag, click its chip on any row, or use **Filters → Tag**.
- Rename (✎), recolour or delete (🗑) a tag from the same menu.`,
  },
  {
    id: "w-filters",
    kind: "walkthrough",
    title: "Filtering and searching the Inbox",
    page: "/inbox",
    keywords: ["filter", "search", "sentiment", "campaign", "sender", "tier", "sort", "starred"],
    images: [shot("filters.jpg", "Filters, with the Campaign list open.")],
    body: `- **Search**: click the magnifier and type a name, company, campaign, role or sender. **Esc** clears it.
- **Filters**: narrow by **Starred**, **Campaign**, **Sender**, **Sentiment** (Positive, Neutral, Negative), **Tag** or **Tier** (Hot, Warm, Nurture), and change the **Sort**. A dot on the button means a filter is on. **Clear all filters** resets everything.
- **Export ↓** downloads what you are looking at.
- In the General inbox, click a client's logo in the row above the queue to hide their replies until you refresh.`,
  },
  {
    id: "w-inbox-tools",
    kind: "walkthrough",
    title: "Quick templates and your Inbox layout",
    page: "/inbox",
    keywords: ["template", "snippet", "calendly link", "layout", "metrics", "compact", "notepad"],
    images: [
      shot("inbox-templates", "Quick Templates: click one to copy it."),
      shot("inbox-layout", "Inbox layout: choose what shows and in what order."),
    ],
    body: `**Quick templates** (the **≡** button, top right): save text you paste often, like a booking link or a pricing line. Fill **Variable name** and **Value or reusable text**, click **Save**, then click any entry to copy it. Templates belong to the client.

**Inbox layout** (the **⚙** button): drag the sections into the order you like, turn **Show summary metrics**, **Show inbox analytics** or **Compact spacing** on or off, pick up to 6 summary metrics, then **Save layout**. Your layout is remembered separately for the General inbox, each client and each profile.

**Messaging doc** (the **▤** button) opens the client's messaging document, when one is set.`,
  },
  {
    id: "w-database",
    kind: "walkthrough",
    title: "Finding a lead in the Database",
    page: "/database",
    keywords: ["database", "lead", "search", "export", "csv", "phone", "enrich", "block", "delete"],
    images: [shot("database.jpg", "The Lead Database."), shot("lead-drawer.jpg", "A lead's record, with Enrich next to Phone number.")],
    body: `1. Open **Database** and search by name, company, role or LinkedIn ID.
2. Pick a **Client** to unlock the **Sender**, **Campaign** and **Time range** filters.
3. Click a lead to open their full record: contact details, profile, company, education and the **Activity** tab.
4. No phone number? Click **Enrich** next to **Phone number** (uses 5 AI Ark credits, needs a LinkedIn URL).
5. **Export CSV ↓** downloads the current list.

**Delete vs Block:** **Delete lead** is undone by the lead's next reply. **Block lead** deletes them and ignores every future reply. Blocked leads are listed at the bottom, where you can **Unblock**.`,
  },
  {
    id: "w-profiles",
    kind: "walkthrough",
    title: "Your profile and personal inbox",
    page: "/profiles",
    keywords: ["profile", "teammate", "my clients", "assign", "personal inbox", "photo"],
    images: [shot("profile-new", "Create a profile and pick the clients you look after.")],
    body: `A profile is a teammate plus the clients they look after. It gives them an Inbox with only their clients.

1. Open **Profiles** and click **+ New profile**.
2. Add a photo, **FULL NAME**, **TITLE** and **LINKEDIN URL**.
3. In the **Client directory**, click the logos of the clients this person owns.
4. Click **Save profile**.

Open your personal inbox from the **Profiles** cards on the Dashboard. It greets you by name and shows only your clients.`,
  },
  {
    id: "w-meetings",
    kind: "walkthrough",
    title: "Tracking booked meetings",
    page: "/meetings",
    keywords: ["meeting", "calendly", "booked", "call booked", "add meeting"],
    images: [shot("meetings.jpg", "A client's booked meetings.")],
    body: `Meetings booked through the client's Calendly arrive here on their own. You can also add one by hand.

1. Open **Meetings** and pick the client.
2. Click **Add meeting**, fill in the lead's details and **When**, then **Save meeting**.
3. Click any meeting to see the lead, the company, meeting notes and the LinkedIn conversation that led to it.

Each meeting is enriched automatically. Use **↻ Re-enrich** if details look thin.`,
  },
  {
    id: "w-cold-calling",
    kind: "walkthrough",
    title: "Running a cold calling session",
    page: "/cold-calling",
    keywords: ["call", "cold call", "phone", "dial", "outcome", "voicemail", "script", "phone finder", "add leads"],
    images: [shot("cold-calling.jpg", "A call session: the list, the conversation and outcome buttons, and the lead's record."), shot("add-leads.jpg", "+ Add leads → From a campaign.")],
    body: `1. Open **Cold calling** and pick the client.
2. Load people to call with **+ Add leads**:
   - **From a campaign**: pick a HeyReach campaign and click **Fetch & enrich**. Everyone in it is pulled in and their mobile number is looked up (uses AI Ark credits). It runs in the background.
   - **Upload a CSV**: name the list, choose the file, check the detected columns, then **Import**.
3. Pick a lead on the left. Click their number to dial.
4. Choose an outcome (**Connected**, **Voicemail**, **No answer**, **Interested**, **Callback**…), add a note, and click **Save & next →**.

The **CALL SCRIPT** tab on the side holds the client's script and saves as you type. **Do not call** is a call outcome only. It does not add the company to the DNC list.`,
  },
  {
    id: "w-projects",
    kind: "walkthrough",
    title: "Managing tasks in Project management",
    page: "/project-management",
    keywords: ["task", "project", "kanban", "board", "blocked", "assignee", "due date", "view"],
    images: [shot("pm-board.jpg", "A client's board in Kanban view.")],
    body: `1. Open **Project management** and pick a client, or a **View** that groups several clients.
2. Click **+ Add a task**. Give it a title, notes, links, **Assignees**, a **Due date** and an **Owner**.
3. Move it through the stages: To do, Planning, Building, In progress, Blocked, Paused, Completed, Launched.
4. Blocked? Fill **Waiting on** and **What needs to happen** so everyone can see why.
5. Use **Filters** to switch between Kanban, By client, Individuals, Table and Swimlanes, pick a week, or sort.

The Slack button on a saved task posts its status to the client's internal channel. You can also create and update tasks by asking **@QC Bot**.`,
  },
  {
    id: "w-onboarding",
    kind: "walkthrough",
    title: "Onboarding a new client",
    page: "/onboarding",
    keywords: ["onboard", "new client", "setup", "checklist", "webhook", "heyreach key"],
    images: [shot("onboarding.jpg", "A client's onboarding checklist and progress.")],
    body: `1. Open **Onboarding** and click **Add new client**. Enter the name and click **Create client**.
2. Upload the client's logo.
3. Fill the **QC Command setup** form: HeyReach API key, Airtable base, messaging doc, website and Slack channel IDs. Click **Save setup**.
4. Copy the two webhook URLs into HeyReach (incoming replies) and the booking tool (booked meetings).
5. Work down the checklist. When it's done, click **Mark fully onboarded ✓**.

Use **Client onboarding updates** to send progress to the client's shared Slack channel. **Edit template** changes the checklist for every future client.`,
  },
  {
    id: "w-jev",
    kind: "walkthrough",
    title: "Checking a list with Jev",
    page: "/jev",
    keywords: ["jev", "list", "csv", "icp", "screen", "clean", "good fit", "qualify"],
    images: [shot("jev.jpg", "Describe who should stay on the list, then drop in the CSV.")],
    body: `Jev screens a contact or company list against the client's ICP before a campaign launches.

1. Open **Jev** and pick the client.
2. Choose **Contact lists** or **Company lists**.
3. Set the questions. Describe who should stay on the list and click **Build Jev setup**, use **Draft from QC Brain** to write them from the client's ICP, or **Write by hand**.
4. Drop the CSV in and click **Run**.
5. Every row gets a verdict: Good fit, Maybe, Bad fit, Needs review or Duplicate, with Jev's reason.
6. Download **Good fits**, **Good + maybe**, or the full cleaned list.

Optional: **Review maybes with Claude** gives the borderline rows a second look.`,
  },
  {
    id: "w-analytics",
    kind: "walkthrough",
    title: "Reading campaign analytics",
    page: "/analytics",
    keywords: ["analytics", "reply rate", "acceptance rate", "campaign performance", "sync"],
    images: [shot("analytics.jpg", "A client's analytics.")],
    body: `1. Open **Analytics** for the totals across every client: replies, reply rate, acceptance rate and positive reply rate.
2. Pick a client to see connection requests by sender, active campaigns, best and worst performers, and the messaging that worked best.
3. Click any campaign in **All campaigns** to read its connection request and first message.

Numbers can be up to a day old. Click **Sync now** for the latest from HeyReach.`,
  },
  {
    id: "w-reports",
    kind: "walkthrough",
    title: "Building a client report",
    page: "/reports",
    keywords: ["report", "eow", "end of week", "pdf", "email", "executive summary", "template"],
    images: [shot("reports.jpg", "Pick a client, or All clients.")],
    body: `1. Open **Reports** and pick a client, or **All clients**.
2. Choose a template, like the EOW report or the all-time executive summary, or **Build your own report**.
3. Set the **Date range** or **Period**, pick campaigns, and tick the sections you want.
4. Click **Generate report**. Email templates give you an **Email to send** to copy.

Save your own format with **+ Add template**. Past runs are kept under **Past reports**.`,
  },
  {
    id: "w-mcp",
    kind: "walkthrough",
    title: "Asking Scout",
    page: "/scout",
    keywords: ["mcp", "assistant", "ask", "ai", "chat", "question", "skill", "prompt"],
    images: [shot("mcp.jpg", "Start from a suggested prompt, or ask your own.")],
    body: `**Scout** (the axolotl) is QC Command's assistant. The Scout tab is a full chat with the same brain as QC Bot in Slack. It can read campaigns, replies, the Database, the QC Brain, meetings, deals and these help articles.

1. Open **Scout** in the sidebar and click a suggested prompt, or type your own question.
2. Type **/** to run a QC Brain skill.
3. Attach a screenshot, PDF or spreadsheet with the paperclip.
4. Tables in answers can be downloaded as CSV or PDF.

**Try:** "Who replied and hasn't been followed up with yet? Oldest first." Save prompts you reuse with **+ Save a prompt of your own**. Click **+** to start a new conversation.`,
  },
  {
    id: "w-qc-bot",
    kind: "walkthrough",
    title: "Using QC Bot in Slack",
    page: "/slack",
    keywords: ["slack", "qc bot", "bot", "mention", "dm", "ask in slack", "correct brief"],
    images: [shot("bot-log.jpg", "Every question QC Bot answers is logged in Configuration → AI → Slack bot log.")],
    body: `- **In a channel:** mention **@QC Bot** with your question. It replies in a thread. Messages that don't tag it are ignored.
- **In a DM:** just write to it. It remembers the conversation.
- It reacts 👀 while it works and ✅ when it's done. Any files it makes are attached in the thread.

It can answer anything Scout can: replies, campaigns, leads, meetings, projects, DNC and "how do I…" questions.

**Fixing a brief:** reply in the thread under a morning brief or EOW report and tag @QC Bot ("strike the line about Acme"). It edits the original post.`,
  },
  {
    id: "w-slack-automations",
    kind: "walkthrough",
    title: "Morning briefs and Slack automations",
    page: "/slack",
    keywords: ["morning brief", "eow", "call analysis", "personal assistant", "schedule", "automation"],
    images: [shot("slack.jpg", "The four Slack automations.")],
    body: `The **Slack** page runs four automations: **Morning brief**, **Call analysis**, **EOW report** and **Personal assistant**.

1. Open an automation. Set its schedule with **Edit time and date**, then **Save schedule**.
2. Each client shows readiness checks (HeyReach, Slack, Granola). A client can only be turned **On** once every check passes.
3. Click **Generate** to try it. Pick **Show it here** to preview without posting anything.

**Personal assistant** sends one teammate a morning DM covering all their clients. Add them with **+ Add person** and their Slack member ID (Slack profile → ⋮ → Copy member ID).`,
  },
  {
    id: "w-dnc",
    kind: "walkthrough",
    title: "Adding a company to Do Not Contact",
    page: "",
    keywords: ["dnc", "do not contact", "blacklist", "exclude", "clay", "suppress"],
    images: [shot("qc-brain.jpg", "Each client's Do not contact list is linked from their QC Brain page.")],
    body: `DNC lists are per client and managed by asking QC Bot (or Scout):

- "Add Acme to Willow's DNC"
- "Is acme.com on the DNC for Willow?"
- "Remove Acme from Willow's DNC"

Each company is saved in QC Command and sent to the client's Clay DNC table, where Clay fills in the domain.

**First time for a client?** It needs their **Clay DNC webhook** set in Configuration → the client. If it's missing, the bot will tell you. Removing a company only removes it from our copy, so the row in Clay has to be deleted there.`,
  },
  {
    id: "w-qc-brain",
    kind: "walkthrough",
    title: "Browsing and editing the QC Brain",
    page: "/qc-brain",
    keywords: ["brain", "knowledge", "icp doc", "docs", "github", "edit doc", "skills"],
    images: [shot("qc-brain.jpg", "A client's QC Brain page.")],
    body: `The **QC Brain** is our shared knowledge base: each client's ICP, personas, voice guide and notes.

1. Open **QC Brain** and search, or browse by area or client.
2. On a client, **Generate ICP document** drafts one in about a minute.
3. Open any doc. Switch between **Readable** and **Original**.
4. To change it, click **Edit**, make the change, write a one-line summary and click **Propose change**. This opens a review in GitHub. Nothing changes until it's approved.

You can also ask the brain a question instead of browsing it, here or in Slack.`,
  },
  {
    id: "w-deals",
    kind: "walkthrough",
    title: "Deals and attribution",
    page: "/deals",
    keywords: ["deal", "crm", "hubspot", "attio", "attribution", "pipeline", "revenue"],
    images: [shot("deals.jpg", "A client's deal pipeline, with QC's share up top."), shot("deal-drawer.jpg", "Matched on explains why a deal was credited to QC.")],
    body: `1. Open **Deals** and pick a client. If their CRM isn't connected, pick **HubSpot** or **Attio**, paste the API key and click **Connect & sync**.
2. Deals that QC sourced are matched automatically. **Matched on** explains why.
3. "Possible" matches (same company) need a check. Click **✓ Verified by you**, or **Not a QC deal**.
4. Switch between **Pipeline** and **List**, or toggle **QC-sourced only**. **Sync now** pulls the latest.`,
  },
  {
    id: "w-configuration",
    kind: "walkthrough",
    title: "Setting up a client in Configuration",
    page: "/admin",
    keywords: ["configuration", "admin", "client brief", "api key", "slack channel", "webhook", "logo", "ai prompt"],
    images: [shot("admin", "Configuration: Client directory, AI, Granola keys, Feedback and Audit log.")],
    body: `**Configuration** holds each client's settings. Click a client in the **Client directory**, change what you need, then **Save changes**.

- **HeyReach connection**: API key, messaging doc, webhook URL.
- **Client profile**: the **CLIENT BRIEF**. Every AI draft, ICP score and follow-up score for this client reads it, so keep it current.
- **Slack channels**: internal and external channel IDs.
- **Call transcripts**: the meeting-title words that match Granola calls to this client.
- **Clay DNC webhook**, **Airtable base**, and **Theme & logo**.

The **AI** tab holds the prompts behind sentiment, ICP docs and briefs, plus the **Slack bot log**.`,
  },
  {
    id: "w-appearance",
    kind: "walkthrough",
    title: "Changing how QC Command looks",
    page: "",
    keywords: ["appearance", "theme", "dark", "light", "accent", "color", "zoom", "font", "time zone"],
    images: [shot("appearance", "The Appearance panel.")],
    body: `Click **◐** at the top right of any page.

- **MODE**: Dark or Light.
- **ZOOM**: make everything bigger or smaller.
- **FONT** and **BACKGROUND**.
- **ACCENT**: pick any colour. **Reset to teal** puts the brand colour back.
- **DASHBOARD TIME ZONE**: what "today" means for reply dates and counts.

Click **Save appearance**, or just click away. It's saved to your profile.`,
  },

  // ── FAQ ───────────────────────────────────────────────────────────────────
  {
    id: "f-shared",
    kind: "faq",
    title: "What do teammates see that I change?",
    page: "",
    keywords: ["shared", "team", "private", "star", "tag", "visible"],
    images: [shot("tag-menu.jpg", "Tags are shared. A tag added here shows for the whole team.")],
    body: `- **Shared with everyone:** tags, sent replies, client settings, Help articles, tasks, meetings, DNC.
- **Just yours:** stars, Inbox layout, Appearance, saved Scout prompts.`,
  },
  {
    id: "f-this-week",
    kind: "faq",
    title: "Why don't \"this week\" numbers match?",
    page: "/inbox",
    keywords: ["this week", "numbers", "mismatch", "monday", "sunday", "count"],
    images: [shot("inbox-toolbar.jpg", "The Inbox time ranges.")],
    body: `The Inbox's **This week** counts from Sunday. The Dashboard's **Replies this week** counts from Monday. Both use the time zone set in Appearance.`,
  },
  {
    id: "f-reply-sync",
    kind: "faq",
    title: "How fast do new replies show up?",
    page: "/inbox",
    keywords: ["sync", "delay", "new reply", "missing reply", "webhook", "refresh"],
    images: [shot("inbox-queue.jpg", "Last synced shows when replies last came in.")],
    body: `HeyReach sends each reply to QC Command as it lands, so it should appear on its own. If a thread looks out of date, open it and click the refresh icon (**Refresh conversation from HeyReach**).`,
  },
  {
    id: "f-ai-context",
    kind: "faq",
    title: "What does the AI know about my client?",
    page: "/admin",
    keywords: ["ai", "brief", "context", "prompt", "why did ai", "knowledge"],
    images: [shot("client-context.jpg", "The client brief and documents every AI run reads.")],
    body: `Drafts and scores read the client's **CLIENT BRIEF** and any uploaded client documents (Configuration → AI → **Client AI context**), plus the conversation itself. Update the brief and the next draft uses it straight away.`,
  },
  {
    id: "f-credits",
    kind: "faq",
    title: "What uses enrichment credits?",
    page: "/cold-calling",
    keywords: ["credits", "ai ark", "cost", "enrich", "phone"],
    images: [shot("lead-drawer.jpg", "Enrich next to Phone number uses credits.")],
    body: `AI Ark credits are used by **Enrich** on a lead's phone number (5 credits) and by **Fetch & enrich** in Cold calling (one lookup per person).`,
  },

  // ── Troubleshooting ───────────────────────────────────────────────────────
  {
    id: "t-no-replies",
    kind: "troubleshooting",
    title: "A client's replies aren't showing up",
    page: "/health",
    keywords: ["missing", "no replies", "not showing", "webhook", "empty inbox", "broken"],
    images: [shot("health.jpg", "Client connection heartbeat shows which clients need attention.")],
    body: `1. Open **System health** and look at **Client connection heartbeat** for that client.
2. Check the HeyReach API key in Configuration → the client → **HeyReach connection**.
3. Make sure the client's HeyReach webhook points at the **WEBHOOK ENDPOINT** shown there.
4. Still stuck? Ask in Slack or send **Feedback** (Configuration → Feedback).`,
  },
  {
    id: "t-brief-missing",
    kind: "troubleshooting",
    title: "The morning brief didn't post",
    page: "/slack",
    keywords: ["brief", "didn't post", "missing brief", "slack", "morning"],
    images: [shot("morning-brief.jpg", "A red check (like Bead's missing HeyReach key) stops the brief for that client.")],
    body: `1. Open **Slack → Morning brief** and check the client is **On**.
2. Look at its readiness checks. Any failing check (HeyReach, Slack or Granola) stops it.
3. Check the internal channel ID is right in Configuration.
4. Click **Generate** with **Show it here** to see what it would have written.`,
  },
  {
    id: "t-stale-clients",
    kind: "troubleshooting",
    title: "The client list or numbers look wrong",
    page: "",
    keywords: ["wrong", "stale", "old", "client list", "dash", "numbers"],
    images: [shot("dashboard.jpg", "A dash where a number should be means it couldn't load.")],
    body: `A dash where a number should be means the data couldn't load. Refresh the page. If it keeps happening, open **System health** to see which service is down. The sidebar client list is remembered from your last visit, so it can look out of date until the page reloads.`,
  },
  {
    id: "t-deleted-came-back",
    kind: "troubleshooting",
    title: "A lead I deleted came back",
    page: "/database",
    keywords: ["deleted", "came back", "reappeared", "block", "remove lead"],
    images: [shot("danger-zone.jpg", "Use Block lead, not Delete lead, to stop them for good.")],
    body: `**Delete lead** only removes what's there now. Their next reply brings them back. Use **Block lead** instead (Database → the lead → **Danger zone**) to stop them for good.`,
  },

  // ── Support ───────────────────────────────────────────────────────────────
  {
    id: "s-get-help",
    kind: "support",
    title: "Getting help",
    page: "",
    keywords: ["help", "support", "contact", "bug", "feedback", "kiril", "ticket"],
    images: [shot("feedback.jpg", "Configuration → Feedback.")],
    body: `1. **Search this page** first.
2. **Ask @QC Bot** in Slack, or ask **Scout** (the Scout tab, or the help button in the corner). It reads these articles.
3. **Report a bug** in Configuration → **Feedback**. Add a screenshot if you can.
4. Still blocked? Message Kiril.`,
  },
  // ── More walkthroughs ─────────────────────────────────────────────────────
  {
    id: "w-follow-ups",
    kind: "walkthrough",
    title: "Working the Follow-ups list",
    page: "/inbox",
    keywords: ["follow-up", "follow ups", "urgency", "gone quiet", "nudge", "chase"],
    images: [shot("followups.jpg", "Follow-ups, ranked by urgency, with the reason shown on the right.")],
    body: `1. In the **Inbox**, click **Follow-ups** above the queue.
2. Leads who have gone quiet are listed with an **URGENCY** score out of 100. Highest first.
3. Open one. The **FOLLOW-UP RECOMMENDED** box says why they need a nudge.
4. Check the **AI DRAFT**, edit it, and send.

Want fewer or more alerts? Change **FOLLOW-UP ALERT THRESHOLD** or **FOLLOW-UP PROMPT** in Configuration → AI → **Client AI context**.`,
  },
  {
    id: "w-custom-dates",
    kind: "walkthrough",
    title: "Looking at a custom date range",
    page: "/inbox",
    keywords: ["custom", "date range", "dates", "calendar", "last month", "period"],
    images: [shot("custom-dates.jpg", "Custom → Pick dates.")],
    body: `1. In the **Inbox**, click **Custom** above the queue.
2. Click **Pick dates**, then click a start day and an end day on the calendar.
3. Click **Done**. The queue and the numbers above it now cover only those days.

**Clear** on the calendar removes the range. Click **Today** or **All replies** to go back.`,
  },
  {
    id: "w-sentiment",
    kind: "walkthrough",
    title: "Sentiment and re-scoring a reply",
    page: "/inbox",
    keywords: ["sentiment", "positive", "negative", "neutral", "rescore", "wrong sentiment"],
    images: [shot("sentiment.jpg", "The sentiment badge on an open conversation.")],
    body: `Every reply gets a sentiment badge: **Positive**, **Neutral** or **Negative**.

- **Looks wrong?** Click the badge on the open conversation to re-score it with the current rules.
- **See only one kind:** **Filters → Sentiment**.
- **Change the rules:** Configuration → AI → **Prompts** → Sentiment analysis. **Reset to default prompt** undoes your edits.`,
  },
  {
    id: "w-lead-score",
    kind: "walkthrough",
    title: "Lead score and tiers",
    page: "/inbox",
    keywords: ["lead score", "icp score", "score", "tier", "hot", "warm", "nurture", "fit"],
    images: [shot("lead-score.jpg", "LEAD SCORE is the last column of the queue.")],
    body: `The **LEAD SCORE** column is how well a lead fits the client's ICP, scored by the AI from their profile.

- Sort by it with **Filters → Sort → Score**.
- Narrow to **Filters → Tier**: Hot, Warm or Nurture.
- The score follows the client's **ICP PROMPT** and **CLIENT BRIEF** (Configuration → AI → **Client AI context**). Sharpen those and new scores improve.`,
  },
  {
    id: "w-inbox-analytics",
    kind: "walkthrough",
    title: "Graphs under the Inbox",
    page: "/inbox",
    keywords: ["graph", "chart", "client analytics", "reply volume", "add graph"],
    images: [shot("inbox-graphs.jpg", "Client analytics under the reply queue.")],
    body: `Scroll below the reply queue to **Client analytics**.

1. Pick a range: **Today**, **This week**, **This month**, **This quarter** or **All time**.
2. Click **+ Add graph** to add another chart.
3. Use the **⚙** on a graph to change it, or **×** to remove it.

Don't want them? Turn off **Show inbox analytics** in the **⚙** Inbox layout panel.`,
  },
  {
    id: "w-personal-inbox",
    kind: "walkthrough",
    title: "General inbox, client inbox and your inbox",
    page: "/inbox",
    keywords: ["general inbox", "my inbox", "client inbox", "profile inbox", "scope"],
    images: [shot("profile-inbox.jpg", "A teammate's own inbox, with only their clients.")],
    body: `There are three ways to open the Inbox:

- **General inbox**: every client at once. Click **Inbox** in the sidebar.
- **One client**: click the client in the sidebar's **Clients** list.
- **Your clients only**: open your card under **Profiles** on the Dashboard.

Each one remembers its own layout.`,
  },
  {
    id: "w-export",
    kind: "walkthrough",
    title: "Exporting leads to a spreadsheet",
    page: "/database",
    keywords: ["export", "csv", "download", "spreadsheet", "excel", "list"],
    images: [shot("database.jpg", "Export CSV ↓ sits at the top right of the Database.")],
    body: `- **Database:** set your filters, then click **Export CSV ↓**.
- **Inbox:** click **Export ↓** above the queue. It exports what you're looking at.
- **Cold calling:** **Export** downloads the call list.
- **Scout:** ask for a list ("export Willow's positive replies this month"). Long lists come back as a count with the full list attached as a CSV to download.`,
  },
  {
    id: "w-block",
    kind: "walkthrough",
    title: "Blocking a lead for good",
    page: "/database",
    keywords: ["block", "unblock", "stop", "remove", "spam", "never show"],
    images: [shot("danger-zone.jpg", "Danger zone at the bottom of a lead's record.")],
    body: `1. Open the lead in **Database**.
2. Scroll to **Danger zone** and click **Block lead**.

They are deleted and every future reply from them is ignored. Blocking needs a LinkedIn profile URL on the lead.

Changed your mind? Open **Blocked leads** at the bottom of the Database and click **Unblock**. Their old conversations don't come back.`,
  },
  {
    id: "w-enrich",
    kind: "walkthrough",
    title: "Finding a lead's phone number",
    page: "/database",
    keywords: ["phone", "mobile", "number", "enrich", "ai ark", "retry enrichment"],
    images: [shot("lead-drawer.jpg", "Enrich sits next to Phone number on the lead's record.")],
    body: `- **One lead:** open them in **Database** and click **Enrich** next to **Phone number**. It uses 5 AI Ark credits and needs a LinkedIn URL.
- **A whole campaign:** in **Cold calling**, use **+ Add leads → From a campaign → Fetch & enrich**.
- **Profile looks empty?** Click **Retry enrichment** on the lead.

Not every lead has a findable number.`,
  },
  {
    id: "w-call-csv",
    kind: "walkthrough",
    title: "Importing a call list from a CSV",
    page: "/cold-calling",
    keywords: ["csv", "upload", "import", "call list", "spreadsheet"],
    images: [shot("csv-upload.jpg", "+ Add leads → Upload a CSV.")],
    body: `1. Open **Cold calling** and pick the client.
2. Click **+ Add leads**, then **Upload a CSV**.
3. Give it a **List name** so the team knows whose list it is.
4. Click **Choose a CSV file**. Name, phone, LinkedIn, company and title columns are found automatically.
5. Check **Detected columns** look right, then click **Import**.`,
  },
  {
    id: "w-call-outcomes",
    kind: "walkthrough",
    title: "Logging call outcomes",
    page: "/cold-calling",
    keywords: ["outcome", "voicemail", "callback", "interested", "no answer", "called", "notes"],
    images: [shot("call-outcomes.jpg", "Pick an outcome, add a note, then Save & next.")],
    body: `After each call, pick what happened: **Connected**, **Voicemail**, **No answer**, **Interested**, **Callback**, **Not interested**, **Bad number** or **Do not call**.

Add a note if useful, then click **Save & next →**. You need an outcome or a note to save. **Skip** moves on without saving.

The tabs at the top of the list (**All**, **Replied**, **No reply**, **Called**) show who's left.`,
  },
  {
    id: "w-call-script",
    kind: "walkthrough",
    title: "Writing a call script",
    page: "/cold-calling",
    keywords: ["script", "call script", "talk track", "pitch"],
    images: [shot("call-script.jpg", "The CALL SCRIPT tab on the right edge.")],
    body: `1. Open the client in **Cold calling**.
2. Click the **CALL SCRIPT** tab on the right edge.
3. Type or paste the script. It saves as you go (**Saved ✓**).

Each client has one script, shared by everyone who calls for them.`,
  },
  {
    id: "w-pm-views",
    kind: "walkthrough",
    title: "Grouping clients into a View",
    page: "/project-management",
    keywords: ["view", "group", "portfolio", "healthtech", "board"],
    images: [shot("pm-new-view.jpg", "+ New view.")],
    body: `A View puts several clients on one board, like all your healthtech clients.

1. In **Project management**, click **+ New view**.
2. Give it a **Name**, an optional logo and an optional **Internal Slack channel ID**.
3. Tick the **Clients in this view**, then save.

Open it from **VIEWS** at the top of the page.`,
  },
  {
    id: "w-pm-slack",
    kind: "walkthrough",
    title: "Posting a task update to Slack",
    page: "/project-management",
    keywords: ["slack", "post", "update", "status", "internal channel"],
    images: [shot("pm-task.jpg", "The Slack button at the top of a saved task.")],
    body: `1. Make sure the client has an internal channel. In **Project management**, click **⋯** on the client and **Set internal Slack channel**.
2. Open a task and save it.
3. Click the task's Slack button. Its status is posted to that channel.

The button stays disabled until the task is saved.`,
  },
  {
    id: "w-pm-from-slack",
    kind: "walkthrough",
    title: "Managing tasks from Slack",
    page: "/project-management",
    keywords: ["slack", "qc bot", "create task", "update task", "tasks"],
    images: [shot("bot-log.jpg", "Tasks created from Slack show up in the Slack bot log and on the board.")],
    body: `Ask **@QC Bot** and it updates the board for you:

- "Add a task for Kuddo: launch KD009, due Friday, assign Kori"
- "What's blocked for Willow?"
- "Move the Cotool list build to Completed"

Everything it does shows up in **Project management** straight away.`,
  },
  {
    id: "w-onboarding-template",
    kind: "walkthrough",
    title: "Editing the onboarding checklist",
    page: "/onboarding",
    keywords: ["template", "checklist", "steps", "onboarding template"],
    images: [shot("onboarding-template.jpg", "The onboarding template.")],
    body: `1. In **Onboarding**, click **Edit template**.
2. Use **Add step** and **Add sub-step**. Group steps with a **Section (optional)**.
3. Reorder with move up and down, or **Edit** and **Delete** a step.

Changes apply to clients you add from now on.`,
  },
  {
    id: "w-onboarding-updates",
    kind: "walkthrough",
    title: "Posting onboarding updates to Slack",
    page: "/onboarding",
    keywords: ["onboarding update", "slack", "progress", "template message"],
    images: [shot("onboarding-updates.jpg", "Client onboarding updates, ready to send to the client's shared channel.")],
    body: `1. Open the client in **Onboarding**.
2. Under **Client onboarding updates**, click **Start from a template** or write your own.
3. Click **Send to client channel**. It posts to the client's shared channel, so they see it.

**Manage templates** saves messages you reuse. Write **{client}** and it becomes the client's name.`,
  },
  {
    id: "w-jev-tuning",
    kind: "walkthrough",
    title: "Tuning how strict Jev is",
    page: "/jev",
    keywords: ["jev", "threshold", "weighted", "must-pass", "strict", "too many maybes"],
    images: [shot("jev-questions.jpg", "Each question shows its role (Must-have, Exclusion…) and what counts as a fit.")],
    body: `- **Question roles:** mark each question **Must-have**, **Key**, **Exclusion** or **Signal**.
- **Verdict mode:** **Weighted** adds the answers up. **Must-pass** drops anyone who fails a must-have.
- **Thresholds:** **Keep at or above** and **Drop below** set the cut-offs.
- **Always keep if the row mentions:** words that save a row no matter what.

Click **Save questions**, then **Run again**.`,
  },
  {
    id: "w-jev-companies",
    kind: "walkthrough",
    title: "Tagging a company list with Jev",
    page: "/jev",
    keywords: ["company list", "accounts", "tag companies", "jev tags"],
    images: [shot("jev-companies.jpg", "Company lists: describe the tags, then Build Jev setup.")],
    body: `1. Open the client in **Jev** and choose **Company lists**.
2. Under **Describe how to tag the companies**, write the tags you want, then click **Build Jev setup**.
3. Drop the CSV in and click **Run**.
4. Click **Download all, tagged** for the whole list with Jev's tags added.`,
  },
  {
    id: "w-report-template",
    kind: "walkthrough",
    title: "Making your own report template",
    page: "/reports",
    keywords: ["template", "report template", "custom report", "monthly recap"],
    images: [shot("reports-client.jpg", "+ ADD TEMPLATE sits above a client's templates.")],
    body: `1. In **Reports**, click **+ Add template**.
2. Name it, write a one-line card description, and choose **An email to send** or **A PDF document**.
3. Write the prompt: what the report should cover and how it should sound.
4. Click **Save template**. It now appears for every client.`,
  },
  {
    id: "w-report-style",
    kind: "walkthrough",
    title: "Styling a PDF report",
    page: "/reports",
    keywords: ["pdf", "style", "cover", "accent", "branding", "prepared by", "sections"],
    images: [shot("report-build.jpg", "Choose the period, campaigns and sections, then Generate report.")],
    body: `When you run a report you can choose:

- **Sections**: tick only what this client cares about, like Booked meetings or Hot conversations.
- **Report title**, **Prepared by** and a closing note.
- **Accent**, **Cover**, **Headings**, **Density** and **Page budget** for the look.
- **Edit prompt** to change what gets written.

Then click **Generate report**.`,
  },
  {
    id: "w-mcp-files",
    kind: "walkthrough",
    title: "Attaching files and downloading answers in Scout",
    page: "/scout",
    keywords: ["attach", "upload", "screenshot", "pdf", "spreadsheet", "download", "csv"],
    images: [shot("mcp.jpg", "The paperclip sits left of the question box.")],
    body: `- **Attach:** click the paperclip, or drag a screenshot, PDF or spreadsheet onto the chat. Then ask about it ("which of these companies are already in our database?").
- **Download:** tables in answers have **Download CSV** and **Download PDF**. Files the assistant makes appear as chips you can click.
- **Start over:** click **+** for a new conversation.`,
  },
  {
    id: "w-mcp-prompts",
    kind: "walkthrough",
    title: "Saving your own Scout prompts",
    page: "/scout",
    keywords: ["saved prompt", "prompt", "shortcut", "reuse", "favorite question"],
    images: [shot("mcp-save-prompt.jpg", "Name it, write the question, Save.")],
    body: `1. On **Scout**, click **+ Save a prompt of your own**.
2. Name it and write the question.
3. Click **Save**. It appears under **Yours**. Click it any time to run it.

Click **×** to forget one. Saved prompts live in this browser only.`,
  },
  {
    id: "w-bot-corrections",
    kind: "walkthrough",
    title: "Correcting a brief QC Bot posted",
    page: "/slack",
    keywords: ["correct", "fix brief", "wrong line", "edit brief", "strike"],
    images: [shot("bot-log.jpg", "Corrections show up in the Slack bot log like any other question.")],
    body: `1. Find the morning brief or EOW report in Slack.
2. Reply in its thread and tag **@QC Bot** with the fix: "strike the line about Acme" or "the meeting was Thursday, not Friday".
3. The bot edits the original post.

It won't wipe a post, only change the part you point at.`,
  },
  {
    id: "w-personal-assistant",
    kind: "walkthrough",
    title: "Setting up a Personal assistant",
    page: "/slack",
    keywords: ["personal assistant", "dm", "my brief", "member id", "teammate brief"],
    images: [shot("personal-assistant.jpg", "Each teammate's assistant, with their clients and schedule.")],
    body: `The Personal assistant DMs one teammate a morning brief across all their clients.

1. Open **Slack → Personal assistant** and click **+ Add person**.
2. Enter their **NAME** and **SLACK USER ID**. In Slack: their profile → **⋮** → **Copy member ID**.
3. Tick the **Clients to track** and set the schedule.
4. Click **Create assistant**.`,
  },
  {
    id: "w-call-analysis",
    kind: "walkthrough",
    title: "Call analysis after a client call",
    page: "/slack",
    keywords: ["call analysis", "granola", "transcript", "call recap", "meeting notes"],
    images: [shot("call-analysis.jpg", "Call analysis: which clients are on and whether their calls can be read.")],
    body: `When a client call is recorded in Granola, QC Command writes a call analysis and posts it to Slack. It checks for new calls every hour, 5 AM to 8 PM Eastern.

For it to work:
1. The person on the call has a key under Configuration → **Granola keys**.
2. The client's **MEETING TITLE CONTAINS** (Configuration → the client → **Call transcripts**) matches the call's title.
3. The client is **On** under **Slack → Call analysis**.`,
  },
  {
    id: "w-brain-icp",
    kind: "walkthrough",
    title: "Generating an ICP document",
    page: "/qc-brain",
    keywords: ["icp", "icp doc", "ideal customer", "generate", "personas"],
    images: [shot("qc-brain.jpg", "Generate ICP document is on the client's QC Brain page.")],
    body: `1. Open **QC Brain** and pick the client.
2. Click **Generate ICP document**. It takes about a minute.
3. Read it, then click **Edit** to adjust and **Propose change** to save it to the brain.

Missing documents are marked on the client's page, so you can see what still needs writing.`,
  },
  {
    id: "w-ai-prompts",
    kind: "walkthrough",
    title: "Editing the AI prompts",
    page: "/admin",
    keywords: ["prompt", "ai", "system prompt", "morning brief prompt", "sentiment prompt"],
    images: [shot("ai-prompts.jpg", "Configuration → AI → Prompts.")],
    body: `1. Go to Configuration → **AI** → **Prompts**.
2. Pick the prompt: Sentiment analysis, Create ICP doc or Morning brief.
3. Edit and save. The next run uses it.

**Reset to default prompt** puts the original back. Client-specific instructions belong in that client's **Client AI context**, not here.`,
  },
  {
    id: "w-client-docs",
    kind: "walkthrough",
    title: "Giving the AI a client's documents",
    page: "/admin",
    keywords: ["upload", "documents", "pdf", "docx", "context", "case study", "pitch deck"],
    images: [shot("client-context.jpg", "Client brief & documents, with Upload client documents underneath.")],
    body: `1. Go to Configuration → **AI** → **Client AI context** and pick the client.
2. Paste the **CLIENT BRIEF** (the output of /client-summary works well).
3. Use **Upload client documents** for PDFs, Word files or text: case studies, pricing, FAQs.

Every draft, ICP score and follow-up score for that client reads these.`,
  },
  {
    id: "w-granola",
    kind: "walkthrough",
    title: "Adding your Granola key",
    page: "/admin",
    keywords: ["granola", "api key", "calls", "transcripts", "grn"],
    images: [shot("granola.jpg", "Configuration → Granola keys.")],
    body: `1. Go to Configuration → **Granola keys**.
2. Choose **WHOSE KEY** it is and paste the **API KEY** (it starts with grn_).
3. Save.

Your client calls can now feed call analysis and the morning briefs. **Remove** takes a key out.`,
  },
  {
    id: "w-feedback",
    kind: "walkthrough",
    title: "Sending feedback or a bug report",
    page: "/admin",
    keywords: ["feedback", "bug", "report a problem", "idea", "feature request"],
    images: [shot("feedback.jpg", "Configuration → Feedback.")],
    body: `1. Go to Configuration → **Feedback**.
2. Pick **Bug**, **Idea** or **Something else**.
3. Describe **WHAT HAPPENED** and click **Attach a screenshot** if you can. Leave **Staying anonymous** on, or add your name.
4. Click **Submit**.

Everything sent is listed under **Submitted feedback** with its status.`,
  },
  {
    id: "w-audit-log",
    kind: "walkthrough",
    title: "Checking the Audit log and Slack bot log",
    page: "/admin",
    keywords: ["audit", "log", "history", "who changed", "bot log", "events"],
    images: [shot("audit.jpg", "The Audit log."), shot("bot-log.jpg", "The Slack bot log.")],
    body: `- **Audit log** (Configuration → **Audit log**): every change and event. Search, filter by **Source**, **Status** or date, and **Export CSV ↓**.
- **Slack bot log** (Configuration → **AI** → **Slack bot log**): every question QC Bot was asked and what it did. Start here when the bot gives a strange answer.`,
  },
  {
    id: "w-health",
    kind: "walkthrough",
    title: "Reading System health",
    page: "/health",
    keywords: ["health", "status", "down", "outage", "red", "heartbeat"],
    images: [shot("health.jpg", "System health: core services, then each client's connection.")],
    body: `**System health** shows whether everything QC Command depends on is working. It refreshes every 30 seconds, or click **Refresh checks ↻**.

- **Core services**: the database, AI, Slack, Airtable and more. Red means that service is failing.
- **Client connection heartbeat**: whether each client's replies are flowing in.
- **Advanced view** shows the detail behind each check.

It's read-only, so nothing here can break anything.`,
  },
  {
    id: "w-remove-client",
    kind: "walkthrough",
    title: "Removing a client",
    page: "/admin",
    keywords: ["remove", "delete client", "offboard", "churn", "workspace"],
    images: [shot("admin.png", "Open the client from the Client directory, then scroll to Remove workspace.")],
    body: `1. Go to Configuration → **Client directory** and open the client.
2. Scroll to **Remove workspace**.
3. Type the client's name to confirm, then remove.

This can't be undone, so export anything you need first.`,
  },
  {
    id: "w-help-editing",
    kind: "walkthrough",
    title: "Writing a Help article",
    page: "/help",
    keywords: ["help article", "edit help", "loom", "write guide", "add article"],
    images: [shot("help-editor.jpg", "Edit help → + Add article.")],
    body: `1. On **Help**, click **Edit help**.
2. Click **+ Add article**. Pick the section and the page it's about.
3. Write the steps in Markdown: **bold**, - bullets, 1. numbered steps.
4. Paste a Loom link to embed a video, and add search keywords people might type.
5. Click **Add article**.

QC Bot reads these too, so a good article means better answers in Slack.`,
  },
  {
    id: "w-phone",
    kind: "walkthrough",
    title: "Using QC Command on your phone",
    page: "",
    keywords: ["mobile", "phone", "iphone", "small screen", "menu"],
    images: [shot("sidebar.jpg", "On a phone the sidebar opens from the menu button.")],
    body: `QC Command works in your phone's browser. Tap the menu button at the top left (**Open navigation**) to reach every page.

For quick questions on the go, DM **@QC Bot** in Slack instead.`,
  },

  {
    id: "w-scout-history",
    kind: "walkthrough",
    title: "Reopening a Scout conversation",
    page: "/scout",
    keywords: ["history", "saved", "sessions", "past conversation", "reopen", "scout"],
    images: [shot("mcp.jpg", "History sits at the top right of the Scout tab.")],
    body: `Every Scout conversation saves itself once it has an answer.

1. In the **Scout** tab, click **History** at the top right.
2. Click a conversation to reopen it and carry on where you left off.
3. **+ New** starts a fresh one. Hover a conversation to delete it.

Conversations follow your profile, so they're there on another computer too.`,
  },
  {
    id: "w-report-to-kiril",
    kind: "support",
    title: "Reporting a bug or idea from the help button",
    page: "",
    keywords: ["report", "bug", "idea", "feature request", "kiril", "screenshot", "scout"],
    images: [shot("feedback.jpg", "Reports land in Configuration → Feedback, where Kiril works through them.")],
    body: `1. Click **Scout** in the bottom-right corner of any page.
2. Tell Scout what isn't working or what you'd like. Attach a screenshot with the paperclip if it helps.
3. When Scout can't fix it, or it hears an idea, it asks **Do you want to submit this to Kiril?** Click **Yes**.
4. Check the note Scout wrote, add anything missing, and click **Send to Kiril**.

It goes straight to Kiril and he'll work on it. You can follow it in Configuration → **Feedback**.`,
  },
  // ── More FAQ ──────────────────────────────────────────────────────────────
  {
    id: "f-unsend",
    kind: "faq",
    title: "Can I unsend a reply?",
    page: "/inbox",
    keywords: ["unsend", "undo", "delete message", "sent by mistake"],
    images: [shot("inbox-draft.jpg", "Check the draft before Send reply. It can't be taken back.")],
    body: `Not from QC Command. A reply goes out on LinkedIn through HeyReach the moment you click **Yes, send it**. That confirmation step is there so you can check the lead and sender first.`,
  },
  {
    id: "f-brief-vs-brain",
    kind: "faq",
    title: "What's the difference between the Client brief and the QC Brain?",
    page: "/qc-brain",
    keywords: ["brief", "brain", "difference", "context", "icp"],
    images: [shot("client-context.jpg", "The Client brief, in Configuration."), shot("qc-brain.jpg", "The QC Brain, with every document.")],
    body: `- **Client brief**: a short summary of the client in Configuration. Every AI draft and score reads it.
- **QC Brain**: the full library of the client's documents (ICP, personas, voice guide, notes). The assistant and QC Bot search it when you ask.

Keep the brief short and current. Put the detail in the Brain.`,
  },
  {
    id: "f-meetings-source",
    kind: "faq",
    title: "Where do booked meetings come from?",
    page: "/meetings",
    keywords: ["meetings", "calendly", "booked", "missing meeting"],
    images: [shot("meetings.jpg", "Booked meetings arrive here.")],
    body: `From the client's booking tool, through the **Meetings webhook** set up during onboarding. You can also add one with **Add meeting**. A missing meeting usually means the webhook isn't set up for that client yet.`,
  },
  {
    id: "f-time-zone",
    kind: "faq",
    title: "Why are dates in the wrong time zone?",
    page: "",
    keywords: ["time zone", "timezone", "wrong time", "dates", "today"],
    images: [shot("appearance", "DASHBOARD TIME ZONE in the Appearance panel.")],
    body: `Dates and "today" follow the **DASHBOARD TIME ZONE** in Appearance (the **◐** button, top right). Set it to where you are.`,
  },
  {
    id: "f-ai-model",
    kind: "faq",
    title: "Which AI writes the drafts?",
    page: "/admin",
    keywords: ["model", "claude", "anthropic", "which ai", "gpt"],
    images: [shot("ai-overview.jpg", "Configuration → AI → Overview shows the model.")],
    body: `Claude, made by Anthropic. The model and usage are under Configuration → **AI** → **Overview**. Jev uses its own model.`,
  },
  {
    id: "f-cold-calling-missing",
    kind: "faq",
    title: "Why isn't a client in Cold calling?",
    page: "/cold-calling",
    keywords: ["missing client", "cold calling", "not listed", "heyreach"],
    images: [shot("cc-directory.jpg", "Only clients with HeyReach connected are listed.")],
    body: `Cold calling only lists clients with a working HeyReach connection. Add their HeyReach API key in Configuration → the client → **HeyReach connection**.`,
  },

  // ── More troubleshooting ──────────────────────────────────────────────────
  {
    id: "t-draft",
    kind: "troubleshooting",
    title: "The AI draft is empty or off",
    page: "/inbox",
    keywords: ["draft", "empty", "bad draft", "wrong draft", "not generating", "ai"],
    images: [shot("inbox-draft.jpg", "The AI DRAFT and Regenerate ↻.")],
    body: `1. Give it a moment. It says **Generating a draft…** while it works.
2. Click **Regenerate ↻**.
3. Still off? Improve the client's **CLIENT BRIEF** and documents (Configuration → AI → **Client AI context**).
4. Nothing at all? Check **Anthropic API** on **System health**.`,
  },
  {
    id: "t-send-failed",
    kind: "troubleshooting",
    title: "My reply didn't send",
    page: "/inbox",
    keywords: ["send failed", "didn't send", "error sending", "stuck"],
    images: [shot("conversation.jpg", "Refresh the conversation to see whether it went out.")],
    body: `1. Open the conversation and click refresh (**Refresh conversation from HeyReach**). It may have sent after all.
2. Check the sender's LinkedIn account is still connected in HeyReach.
3. Check the client's HeyReach key in Configuration, and **System health**.
4. Still failing? Send **Feedback** with the lead's name.`,
  },
  {
    id: "t-bot-silent",
    kind: "troubleshooting",
    title: "QC Bot isn't answering",
    page: "/slack",
    keywords: ["bot", "no answer", "silent", "not responding", "qc bot"],
    images: [shot("bot-log.jpg", "The Slack bot log shows every run and its outcome.")],
    body: `1. In a channel, you must **@mention** it. Untagged messages are ignored.
2. Look for 👀. If it's there, it's still working.
3. Check Configuration → **AI** → **Slack bot log** for what happened.
4. Check **Slack automations** on **System health**.`,
  },
  {
    id: "t-cant-turn-on",
    kind: "troubleshooting",
    title: "I can't turn a client On for an automation",
    page: "/slack",
    keywords: ["can't turn on", "disabled", "toggle", "readiness", "greyed out"],
    images: [shot("morning-brief.jpg", "A red check means that client can't be turned On yet.")],
    body: `The **On** switch stays disabled until every readiness check passes. Look at the client's row: the failing one (HeyReach, Slack or Granola) tells you what to fix, usually a missing channel ID or key in Configuration.`,
  },
  {
    id: "t-jev-setup",
    kind: "troubleshooting",
    title: "Jev or QC Brain says it isn't set up",
    page: "/jev",
    keywords: ["not set up", "not connected", "banner", "missing key", "openrouter", "github token"],
    images: [shot("jev.jpg", "A connected client shows Jev connected under its name.")],
    body: `These need a key added by an admin. Jev needs its AI key, and the QC Brain needs a GitHub token. Send Kiril the message shown on the page.`,
  },
  {
    id: "t-deal-wrong",
    kind: "troubleshooting",
    title: "A deal is credited to QC by mistake",
    page: "/deals",
    keywords: ["deal", "attribution", "wrong", "not ours", "credited"],
    images: [shot("deal-drawer.jpg", "Not a QC deal removes the attribution.")],
    body: `Open the deal and click **Not a QC deal**. It's removed from QC's totals. **Restore QC attribution** undoes it. **Matched on** shows why it was linked in the first place.`,
  },
  {
    id: "t-tag-missing",
    kind: "troubleshooting",
    title: "I can't find a tag",
    page: "/inbox",
    keywords: ["tag missing", "lost tag", "tag gone", "renamed"],
    images: [shot("tag-menu.jpg", "Search or recreate tags from the + Tag menu.")],
    body: `Tags are shared, so a teammate may have renamed or deleted it. Open **+ Tag** and use **Search tags…**. If it's gone, **+ Create tag** makes it again.`,
  },

  // ── More support ──────────────────────────────────────────────────────────
  {
    id: "s-bug-report",
    kind: "support",
    title: "What to put in a bug report",
    page: "/admin",
    keywords: ["bug report", "what to include", "screenshot", "steps"],
    images: [shot("feedback.jpg", "Pick Bug, describe it and attach a screenshot.")],
    body: `The fastest fixes come from reports that say:

1. **Where:** the page and the client.
2. **What you did:** the button you clicked.
3. **What happened** vs what you expected.
4. **A screenshot**, and the lead's name if it's about one.

Send it from Configuration → **Feedback**, as a **Bug**.`,
  },
  // ── From the October show & tell ──────────────────────────────────────────
  {
    id: "w-scout-unbooked",
    kind: "walkthrough",
    title: "Finding leads who haven't booked yet",
    page: "/scout",
    keywords: ["follow up", "not booked", "calendly", "no meeting", "chase", "pipeline", "scout", "report"],
    images: [shot("mcp.jpg", "Ask Scout for the list. Long lists come back as a count and one CSV.")],
    body: `Scout can read every reply, so it can find the people who were sent a booking link but never booked.

1. Open **Scout**.
2. Ask it in plain words, for example: *Pull an all-time report for Arcjet of leads who got a Calendly link but haven't booked a meeting, so I can follow up.*
3. Scout gives you the count and, for a long list, one CSV to download.

Narrow it the same way: *only positive replies*, *only the last 30 days*, *only Nick's clients*.`,
  },
  {
    id: "w-scout-compare",
    kind: "walkthrough",
    title: "Comparing clients with Scout",
    page: "/scout",
    keywords: ["compare", "benchmark", "vs", "vertical", "healthtech", "how are we doing", "scout", "simplify"],
    images: [shot("mcp.jpg", "Scout pulls the numbers for each client side by side.")],
    body: `Useful when a client asks how they're doing compared to similar accounts.

1. Open **Scout**.
2. Name the clients and the window, for example: *Compare last month's performance for Steadywell and Bluevia.*
3. Scout pulls reply, acceptance and positive reply rates for each and lays them out side by side.

Too much detail? Reply *simplify this* or *give me 3 sentences I can send the client*.`,
  },
  {
    id: "w-pm-blockers",
    kind: "walkthrough",
    title: "Flagging a blocker on a task",
    page: "/project-management",
    keywords: ["blocker", "blocked", "waiting on", "dependency", "messaging", "stuck task"],
    images: [shot("pm-task.jpg", "Blockers sit on the task, with who you're waiting on.")],
    body: `A blocker says who a task is waiting on, so that person sees it when they log in.

1. Open the task in **Project management**.
2. Under **Blockers**, click **＋ Blocker**.
3. Pick who it's **Waiting on**, write **What needs to happen** (e.g. *messaging for the CMO campaign*), and click **Save**.
4. The card now shows **⛔ Waiting on** and their name.
5. When it's done, they tick the blocker to mark it cleared.

A task can have more than one blocker. Click **＋ Add blocker** for each.`,
  },
  {
    id: "w-pm-standup",
    kind: "walkthrough",
    title: "Running your weekly standup from Project management",
    page: "/project-management",
    keywords: ["standup", "weekly call", "sync", "team meeting", "share screen", "view", "agenda"],
    images: [shot("pm-board.jpg", "One board on screen, walked top to bottom.")],
    body: `The healthtech team runs its weekly call straight off the board.

1. Before the call, open your **View** (or the client) in **Project management**.
2. Share your screen and walk the board stage by stage, or switch to **Individuals** to go person by person.
3. Update tasks as you talk: change the status, add a **Blocker**, set the **Due date**.
4. Delete what's done so the board stays clean.
5. Use the Slack button on a task to post its new status to the client's internal channel.

After the call, everyone knows what they own without digging through Slack.`,
  },
  {
    id: "w-graph-builder",
    kind: "walkthrough",
    title: "Building your own graph",
    page: "/inbox",
    keywords: ["custom graph", "chart", "x axis", "y axis", "build your own", "donut", "line", "dashboard"],
    images: [shot("inbox-graphs.jpg", "Pick what goes along the bottom and what gets counted.")],
    body: `Under the reply queue you can add a chart of your own to **Client analytics**.

1. Click **+ Add graph**, then **Build your own**.
2. **X axis**: what goes along the bottom. Day, Week, Client, Campaign, Sender, Sentiment, Follow-up urgency or ICP score band.
3. **Y axis**: what gets counted. Conversations, Replies, Positive replies, Positive reply rate, Avg. replies per conversation, Avg. ICP score or Avg. follow-up urgency.
4. **Type**: Area, Line, Columns, Horizontal bars or Donut. Add a **Title** if you like.
5. Click **Add to dashboard**.

Short on time? **Preset graphs** has ready-made ones. Your graphs are yours only.`,
  },
  {
    id: "w-report-voice",
    kind: "walkthrough",
    title: "Talking a report through out loud",
    page: "/reports",
    keywords: ["voice", "talk", "dictate", "microphone", "report", "eow", "monthly report", "notes"],
    images: [shot("report-build.jpg", "Talk it through, then let it fill the sections.")],
    body: `A report already has the numbers, Slack and the client's calls. Talking adds what only you know.

1. In **Reports**, pick the client and template.
2. Click **Talk it through**, then **Start talking**. For example: *This week we launched 3 campaigns, including one for Black Hat.*
3. Check the transcript and fix anything misheard.
4. Click **Fill the sections**, then **Generate report**.

For a monthly report, set the **Date range** to the whole month. Slack, HeyReach and calls are read for that window instead of the week.`,
  },
  {
    id: "w-analytics-messaging",
    kind: "walkthrough",
    title: "Finding the messaging that works best",
    page: "/analytics",
    keywords: ["best messaging", "hook", "copy", "acceptance rate", "what's working", "best replies", "optimize"],
    images: [shot("analytics.jpg", "Messaging that performed best, ranked by acceptance rate.")],
    body: `1. Open **Analytics** and pick a client.
2. Scroll to **Messaging that performed best**. Each campaign's connection request copy is ranked by acceptance rate, with its reply rate beside it.
3. Click one to read the full connection request and first message.

Only campaigns with more than 50 requests sent are ranked, so one lucky small campaign can't top the list.

For your end of week email, the EOW report has a **Best replies from this week** section.`,
  },
  {
    id: "w-jev-json",
    kind: "walkthrough",
    title: "Setting up Jev with Claude",
    page: "/jev",
    keywords: ["jev", "json", "claude", "setup", "scoring doc", "repo", "config", "paste"],
    images: [shot("jev-questions.jpg", "Paste a setup Claude wrote into the JSON tab.")],
    body: `Already have scoring docs for a client in the repo? Let Claude turn them into a Jev setup.

1. In Claude (connected to the repo), ask: *I'm using Jev. Using this client's scoring docs, give me a JSON setup for the questions Jev should ask about each contact.*
2. In **Jev**, pick the client and switch to the **JSON** tab.
3. Paste it and click **Save JSON setup**.

Setups stay saved for the client, so the lead engineer sets it up once and everyone uses it. Prefer plain words? Use the **Prompt** tab and click **Build Jev setup**.`,
  },
  {
    id: "w-brain-catch-up",
    kind: "walkthrough",
    title: "Catching up on a client you just joined",
    page: "/qc-brain",
    keywords: ["new to client", "joined", "ramp up", "icp", "personas", "weekly call", "context", "handover"],
    images: [shot("qc-brain.jpg", "A client's folder: ICP, personas, voice and call notes.")],
    body: `Joining an engagement mid-way? Read up before you ask anyone.

1. Open **QC Brain** and pick the client.
2. Start with the **ICP** and **Personas**: who we reach out to and why.
3. Read the **Voice** guide before writing any copy.
4. Open the recent weekly calls. Each one has the action items, the key points and the full transcript.

Rather ask? **Scout** reads the same folder: *Who is Hyperpath's ICP and what did we agree on the last call?*`,
  },
  {
    id: "f-rates-vs-heyreach",
    kind: "faq",
    title: "Why is our reply rate different from HeyReach's?",
    page: "/analytics",
    keywords: ["reply rate", "acceptance rate", "heyreach", "benchmark", "doesn't match", "21%", "positive rate"],
    images: [shot("analytics.jpg", "Rates are worked out per campaign from HeyReach's own counts.")],
    body: `Both count from the step before, so most rates match:

- **Acceptance rate** = accepted ÷ connection requests sent.
- **Reply rate** = replies ÷ accepted, not ÷ requests sent.
- **Positive reply rate** = positive replies ÷ accepted. HeyReach's *interested rate* divides by replies instead, so theirs is higher.

Numbers can also be up to a day behind. Click **Sync now** in Analytics. Still off? Send Kiril the campaign and both numbers.`,
  },
  {
    id: "f-deal-attribution",
    kind: "faq",
    title: "How does QC decide a deal came from us?",
    page: "/deals",
    keywords: ["attribution", "influenced", "sourced", "matched on", "possible", "crm", "events"],
    images: [shot("deal-drawer.jpg", "Matched on shows which step credited the deal.")],
    body: `Every deal in the client's CRM goes through these checks in order:

1. **HeyReach**: was a contact on the deal in one of our campaigns? Then it's ours.
2. **Our records**: does a contact match a lead we messaged, or someone who booked a meeting with us (LinkedIn or email)?
3. **Same company**: someone else at that company was contacted. That's only **Possible**, and a person decides.

It isn't based on calendar invites alone, so event-sourced deals count when the person is in our records. A human should still review the list.`,
  },
  {
    id: "f-draft-voice",
    kind: "faq",
    title: "How do drafts sound like our team?",
    page: "/inbox",
    keywords: ["draft", "tone", "voice", "style", "ai reply", "sound like us", "learn"],
    images: [shot("inbox-draft.jpg", "The draft mirrors how the team has been replying.")],
    body: `Every reply sent from QC Command or HeyReach is saved. When a new reply comes in, the draft is written using that client's recent outbound replies as examples, so it copies the team's length, tone and usual moves.

It only learns from the same client, so Arcjet's style never leaks into Willow's drafts.

Draft off? Edit it before sending. The more good replies the team sends, the better the drafts get.`,
  },
];
