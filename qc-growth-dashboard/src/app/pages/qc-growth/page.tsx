// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import React from "react"
import {Card, Chart, EmptyState, Extensions, Grid, LoadingState, Stack, Table, useAsyncCache} from "attio/client"

import loadQcGrowth from "./load-qc-growth.server"

const SENTIMENT_COLOR: Record<string, "green" | "grey" | "red" | "blue"> = {Positive: "green", Neutral: "grey", Negative: "red"}

function Dashboard() {
    const {values} = useAsyncCache({summary: loadQcGrowth})
    const s = values.summary
    if (!s.found || s.leads === 0) {
        return <EmptyState title="No QC Growth replies yet" description="Replies from QC Growth's outreach appear here as soon as QC Command pushes them." />
    }
    const bars = (items: Array<{label: string; value: number}>) => items.map((item) => ({x: item.label, y: item.value}))
    return (
        <Stack gap="large">
            <Grid maxColumns={4} minColumnWidth="small">
                <Card title="Leads who replied">
                    <Chart.Metric value={s.leads} format="number" label="people" />
                </Card>
                <Card title="Booked meetings">
                    <Chart.Metric value={s.booked} format="number" color="green" label="booked" />
                </Card>
                <Card title="Positive replies">
                    <Chart.Metric value={s.positive} format="number" color="teal" label="positive" />
                </Card>
                <Card title="Messages from leads">
                    <Chart.Metric value={s.replies} format="number" color="purple" label="replies" />
                </Card>
            </Grid>
            <Grid maxColumns={2} minColumnWidth="large">
                <Card title="Replies by month">
                    <Chart.Bar data={s.byMonth} xAxis={{label: "First reply", format: "date"}} yAxis={{label: "Leads", format: "number"}} series={[{id: "leads", label: "Leads", color: "blue"}]} />
                </Card>
                <Card title="Reply sentiment">
                    <Chart.Pie data={s.bySentiment.map((slice) => ({...slice, color: SENTIMENT_COLOR[slice.label] ?? "blue"}))} format="number" />
                </Card>
                <Card title="Replies by campaign">
                    <Chart.Bar data={bars(s.byCampaign)} yAxis={{label: "Leads", format: "number"}} series={[{id: "leads", label: "Leads", color: "purple"}]} height="large" />
                </Card>
                <Card title="Replies by sender">
                    <Chart.Bar data={bars(s.bySender)} yAxis={{label: "Leads", format: "number"}} series={[{id: "leads", label: "Leads", color: "teal"}]} />
                </Card>
                <Card title="Replies by platform">
                    <Chart.Pie data={s.byPlatform} format="number" />
                </Card>
            </Grid>
            <Card title="Latest replies">
                <Table label="Latest replies">
                    <Table.Header>
                        <Table.HeaderCell>Lead</Table.HeaderCell>
                        <Table.HeaderCell>Campaign</Table.HeaderCell>
                        <Table.HeaderCell>Sentiment</Table.HeaderCell>
                        <Table.HeaderCell>Last reply</Table.HeaderCell>
                        <Table.HeaderCell>Booked</Table.HeaderCell>
                    </Table.Header>
                    <Table.Body>
                        {s.latest.map((row) => (
                            <Table.Row key={`${row.name}-${row.lastReply}`}>
                                <Table.Cell>{row.name || "Unknown"}</Table.Cell>
                                <Table.Cell>{row.campaign || "Not set"}</Table.Cell>
                                <Table.Cell>{row.sentiment ? <Table.Cell.Badge color={SENTIMENT_COLOR[row.sentiment] ?? "blue"}>{row.sentiment}</Table.Cell.Badge> : "Not read yet"}</Table.Cell>
                                <Table.Cell>{row.lastReply.slice(0, 10) || "Not set"}</Table.Cell>
                                <Table.Cell>{row.booked ? "Yes" : "No"}</Table.Cell>
                            </Table.Row>
                        ))}
                    </Table.Body>
                </Table>
            </Card>
        </Stack>
    )
}

export default Extensions.definePage({
    name: "QC Dashboard",
    Page: () => (
        <React.Suspense fallback={<LoadingState />}>
            <Dashboard />
        </React.Suspense>
    ),
})
