// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import {ATTIO_API_TOKEN} from "attio/server"

/**
 * Reads the QC Growth list (made by QC Command's push, api_slug "qc_growth") and adds it up for the
 * dashboard. Runs in Attio's sandbox with the app's own token, so it always shows the live list.
 */

type Row = Record<string, unknown>
type Count = {label: string; value: number}

export type QcGrowthSummary = {
    found: boolean
    leads: number
    booked: number
    positive: number
    replies: number
    byMonth: Array<{x: string; y: number}>
    byCampaign: Count[]
    bySentiment: Count[]
    byPlatform: Count[]
    bySender: Count[]
    latest: Array<{name: string; campaign: string; sentiment: string; lastReply: string; booked: boolean}>
}

const BASE = "https://api.attio.com/v2"

async function attio(method: string, path: string, body?: unknown): Promise<Row> {
    const response = await fetch(`${BASE}${path}`, {
        method,
        headers: {Authorization: `Bearer ${ATTIO_API_TOKEN}`, "Content-Type": "application/json"},
        body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!response.ok) throw new Error(`Attio answered ${response.status} for ${path}`)
    return (await response.json()) as Row
}

const rows = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : [])
const first = (values: Row, slug: string): Row => rows(values[slug])[0] ?? {}
const text = (values: Row, slug: string): string => {
    const value = first(values, slug)
    const option = value.option as Row | undefined
    return String(option?.title ?? value.value ?? "").trim()
}

function tally(items: string[], top = 10): Count[] {
    const counts = new Map<string, number>()
    for (const item of items) if (item) counts.set(item, (counts.get(item) ?? 0) + 1)
    return [...counts]
        .map(([label, value]) => ({label, value}))
        .sort((a, b) => b.value - a.value)
        .slice(0, top)
}

export default async function loadQcGrowth(): Promise<QcGrowthSummary> {
    const lists = rows((await attio("GET", "/lists")).data)
    const list = lists.find((entry) => entry.api_slug === "qc_growth")
    const empty: QcGrowthSummary = {found: false, leads: 0, booked: 0, positive: 0, replies: 0, byMonth: [], byCampaign: [], bySentiment: [], byPlatform: [], bySender: [], latest: []}
    if (!list) return empty
    const listId = String((list.id as Row).list_id)

    const entries: Row[] = []
    for (let offset = 0; offset < 10000; offset += 500) {
        const page = rows((await attio("POST", `/lists/${listId}/entries/query`, {limit: 500, offset})).data)
        entries.push(...page)
        if (page.length < 500) break
    }
    const values = entries.map((entry) => ({parent: String(entry.parent_record_id ?? ""), v: (entry.entry_values ?? {}) as Row}))

    const months = new Map<string, number>()
    for (const {v} of values) {
        const at = text(v, "qc_first_reply_date")
        if (at) {
            const month = `${at.slice(0, 7)}-01`
            months.set(month, (months.get(month) ?? 0) + 1)
        }
    }

    // The latest replies, with names: the parent people, looked up once each.
    const latestRows = values
        .filter(({v}) => text(v, "qc_last_reply_date"))
        .sort((a, b) => text(b.v, "qc_last_reply_date").localeCompare(text(a.v, "qc_last_reply_date")))
        .slice(0, 15)
    const names = await Promise.all(
        latestRows.map(async ({parent}) => {
            const person = await attio("GET", `/objects/people/records/${parent}`).catch(() => ({}) as Row)
            const name = first(((person.data as Row | undefined)?.values ?? {}) as Row, "name")
            return String(name.full_name ?? "Unknown")
        }),
    )

    return {
        found: true,
        leads: values.length,
        booked: values.filter(({v}) => first(v, "qc_booked_meeting").value === true).length,
        positive: values.filter(({v}) => text(v, "qc_reply_sentiment") === "Positive").length,
        replies: values.reduce((sum, {v}) => sum + (Number(first(v, "qc_reply_count").value) || 0), 0),
        byMonth: [...months].sort(([a], [b]) => a.localeCompare(b)).map(([x, y]) => ({x, y})),
        byCampaign: tally(values.map(({v}) => text(v, "qc_campaign"))),
        bySentiment: tally(values.map(({v}) => text(v, "qc_reply_sentiment") || "Not read yet")),
        byPlatform: tally(values.map(({v}) => text(v, "qc_outreach_platform"))),
        bySender: tally(values.map(({v}) => text(v, "qc_sender"))),
        latest: latestRows.map(({v}, index) => ({
            name: names[index],
            campaign: text(v, "qc_campaign"),
            sentiment: text(v, "qc_reply_sentiment"),
            lastReply: text(v, "qc_last_reply_date"),
            booked: first(v, "qc_booked_meeting").value === true,
        })),
    }
}
