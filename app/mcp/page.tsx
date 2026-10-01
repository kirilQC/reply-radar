// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import { redirect } from "next/navigation";

/** The assistant tab is called Scout now; old /mcp links (and their ?ask=) land there. */
export default async function McpRedirect({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(await searchParams)) {
    for (const v of Array.isArray(value) ? value : value ? [value] : []) params.append(key, v);
  }
  const query = params.toString();
  redirect(`/scout${query ? `?${query}` : ""}`);
}
