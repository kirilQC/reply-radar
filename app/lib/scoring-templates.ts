/**
 * Vetted starting points for the two per-client scoring prompts.
 *
 * A teammate opening a new client's AI config should not have to invent a scoring rubric from a
 * blank textarea, which is how clients ended up with no prompt at all and fell back to the generic
 * one baked into the scoring routes. These are offered as a choice, and every one of them stays
 * editable — the moment the text no longer matches a template it is reported as "Custom", so the
 * label always describes what the AI will actually receive rather than what was picked first.
 *
 * The prompts deliberately contain criteria only. Each scoring route wraps them with its own
 * output contract, so a template that also demanded JSON would fight the route it is used by.
 */

export type ScoringTemplate = {
  id: string;
  name: string;
  /** What the template does, in a sentence a teammate can pick from. */
  summary: string;
  /** The specific signals it rewards, so two similar templates are told apart at a glance. */
  tracks: string;
  prompt: string;
};

export const ICP_TEMPLATES: ScoringTemplate[] = [
  {
    id: "general-seniority",
    name: "General seniority",
    summary: "Scores how much authority and budget the person has, without assuming an industry.",
    tracks: "Job title and seniority, whether they own a budget, company size, and how directly the client's offer touches their remit.",
    prompt: `Score this lead on how likely they are to be able to buy, champion, or block a purchase of the client's offer.

Score higher when:
- The title carries real decision authority over the area the client sells into (founder, owner, C-level, VP, head of, director).
- The person's remit plausibly includes the problem the client solves, based on the client context above.
- The company is large enough to have the problem and to pay for it, but not so large that this person would be too far from the decision.

Score lower when:
- The title is individual-contributor, junior, or in a function unrelated to what the client sells.
- The person is a consultant, student, job seeker, recruiter, agency owner, or a vendor selling a competing or adjacent service.
- The company looks too small or too early to be a realistic buyer for this client.

Rough bands: 85-100 clear decision maker in an obvious fit account. 65-84 senior and relevant, likely a champion. 40-64 adjacent or influence only. 15-39 weak fit. 0-14 wrong audience entirely.`,
  },
  {
    id: "ai-leaders",
    name: "AI & data leaders",
    summary: "For clients selling into the people who own AI, ML, and data platforms.",
    tracks: "AI/ML/data ownership in the title, whether models are actually in production, and data-platform or MLOps responsibility.",
    prompt: `Score this lead on how well they match a buyer who owns artificial intelligence, machine learning, or data at their company.

Score higher when:
- The title names AI, ML, data science, data engineering, data platform, analytics, or research ownership (Chief AI Officer, Head of AI, VP Data, Director of ML, Head of Data Platform).
- The headline or company suggests models are actually in production rather than experimental, or that they are accountable for AI outcomes.
- They are senior enough to own tooling, vendor, or platform decisions for AI and data work.
- The company builds a product where AI or data is core, or is large enough to run a real data organisation.

Score lower when:
- AI appears only as a buzzword in the headline with no evidence of an AI or data remit.
- They are an AI consultant, AI course seller, AI newsletter writer, or otherwise sell AI services rather than buy them.
- The role is engineering or IT generally, with no data or AI ownership.
- They are an individual contributor with no influence over tooling choices.

Rough bands: 85-100 owns AI or data at a company that clearly runs it in production. 65-84 senior AI or data leader, fit but less proven. 40-64 technical and adjacent to AI. 15-39 AI in name only. 0-14 sells AI services, or unrelated.`,
  },
  {
    id: "cyber-leaders",
    name: "Cybersecurity leaders",
    summary: "For clients selling security tooling, services, or compliance into a security function.",
    tracks: "Security ownership and seniority, regulated or high-risk industries, compliance pressure, and whether a security team exists at all.",
    prompt: `Score this lead on how well they match a buyer who owns information security at their company.

Score higher when:
- The title names security, information security, cyber, CISO, SOC, GRC, risk, or compliance with a security scope.
- They are senior enough to own security budget or to bring a vendor into an evaluation (CISO, VP Security, Head of Security, Director of Security, Security Architect at a smaller company).
- The company operates somewhere security spend is non-optional: finance, healthcare, government, defence, critical infrastructure, or a software vendor handling customer data.
- There is a signal of live compliance pressure such as SOC 2, ISO 27001, HIPAA, PCI, NIS2, or FedRAMP.

Score lower when:
- The title is IT or engineering with no explicit security ownership, unless the company is small enough that IT plainly owns security too.
- They sell security services, run a security consultancy, or are a security researcher or trainer rather than a buyer.
- The company is too small to fund a security programme.
- The role is physical security, guarding, or safety rather than information security.

Rough bands: 85-100 security decision maker in a regulated or high-risk account. 65-84 senior security owner. 40-64 IT leader who probably also owns security. 15-39 security-adjacent with no authority. 0-14 sells security, or unrelated.`,
  },
  {
    id: "it-leaders",
    name: "IT & infrastructure leaders",
    summary: "For clients selling infrastructure, managed services, or internal IT tooling.",
    tracks: "IT and infrastructure ownership, estate size, cloud or on-prem responsibility, and whether IT is a cost centre they control.",
    prompt: `Score this lead on how well they match a buyer who owns IT, infrastructure, or internal technology operations.

Score higher when:
- The title names IT, infrastructure, operations, systems, network, cloud, platform, end-user computing, or technology generally (CIO, CTO at a non-software company, VP IT, IT Director, Head of Infrastructure, IT Manager).
- They plausibly control an estate worth serving: multiple sites, a meaningful employee count, hybrid or multi-cloud, or a migration in progress.
- They own or heavily influence the IT budget, vendor list, or managed service relationships.
- The company is large enough to have real IT complexity but not so large that this person is one of hundreds of managers.

Score lower when:
- The title is software engineering or product, with no responsibility for internal IT.
- They are an MSP owner, IT reseller, or IT recruiter, and would be a partner or competitor rather than a buyer.
- The role is help desk or support with no purchasing influence.
- The company is small enough that IT is outsourced entirely and nobody internal owns it.

Rough bands: 85-100 owns IT and the budget for it at a company with real complexity. 65-84 senior IT leader. 40-64 IT management with influence only. 15-39 technical but not IT. 0-14 sells IT services, or unrelated.`,
  },
  {
    id: "healthtech-leaders",
    name: "Healthtech & clinical leaders",
    summary: "For clients selling into healthcare providers, payers, or health technology companies.",
    tracks: "Clinical versus commercial authority, care setting and size, digital health or informatics ownership, and HIPAA-scale data responsibility.",
    prompt: `Score this lead on how well they match a buyer inside healthcare delivery, health insurance, or a health technology company.

Score higher when:
- The title carries clinical or health-operations authority (Chief Medical Officer, Chief Nursing Officer, Medical Director, VP Clinical Operations, Practice Owner) or health-technology authority (Chief Health Information Officer, VP Digital Health, Head of Clinical Informatics, Director of Health Data).
- The organisation is a provider, payer, health system, hospital group, clinic network, digital health company, medical device company, or life sciences organisation.
- There is a signal that they own patient data, clinical workflow, EHR integration, or regulated health information.
- The care setting is large enough to buy: a multi-site group, a health system, a payer, or a funded digital health company.

Score lower when:
- They are a solo practitioner or a very small practice with no budget for outside technology or services, unless the client explicitly sells to that segment.
- They are a healthcare recruiter, medical educator, wellness coach, or supplement or aesthetics seller rather than a healthcare buyer.
- The role is clinical delivery with no purchasing or workflow authority, such as a staff nurse or resident.
- The company is in healthcare marketing or media rather than care delivery or health technology.

Rough bands: 85-100 clinical or digital health decision maker at a real provider, payer, or health tech company. 65-84 senior and relevant with likely influence. 40-64 in healthcare but limited authority. 15-39 healthcare adjacent. 0-14 wellness, education, or recruiting rather than healthcare buying.`,
  },
];

