// Built by Kiril Ivlev · https://www.linkedin.com/in/kiril-ivlev/
// Reply Radar — proprietary. Not licensed for redistribution or resale.

/**
 * The one rule both places that save a client's Slack channels have to agree on: a client's internal and
 * external channels belong to that client alone.
 *
 * Coraa's external channel was once saved as Vitalic's internal one, and every Coraa brief came out as a
 * Vitalic brief. The admin console checked for that; the onboarding setup panel wrote the same two columns
 * without checking, so the same mistake could be made one screen over. Kept here, free of I/O, so both
 * save paths say the same thing and the rule has a test. Extra context channels are deliberately exempt:
 * one channel shared by several clients is a choice, not an accident.
 */

export type ChannelOwner = {
  id?: unknown;
  slug?: unknown;
  name?: unknown;
  slack_internal_channel_id?: unknown;
  slack_external_channel_id?: unknown;
};

/** The message for a clash with `other`, or "" when none of `channels` is already one of its own. */
export function channelClashMessage(channels: unknown[], other: ChannelOwner): string {
  const own = channels.filter((channel): channel is string => typeof channel === "string" && Boolean(channel));
  const clash = own.find((channel) => channel === other.slack_internal_channel_id || channel === other.slack_external_channel_id);
  if (!clash) return "";
  const role = clash === other.slack_internal_channel_id ? "internal" : "external";
  const who = String(other.name || other.slug || "another client");
  return `That Slack channel is already ${who}'s ${role} channel. Each client needs its own internal and external channel, otherwise its morning brief reads the other client's conversation.`;
}

/** The first clash across every other client, skipping the rows `isSelf` says are the client being saved. */
export function firstChannelClash(channels: unknown[], others: ChannelOwner[], isSelf: (row: ChannelOwner) => boolean): string {
  for (const other of others) {
    if (isSelf(other)) continue;
    const message = channelClashMessage(channels, other);
    if (message) return message;
  }
  return "";
}
