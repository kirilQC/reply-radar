// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

import HelpCenter from "../HelpCenter";

/** One article's own address, /help/<slug>, for pasting to a teammate or for QC Bot to hand out. */
export default async function HelpArticlePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <HelpCenter initialSlug={slug} />;
}
