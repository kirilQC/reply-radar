// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { redirect } from "next/navigation";

/** The booked meetings workflow now lives on the client's Operations page. */
export default async function ClientBookingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  redirect(`/operations/${encodeURIComponent(slug)}?view=meetings`);
}