export const FOLLOW_UP_TEMPLATES: ScoringTemplate[] = [
  {
    id: "awaiting-us",
    name: "Waiting on us",
    summary: "Ranks by how long a lead has been waiting for a reply from your side. The safest default: it never nags anyone who is already waiting on them.",
    tracks: "Whose turn it is, how long the lead's last message has gone unanswered, and whether they asked something we did not answer.",
    prompt: `Score how urgently this conversation needs a message from us.

The single most important question is whose turn it is. If the most recent message is from the lead, we are the ones holding the conversation up.

Score higher when:
- The lead sent the most recent message and it has gone unanswered — the longer it has sat, the higher the score.
- The lead asked a direct question, requested information, or raised an objection that we never addressed.
- The lead agreed to something (a call, an intro, a document) and is waiting for us to make it happen.
- The reply was warm or positive and the momentum is now at risk of being wasted.

Score lower or zero when:
- We sent the most recent message and the lead simply has not answered yet — that is their turn, not ours.
- The lead declined clearly, asked us to stop, or said they are not interested.
- The lead asked for contact at a specific later date that has not arrived yet.

Score 0 when no message from us is needed right now.`,
  },
  {
    id: "meeting-momentum",
    name: "Meeting momentum",
    summary: "Optimised for booking calls. Pushes hardest on leads who were close to a meeting and then stalled.",
    tracks: "Scheduling intent, calendar links sent, dropped scheduling threads, no-shows, and reschedules that never got a new date.",
    prompt: `Score how urgently this conversation needs a message from us in order to get a meeting on the calendar.

Score higher when:
- The lead expressed interest in a call, demo, or intro and no date has been agreed yet.
- Scheduling was discussed and then went quiet: a calendar link was sent and never booked, times were proposed and never confirmed, or a reschedule was promised and no new date followed.
- The lead cancelled or missed a meeting and there has been no attempt to rebook it since.
- The lead asked a logistical question about a meeting (timing, attendees, length, agenda) that has not been answered.
- The lead is clearly willing but is waiting on options from us.

Score lower when:
- A meeting is already confirmed on a future date and nothing is outstanding.
- The lead has not expressed any interest in speaking.
- The lead explicitly declined a meeting.

Score 0 when there is no realistic path to a meeting from the current state of the conversation.`,
  },
  {
    id: "timing-revisit",
    name: "Timing revisit",
    summary: "For long sales cycles. Stays quiet while a lead's stated timing window is still open, then surfaces them the moment it arrives.",
    tracks: "Stated timing (\"next quarter\", \"after our renewal\", \"Q1\"), budget cycles, contract end dates, and whether that window has now passed.",
    prompt: `Score how urgently this conversation needs a message from us, judged mainly on timing the lead told us about.

First, look for any timing the lead stated: a month or quarter, a budget cycle, a contract renewal, a project start, a hiring plan, or a vaguer "later" such as "a few months" or "after the summer". Compare that stated window against how long ago the message was sent.

Score higher when:
- The lead pushed us to a specific later time and that time has now arrived or passed. The further past it, the higher the score.
- The lead named a triggering event (a renewal, funding, a launch, a reorg) that has plausibly happened by now.
- The lead was interested but blocked by budget or timing, and enough time has passed that the block may be gone.

Score lower or zero when:
- The lead named a window that has not arrived yet — the correct action is to wait, not to message.
- The lead never expressed interest, so there is no timing to revisit.
- The lead said no outright rather than not yet.

Score 0 whenever the right move is still to wait.`,
  },
  {
    id: "revive-cold",
    name: "Revive cold threads",
    summary: "For working a backlog. Surfaces leads who showed genuine interest at some point and then went quiet, oldest and warmest first.",
    tracks: "Past positive signals, how long the thread has been silent, number of replies before it died, and whether it ended on a promise.",
    prompt: `Score how worthwhile it would be to revive this conversation, treating it as part of a backlog of threads that went quiet.

Score higher when:
- The lead engaged genuinely at some point: multiple replies, a question about the offer, positive sentiment, or an agreement to a next step.
- The conversation then went silent without a clear no, and has been silent long enough that a fresh angle would not feel pushy.
- The thread ended on an unresolved promise from either side that was never delivered.
- The lead's engagement was recent enough that they will still remember the conversation.

Score lower when:
- The lead never replied with anything substantive, so there is nothing to revive.
- The lead declined, unsubscribed, or asked us to stop.
- The conversation is still active, with a message from either side in the last few days — this template is for cold threads, not live ones.
- The silence is so old, or the engagement so thin, that a revival would read as a cold approach.

Score 0 when the thread is either still live or not worth reopening.`,
  },
];

export const DEFAULT_ICP_TEMPLATE_ID = "general-seniority";

/**
 * Names the template a prompt came from, or reports it as custom.
 *
 * Derived by comparing text rather than stored alongside it: a stored id would keep claiming
 * "AI & data leaders" after somebody rewrote the prompt into something else entirely, and the
 * label exists precisely so a teammate can trust it describes what the AI receives.
 */
export function templateLabel(templates: ScoringTemplate[], prompt: string): { id: string; name: string } {
  const normalize = (value: string) => value.replace(/\s+/g, " ").trim();
  if (!normalize(prompt)) return { id: "", name: "None selected" };
  const match = templates.find((template) => normalize(template.prompt) === normalize(prompt));
  return match ? { id: match.id, name: match.name } : { id: "", name: "Custom" };
}

/** Client context long enough for ICP scoring to mean anything. */
export const MIN_CLIENT_BRIEF_LENGTH = 80;
