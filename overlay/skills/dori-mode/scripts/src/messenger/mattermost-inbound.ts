import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { type Mattermost, type MmChannel, type MmPost, threadRef } from "./mattermost.ts";

export type MmInbound = {
  readonly kind: "message" | "edit";
  readonly source: "dm" | "channel";
  readonly channelId: string;
  /** `mattermost:<channel>:<root>`: the thread to answer in (a top-level post is its own root). */
  readonly thread: string;
  readonly postId: string;
  readonly userId: string;
  readonly text: string;
  readonly fileIds: readonly string[];
};

/** `since` is the newest change seen (server ms); `seen` maps each emitted post to the edit_at it was emitted at. */
export type MmInboundState = { readonly since: number; readonly seen: Readonly<Record<string, number>> };
export type MmInboundStore = { load(): MmInboundState | undefined; save(state: MmInboundState): void };

export type MmInboundOptions = {
  readonly ownerId: string;
  readonly selfId: string;
  readonly ignore: ReadonlySet<string>;
  readonly now: () => number;
  readonly warn: (message: string) => void;
};

const SEEN_KEEP = 2000;

export const fileMmInboundStore = (path: string): MmInboundStore => ({
  load() {
    try {
      const state = JSON.parse(readFileSync(path, "utf8")) as MmInboundState;
      return Number.isSafeInteger(state.since) && typeof state.seen === "object" ? state : undefined;
    } catch {
      return undefined;
    }
  },
  save(state) {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    renameSync(tmp, path);
  },
});

const readable = (c: MmChannel, ignore: ReadonlySet<string>): boolean =>
  !ignore.has(c.id) && !ignore.has(c.name.toLowerCase());

/**
 * One poll over every channel the Dori belongs to: the owner's new posts and edits since the last poll, each once.
 * A new post gets an `eyes` reaction, the mark that it was read. Our own reaction bumps the post's update_at, so a
 * post counts as edited only when its edit_at moved past the one it was emitted at. A first run starts from now and
 * replays nothing.
 */
export const pollMattermostInbound = async (
  mm: Mattermost,
  store: MmInboundStore,
  opts: MmInboundOptions,
  emit: (inbound: MmInbound) => void,
): Promise<MmInbound[]> => {
  const state = store.load() ?? { since: opts.now(), seen: {} };
  const seen = new Map(Object.entries(state.seen));
  let newest = state.since;
  const out: MmInbound[] = [];
  for (const channel of (await mm.myChannels()).filter((c) => readable(c, opts.ignore))) {
    for (const post of await mm.postsSince(channel.id, state.since)) {
      newest = Math.max(newest, post.update_at);
      const kind = kindOf(post, seen, state.since, opts.ownerId);
      if (!kind) continue;
      const inbound: MmInbound = {
        kind,
        source: channel.type === "D" || channel.type === "G" ? "dm" : "channel",
        channelId: channel.id,
        thread: threadRef(channel.id, post.root_id || post.id),
        postId: post.id,
        userId: post.user_id,
        text: post.message,
        fileIds: post.file_ids ?? [],
      };
      emit(inbound);
      out.push(inbound);
      seen.delete(post.id);
      seen.set(post.id, post.edit_at);
      if (kind === "message")
        await mm
          .react(opts.selfId, post.id, "eyes")
          .catch((e: unknown) => opts.warn(`mattermost reaction on ${post.id}: ${(e as Error).message}`));
    }
  }
  store.save({ since: newest, seen: Object.fromEntries([...seen].slice(-SEEN_KEEP)) });
  return out;
};

const kindOf = (
  post: MmPost,
  seen: ReadonlyMap<string, number>,
  since: number,
  ownerId: string,
): MmInbound["kind"] | undefined => {
  if (post.user_id !== ownerId || post.type !== "" || post.delete_at > 0) return undefined;
  const emittedAt = seen.get(post.id);
  if (emittedAt !== undefined) return post.edit_at > emittedAt ? "edit" : undefined;
  if (post.create_at > since) return "message";
  return post.edit_at > since ? "edit" : undefined;
};

export const formatMattermostInbound = (i: MmInbound): string =>
  `INBOUND ${i.kind === "edit" ? "edit:" : ""}${i.source} ${i.channelId} ${i.thread} ${i.postId} ${i.userId} ${JSON.stringify(i.text)}` +
  (i.fileIds.length ? ` files=${i.fileIds.join(",")}` : "");
