import { expect, test } from "bun:test";

import type { Http, HttpRequest } from "../src/messenger/http.ts";
import { Mattermost, type MmPost } from "../src/messenger/mattermost.ts";
import {
  formatMattermostInbound,
  type MmInboundState,
  type MmInboundStore,
  pollMattermostInbound,
} from "../src/messenger/mattermost-inbound.ts";
import { fakeClock } from "./fakes.ts";

const OWNER = "o".repeat(26);
const SELF = "s".repeat(26);
const DM = "d".repeat(26);
const DEV = "v".repeat(26);
const TOWN = "t".repeat(26);

const post = (id: string, patch: Partial<MmPost> = {}): MmPost => ({
  id,
  channel_id: DEV,
  root_id: "",
  user_id: OWNER,
  message: `text ${id}`,
  type: "",
  create_at: 2000,
  update_at: 2000,
  edit_at: 0,
  delete_at: 0,
  ...patch,
});

/** A server holding posts per channel; `since` filters on update_at the way Mattermost does. */
const server = (posts: Record<string, MmPost[]>) => {
  const seen: HttpRequest[] = [];
  const http: Http = async (req) => {
    seen.push(req);
    const path = new URL(req.url).pathname + new URL(req.url).search;
    let out: unknown = {};
    if (path.endsWith("/users/me/channels"))
      out = [
        { id: DM, name: `${OWNER}__${SELF}`, type: "D", team_id: "" },
        { id: DEV, name: "dev", type: "O", team_id: "T" },
        { id: TOWN, name: "town-square", type: "O", team_id: "T" },
      ];
    const m = /\/channels\/(\w+)\/posts\?since=(\d+)/.exec(path);
    if (m?.[1] && m[2]) {
      const since = Number(m[2]);
      out = { posts: Object.fromEntries((posts[m[1]] ?? []).filter((p) => p.update_at > since).map((p) => [p.id, p])) };
    }
    return { status: 200, headers: {}, body: JSON.stringify(out) };
  };
  return { http, seen, posts };
};

const memoryStore = (initial?: MmInboundState): MmInboundStore & { state?: MmInboundState } => {
  const store: MmInboundStore & { state?: MmInboundState } = {
    ...(initial ? { state: initial } : {}),
    load: () => store.state,
    save: (s) => {
      store.state = s;
    },
  };
  return store;
};

const poll = async (s: ReturnType<typeof server>, store: MmInboundStore, now = 1000) => {
  const warned: string[] = [];
  const lines: string[] = [];
  await pollMattermostInbound(
    new Mattermost(s.http, fakeClock(0), { url: "https://mm.example", token: "t" }),
    store,
    { ownerId: OWNER, selfId: SELF, ignore: new Set(["town-square"]), now: () => now, warn: (m) => warned.push(m) },
    (i) => lines.push(formatMattermostInbound(i)),
  );
  return { lines, warned };
};

test("a first run starts from now: history before it is never replayed", async () => {
  const s = server({ [DEV]: [post("old", { create_at: 500, update_at: 500 })] });
  const store = memoryStore();
  expect((await poll(s, store, 1000)).lines).toEqual([]);
  expect(store.state?.since).toBe(1000);
});

test("the owner's new post is emitted once with its thread, marked with eyes, and others' posts are skipped", async () => {
  const s = server({
    [DEV]: [
      post("p1", { root_id: "root1", file_ids: ["f1"] }),
      post("p2", { user_id: SELF }),
      post("p3", { type: "system_join_channel" }),
      post("p4", { delete_at: 2100, update_at: 2100 }),
    ],
    [TOWN]: [post("p5", { channel_id: TOWN })],
  });
  const store = memoryStore({ since: 1000, seen: {} });
  const first = await poll(s, store);
  expect(first.lines).toEqual([`INBOUND channel ${DEV} mattermost:${DEV}:root1 p1 ${OWNER} "text p1" files=f1`]);
  const reactions = s.seen.filter((r) => r.url.endsWith("/reactions")).map((r) => JSON.parse(String(r.body)));
  expect(reactions).toEqual([{ user_id: SELF, post_id: "p1", emoji_name: "eyes" }]);
  expect(s.seen.some((r) => r.url.includes(`/channels/${TOWN}/`))).toBe(false);
  expect((await poll(s, store)).lines).toEqual([]);
});

test("a DM top-level post is its own thread root", async () => {
  const s = server({ [DM]: [post("p1", { channel_id: DM })] });
  expect((await poll(s, memoryStore({ since: 1000, seen: {} }))).lines).toEqual([
    `INBOUND dm ${DM} mattermost:${DM}:p1 p1 ${OWNER} "text p1"`,
  ]);
});

test("our own reaction bumps update_at but is not an edit; the owner's real edit is", async () => {
  const s = server({ [DEV]: [post("p1")] });
  const store = memoryStore({ since: 1000, seen: {} });
  await poll(s, store);
  s.posts[DEV] = [post("p1", { update_at: 3000 })];
  expect((await poll(s, store)).lines).toEqual([]);
  s.posts[DEV] = [post("p1", { message: "fixed", update_at: 4000, edit_at: 4000 })];
  expect((await poll(s, store)).lines).toEqual([
    `INBOUND edit:channel ${DEV} mattermost:${DEV}:p1 p1 ${OWNER} "fixed"`,
  ]);
  expect(s.seen.filter((r) => r.url.endsWith("/reactions"))).toHaveLength(1);
});

test("an edit to a post from before the watch started arrives as an edit", async () => {
  const s = server({ [DEV]: [post("p0", { create_at: 500, update_at: 1500, edit_at: 1500 })] });
  expect((await poll(s, memoryStore({ since: 1000, seen: {} }))).lines).toEqual([
    `INBOUND edit:channel ${DEV} mattermost:${DEV}:p0 p0 ${OWNER} "text p0"`,
  ]);
});

test("a failed reaction is a warning; the message is still delivered and not repeated", async () => {
  const s = server({ [DEV]: [post("p1")] });
  const failing: Http = async (req) =>
    req.url.endsWith("/reactions") ? { status: 403, headers: {}, body: "{}" } : s.http(req);
  const store = memoryStore({ since: 1000, seen: {} });
  const warned: string[] = [];
  const lines: string[] = [];
  await pollMattermostInbound(
    new Mattermost(failing, fakeClock(0), { url: "https://mm.example", token: "t" }),
    store,
    { ownerId: OWNER, selfId: SELF, ignore: new Set(), now: () => 1000, warn: (m) => warned.push(m) },
    (i) => lines.push(i.postId),
  );
  expect(lines).toEqual(["p1"]);
  expect(warned[0]).toContain("reaction on p1");
  expect(store.state?.seen).toEqual({ p1: 0 });
});
