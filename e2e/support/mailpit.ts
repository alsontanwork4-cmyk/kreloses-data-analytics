import { run } from "./run";

/**
 * Reads magic-link emails from the local Supabase mail catcher (Mailpit, port 54324), which every
 * worktree shares — so always search by this run's unique addresses.
 */
interface MailpitSummary {
  ID: string;
  Created: string;
}

async function search(email: string): Promise<MailpitSummary[]> {
  const query = encodeURIComponent(`to:"${email}"`);
  const response = await fetch(`${run.mailpitUrl}/api/v1/search?query=${query}&limit=50`);
  if (!response.ok) throw new Error(`Mailpit search failed: ${response.status}`);
  const body = (await response.json()) as { messages: MailpitSummary[] };
  return body.messages;
}

export async function countEmailsTo(email: string): Promise<number> {
  return (await search(email)).length;
}

/** Ids of the messages already sent to `email` (pass to `waitForMagicLink` as `ignoreIds`). */
export async function emailIdsTo(email: string): Promise<Set<string>> {
  return new Set((await search(email)).map((message) => message.ID));
}

/**
 * Waits for a message to `email` received after `since` (and not in `ignoreIds`, which rules out
 * an older link that arrived just before `since`), and returns its sign-in link.
 */
export async function waitForMagicLink(
  email: string,
  since: Date,
  { ignoreIds, timeoutMs = 20_000 }: { ignoreIds?: ReadonlySet<string>; timeoutMs?: number } = {},
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const fresh = (await search(email))
      .filter((message) => !ignoreIds?.has(message.ID))
      .filter((message) => new Date(message.Created).getTime() >= since.getTime() - 1000)
      .sort((a, b) => b.Created.localeCompare(a.Created));
    if (fresh[0]) {
      const response = await fetch(`${run.mailpitUrl}/api/v1/message/${fresh[0].ID}`);
      const message = (await response.json()) as { HTML: string };
      const href = /href="([^"]*\/auth\/confirm[^"]*)"/.exec(message.HTML)?.[1];
      if (!href) throw new Error(`No /auth/confirm link in the email to ${email}`);
      return href.replaceAll("&amp;", "&");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`No magic-link email to ${email} within ${timeoutMs}ms`);
}
