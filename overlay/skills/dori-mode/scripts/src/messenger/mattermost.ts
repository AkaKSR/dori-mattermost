import type { Clock } from "../run.ts";
import { guardText, type Http, type HttpResponse, MessengerError, withBackoff } from "./http.ts";
import { THINKING } from "./telegram.ts";

export type MattermostAuth = { readonly url: string; readonly token: string };

export type MmPost = {
  readonly id: string;
  readonly channel_id: string;
  readonly root_id: string;
  readonly user_id: string;
  readonly message: string;
  readonly type: string;
  readonly create_at: number;
  readonly update_at: number;
  readonly edit_at: number;
  readonly delete_at: number;
  readonly file_ids?: readonly string[];
};
export type MmChannel = { readonly id: string; readonly name: string; readonly type: string; readonly team_id: string };
export type MmUser = { readonly id: string; readonly username: string; readonly is_bot?: boolean };

export type MmTarget = { readonly channelId: string; readonly rootId?: string };

const ID = /^[a-z0-9]{26}$/;
const REF = /^mattermost:([a-z0-9]{26}):([a-z0-9]{26})$/;

export const isMattermostId = (value: string): boolean => ID.test(value);

/** `mattermost:<channel-id>:<root-post-id>`, the thread reference a lane records and `inbound` prints. */
export const threadRef = (channelId: string, rootId: string): string => `mattermost:${channelId}:${rootId}`;

export const parseThreadRef = (ref: string): Required<MmTarget> | undefined => {
  const m = REF.exec(ref);
  return m?.[1] && m[2] ? { channelId: m[1], rootId: m[2] } : undefined;
};

export const THREAD_STATES = ["working", "waiting", "done"] as const;
export type ThreadState = (typeof THREAD_STATES)[number];
const STATE_PREFIX = /^\[(working|waiting|done)\] /;

/** A thread's status line carries its state as a `[state] ` prefix, the way Telegram and Discord name the thread. */
export const withThreadState = (message: string, state: ThreadState): string =>
  `[${state}] ${message.replace(STATE_PREFIX, "")}`;

export class Mattermost {
  private readonly base: string;

  constructor(
    private readonly http: Http,
    private readonly clock: Clock,
    private readonly auth: MattermostAuth,
  ) {
    this.base = `${auth.url.replace(/\/+$/, "")}/api/v4`;
  }

  private async request(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: string | FormData) {
    const res: HttpResponse = await withBackoff(this.http, this.clock, {
      method,
      url: `${this.base}${path}`,
      headers: {
        Authorization: `Bearer ${this.auth.token}`,
        ...(typeof body === "string" ? { "Content-Type": "application/json" } : {}),
      },
      ...(body === undefined ? {} : { body }),
    });
    if (res.status >= 300) {
      let id = "";
      try {
        id = String((JSON.parse(res.body) as { id?: unknown }).id ?? "");
      } catch {
        // A proxy error page is not JSON; the status alone names the failure.
      }
      throw new MessengerError(`mattermost ${method} ${path}: ${res.status} ${id}`.trim(), res.status, id);
    }
    return res;
  }

  async call<T = unknown>(method: "GET" | "POST" | "PUT" | "DELETE", path: string, body?: unknown): Promise<T> {
    const res = await this.request(method, path, body === undefined ? undefined : JSON.stringify(body));
    return (res.body ? JSON.parse(res.body) : {}) as T;
  }

  me(): Promise<MmUser> {
    return this.call<MmUser>("GET", "/users/me");
  }

  async post(t: MmTarget, text: string, fileIds: readonly string[] = []): Promise<MmPost> {
    return await this.call<MmPost>("POST", "/posts", {
      channel_id: t.channelId,
      message: guardText(text),
      ...(t.rootId ? { root_id: t.rootId } : {}),
      ...(fileIds.length ? { file_ids: fileIds } : {}),
    });
  }

  async edit(postId: string, text: string): Promise<MmPost> {
    return await this.call<MmPost>("PUT", `/posts/${postId}/patch`, { message: guardText(text) });
  }

  getPost(postId: string): Promise<MmPost> {
    return this.call<MmPost>("GET", `/posts/${postId}`);
  }

  async thread(rootId: string): Promise<MmPost[]> {
    const r = await this.call<{ order: string[]; posts: Record<string, MmPost> }>("GET", `/posts/${rootId}/thread`);
    return Object.values(r.posts).sort((a, b) => a.create_at - b.create_at);
  }

  async typing(userId: string, t: MmTarget): Promise<void> {
    await this.call("POST", `/users/${userId}/typing`, { channel_id: t.channelId, parent_id: t.rootId ?? "" });
  }

  async react(userId: string, postId: string, emoji: string): Promise<void> {
    await this.call("POST", "/reactions", { user_id: userId, post_id: postId, emoji_name: emoji });
  }

  async setStatus(userId: string, status: "online" | "away" | "offline" | "dnd"): Promise<void> {
    await this.call("PUT", `/users/${userId}/status`, { user_id: userId, status });
  }

  myChannels(): Promise<MmChannel[]> {
    return this.call<MmChannel[]>("GET", "/users/me/channels");
  }

  /** Posts created, edited or deleted in the channel after `since` (ms), oldest change first. */
  async postsSince(channelId: string, since: number): Promise<MmPost[]> {
    const r = await this.call<{ posts?: Record<string, MmPost> }>("GET", `/channels/${channelId}/posts?since=${since}`);
    return Object.values(r.posts ?? {}).sort((a, b) => a.update_at - b.update_at);
  }

  async upload(channelId: string, filename: string, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
    const form = new FormData();
    form.append("channel_id", channelId);
    form.append("files", new Blob([bytes]), filename);
    const res = await this.request("POST", "/files", form);
    const id = (JSON.parse(res.body) as { file_infos?: { id?: string }[] }).file_infos?.[0]?.id;
    if (!id) throw new MessengerError("mattermost upload: no file id in the answer", res.status);
    return id;
  }

  async download(fileId: string): Promise<{ readonly name: string; readonly bytes: Uint8Array<ArrayBuffer> }> {
    const info = await this.call<{ name?: string }>("GET", `/files/${fileId}/info`);
    const res = await this.request("GET", `/files/${fileId}`);
    if (!res.bytes) throw new MessengerError("mattermost download: the http client returned no bytes", res.status);
    return { name: info.name ?? fileId, bytes: res.bytes };
  }
}

export type PostStream = { push(text: string): Promise<void>; finish(text: string): Promise<string> };

/**
 * A reply that grows in place: it is posted as `Thinking…`, edited no faster than the interval while it grows, and
 * the last edit is the answer. Mattermost has no drafts, so the growing text is a real post edited by the Dori.
 */
export const startThinkingPost = async (
  mm: Mattermost,
  clock: Clock,
  t: MmTarget,
  minIntervalMs = 800,
): Promise<PostStream> => {
  const id = (await mm.post(t, THINKING)).id;
  let shown = THINKING;
  let lastAt = clock.now();
  return {
    async push(text) {
      const next = text || THINKING;
      if (next === shown || clock.now() - lastAt < minIntervalMs) return;
      await mm.edit(id, next);
      shown = next;
      lastAt = clock.now();
    },
    async finish(text) {
      if (text !== shown) await mm.edit(id, text);
      return id;
    },
  };
};
