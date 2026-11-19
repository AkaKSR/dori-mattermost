import type { Mattermost } from "./messenger/mattermost.ts";

/** null when no Mattermost URL and token are configured; boot then skips the check, as Slack with no token. */
export type MattermostCheck = () => Promise<{ readonly userId: string; readonly username: string } | null>;

export const mattermostCheck =
  (client: (() => Pick<Mattermost, "me">) | null): MattermostCheck =>
  async () => {
    if (!client) return null;
    const me = await client().me();
    if (!me.id || !me.username) throw new Error("users/me returned no id or username");
    return { userId: me.id, username: me.username };
  };

/** The boot lines for Mattermost; an answer later than the deadline is a failed check. */
export const mattermostBootLines = async (
  check: MattermostCheck,
  deadlineMs: number,
): Promise<{ readonly failed: boolean; readonly lines: readonly string[] }> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      check(),
      new Promise<"timeout">((resolve) => {
        timer = setTimeout(() => resolve("timeout"), deadlineMs);
      }),
    ]);
    if (result === "timeout") return { failed: true, lines: [`MATTERMOST users/me timed out after ${deadlineMs} ms`] };
    if (result === null) return { failed: false, lines: ["MATTERMOST skipped (DORI_MATTERMOST_URL or token not set)"] };
    return {
      failed: false,
      lines: [
        `MATTERMOST authenticated user=${result.userId} username=${result.username} (users/me only; inbox delivery unverified)`,
      ],
    };
  } catch {
    // Provider text can carry the server's internals, so only the failure is named, as for Slack.
    return { failed: true, lines: ["MATTERMOST auth failed"] };
  } finally {
    clearTimeout(timer);
  }
};
