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

const shot = (name: string, caption: string) => ({ src: `/help/${name}.png`, caption });

export const BUILT_IN_HELP: Seed[] = [
  // ── Walkthroughs ──────────────────────────────────────────────────────────
  {
    id: "w-getting-around",
    kind: "walkthrough",
    title: "Getting around QC Command",
    page: "/",
    keywords: ["start", "navigate", "sidebar", "client", "switch client", "overview"],
    images: [shot("dashboard", "The Dashboard, with every page in the sidebar on the left.")],
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
    images: [
      shot("inbox", "The Inbox: the reply queue on the left, the open conversation and AI draft on the right."),
      shot("inbox-toolbar", "Pick a time range, search, filter or export the queue."),
    ],
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
    images: [shot("inbox-draft", "The AI DRAFT box. Edit freely, then Send reply.")],
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
    images: [shot("inbox-filters", "The Filters menu.")],
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
    images: [shot("database", "Search, pick a client, sort, or export every lead.")],
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
    body: `1. Open **Onboarding** and click **Add new client**. Enter the name and click **Create client**.
2. Upload the client's logo.
3. Fill the **QC Command setup** form: HeyReach API key, Airtable base, messaging doc, website and Slack channel IDs. Click **Save setup**.
4. Copy the two webhook URLs into HeyReach (incoming replies) and the booking tool (booked meetings).
5. Work down the checklist. When it's done, click **Mark fully onboarded ✓**.

Use **Client onboarding updates** to post progress to the client's internal Slack channel. **Edit template** changes the checklist for every future client.`,
  },
  {
    id: "w-jev",
    kind: "walkthrough",
    title: "Checking a list with Jev",
    page: "/jev",
    keywords: ["jev", "list", "csv", "icp", "screen", "clean", "good fit", "qualify"],
    body: `Jev screens a contact or company list against the client's ICP before a campaign launches.

1. Open **Jev** and pick the client.
2. Choose **Contact lists** or **Company lists**.
3. Set the questions. **Draft from QC Brain** writes them from the client's ICP, or **Write by hand**. Click **Save questions**.
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
    body: `1. Open **Reports** and pick a client, or **All clients**.
2. Choose a template, like the EOW report or the all-time executive summary, or **Build your own report**.
3. Set the **Date range** or **Period**, pick campaigns, and tick the sections you want.
4. Click **Generate PDF**, or copy the **Email to send**.

Save your own format with **+ Add template**. Past runs are kept under **Past reports**.`,
  },
  {
    id: "w-mcp",
    kind: "walkthrough",
    title: "Asking the MCP assistant",
    page: "/mcp",
    keywords: ["mcp", "assistant", "ask", "ai", "chat", "question", "skill", "prompt"],
    images: [shot("mcp", "Start from a suggested prompt, or ask your own.")],
    body: `The **MCP** page is a chat with the same assistant as QC Bot in Slack. It can read campaigns, replies, the Database, the QC Brain, meetings, deals and these help articles.

1. Open **MCP** and click a suggested prompt, or type your own question.
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
    body: `- **In a channel:** mention **@QC Bot** with your question. It replies in a thread. Messages that don't tag it are ignored.
- **In a DM:** just write to it. It remembers the conversation.
- It reacts 👀 while it works and ✅ when it's done. Any files it makes are attached in the thread.

It can answer anything the MCP page can: replies, campaigns, leads, meetings, projects, DNC and "how do I…" questions.

**Fixing a brief:** reply in the thread under a morning brief or EOW report and tag @QC Bot ("strike the line about Acme"). It edits the original post.`,
  },
  {
    id: "w-slack-automations",
    kind: "walkthrough",
    title: "Morning briefs and Slack automations",
    page: "/slack",
    keywords: ["morning brief", "eow", "call analysis", "personal assistant", "schedule", "automation"],
    images: [shot("slack", "The four Slack automations.")],
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
    body: `DNC lists are per client and managed by asking QC Bot (or the MCP page):

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
    body: `- **Shared with everyone:** tags, sent replies, client settings, Help articles, tasks, meetings, DNC.
- **Just yours:** stars, Inbox layout, Appearance, saved MCP prompts.`,
  },
  {
    id: "f-this-week",
    kind: "faq",
    title: "Why don't \"this week\" numbers match?",
    page: "/inbox",
    keywords: ["this week", "numbers", "mismatch", "monday", "sunday", "count"],
    body: `The Inbox's **This week** counts from Sunday. The Dashboard's **Replies this week** counts from Monday. Both use the time zone set in Appearance.`,
  },
  {
    id: "f-reply-sync",
    kind: "faq",
    title: "How fast do new replies show up?",
    page: "/inbox",
    keywords: ["sync", "delay", "new reply", "missing reply", "webhook", "refresh"],
    body: `HeyReach sends each reply to QC Command as it lands, so it should appear on its own. If a thread looks out of date, open it and click the refresh icon (**Refresh conversation from HeyReach**).`,
  },
  {
    id: "f-ai-context",
    kind: "faq",
    title: "What does the AI know about my client?",
    page: "/admin",
    keywords: ["ai", "brief", "context", "prompt", "why did ai", "knowledge"],
    body: `Drafts and scores read the client's **CLIENT BRIEF** and any uploaded client documents (Configuration → AI → **Client AI context**), plus the conversation itself. Update the brief and the next draft uses it straight away.`,
  },
  {
    id: "f-credits",
    kind: "faq",
    title: "What uses enrichment credits?",
    page: "/cold-calling",
    keywords: ["credits", "ai ark", "cost", "enrich", "phone"],
    body: `AI Ark credits are used by **Enrich** on a lead's phone number (5 credits) and by **Fetch & enrich** in Cold calling (one lookup per person).`,
  },

  // ── Troubleshooting ───────────────────────────────────────────────────────
  {
    id: "t-no-replies",
    kind: "troubleshooting",
    title: "A client's replies aren't showing up",
    page: "/health",
    keywords: ["missing", "no replies", "not showing", "webhook", "empty inbox", "broken"],
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
    body: `A dash where a number should be means the data couldn't load. Refresh the page. If it keeps happening, open **System health** to see which service is down. The sidebar client list is remembered from your last visit, so it can look out of date until the page reloads.`,
  },
  {
    id: "t-deleted-came-back",
    kind: "troubleshooting",
    title: "A lead I deleted came back",
    page: "/database",
    keywords: ["deleted", "came back", "reappeared", "block", "remove lead"],
    body: `**Delete lead** only removes what's there now. Their next reply brings them back. Use **Block lead** instead (Database → the lead → **Danger zone**) to stop them for good.`,
  },

  // ── Support ───────────────────────────────────────────────────────────────
  {
    id: "s-get-help",
    kind: "support",
    title: "Getting help",
    page: "",
    keywords: ["help", "support", "contact", "bug", "feedback", "kiril", "ticket"],
    body: `1. **Search this page** first.
2. **Ask @QC Bot** in Slack, or use the **MCP** page. It reads these articles.
3. **Report a bug** with **Send feedback** in Configuration → **Feedback**. Add a screenshot if you can.
4. Still blocked? Message Kiril.`,
  },
];
