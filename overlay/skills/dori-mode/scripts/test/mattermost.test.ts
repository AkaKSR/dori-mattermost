import { expect, test } from "bun:test";

import { mattermostBootLines, mattermostCheck } from "../src/boot-mattermost.ts";
import type { Http, HttpRequest, HttpResponse } from "../src/messenger/http.ts";
import {
  Mattermost,
  parseThreadRef,
  startThinkingPost,
  threadRef,
  withThreadState,
} from "../src/messenger/mattermost.ts";
import { THINKING } from "../src/messenger/telegram.ts";
import { fakeClock } from "./fakes.ts";

const CH = "c".repeat(26);
const ROOT = "r".repeat(26);

const fakeHttp = (script: (req: HttpRequest, n: number) => HttpResponse) => {
  const seen: HttpRequest[] = [];
  const http: Http = async (req) => {
    seen.push(req);
    return script(req, seen.length);
  };
  return { http, seen };
};
const ok = (body: unknown, status = 200): HttpResponse => ({ status, headers: {}, body: JSON.stringify(body) });
const mm = (http: Http, clock = fakeClock(0)) =>
  new Mattermost(http, clock, { url: "https://mm.example/", token: "tok" });
const body = (req: HttpRequest | undefined) => JSON.parse(String(req?.body));

test("a thread reply posts to the channel with the root id and the uploaded files, under the bearer token", async () => {
  const { http, seen } = fakeHttp(() => ok({ id: "p1", channel_id: CH, root_id: ROOT }));
  const post = await mm(http).post({ channelId: CH, rootId: ROOT }, "deploy finished", ["f1"]);
  expect(post.id).toBe("p1");
  expect(seen[0]?.url).toBe("https://mm.example/api/v4/posts");
  expect(seen[0]?.headers?.["Authorization"]).toBe("Bearer tok");
  expect(body(seen[0])).toEqual({ channel_id: CH, message: "deploy finished", root_id: ROOT, file_ids: ["f1"] });
});

test("an edit patches only the message, and a server refusal surfaces its status and error id", async () => {
  const { http, seen } = fakeHttp((_, n) =>
    n === 1 ? ok({ id: "p1" }) : ok({ id: "api.post.update_post.permissions.app_error" }, 403),
  );
  await mm(http).edit("p1", "new text");
  expect(seen[0]?.method).toBe("PUT");
  expect(seen[0]?.url.endsWith("/posts/p1/patch")).toBe(true);
  expect(body(seen[0])).toEqual({ message: "new text" });
  const err = await mm(http)
    .edit("p2", "x")
    .catch((e: unknown) => e as Error);
  expect(String(err)).toContain("403 api.post.update_post.permissions.app_error");
});

test("text carrying a $( substitution is refused before any request goes out", async () => {
  const { http, seen } = fakeHttp(() => ok({}));
  await expect(mm(http).post({ channelId: CH }, "x $(id)")).rejects.toThrow("$(");
  expect(seen).toHaveLength(0);
});

test("a thread reference round-trips, and anything else is not one", () => {
  expect(parseThreadRef(threadRef(CH, ROOT))).toEqual({ channelId: CH, rootId: ROOT });
  expect(parseThreadRef(`mattermost:${CH}`)).toBeUndefined();
  expect(parseThreadRef(`slack:${CH}:${ROOT}`)).toBeUndefined();
});

test("a thread state replaces the previous state prefix instead of stacking", () => {
  expect(withThreadState("fix login", "working")).toBe("[working] fix login");
  expect(withThreadState("[working] fix login", "done")).toBe("[done] fix login");
});

test("a growing reply is posted as Thinking…, edited no faster than the interval, and ends on the answer", async () => {
  const { http, seen } = fakeHttp(() => ok({ id: "p9" }));
  const clock = fakeClock(10_000);
  const s = await startThinkingPost(mm(http, clock), clock, { channelId: CH, rootId: ROOT });
  clock.at += 100;
  await s.push("Half");
  clock.at += 900;
  await s.push("Half done");
  expect(await s.finish("All done")).toBe("p9");
  expect(seen.map((r) => [r.method, body(r).message])).toEqual([
    ["POST", THINKING],
    ["PUT", "Half done"],
    ["PUT", "All done"],
  ]);
});

test("an upload sends the bytes as multipart into the channel and returns the file id", async () => {
  const { http, seen } = fakeHttp(() => ok({ file_infos: [{ id: "f7" }] }, 201));
  expect(await mm(http).upload(CH, "report.png", new Uint8Array([1, 2, 3]))).toBe("f7");
  const form = seen[0]?.body as FormData;
  expect(seen[0]?.url.endsWith("/files")).toBe(true);
  expect(seen[0]?.headers?.["Content-Type"]).toBeUndefined();
  expect(form.get("channel_id")).toBe(CH);
  expect((form.get("files") as File).name).toBe("report.png");
});

test("a download returns the file's name and its raw bytes", async () => {
  const { http } = fakeHttp((req) =>
    req.url.endsWith("/info")
      ? ok({ name: "voice.m4a" })
      : { status: 200, headers: {}, body: "", bytes: new Uint8Array([9, 8, 7]) },
  );
  const file = await mm(http).download("f1");
  expect(file.name).toBe("voice.m4a");
  expect([...file.bytes]).toEqual([9, 8, 7]);
});

test("typing and presence go to the user's own endpoints with the thread as parent", async () => {
  const { http, seen } = fakeHttp(() => ok({}));
  await mm(http).typing("u1", { channelId: CH, rootId: ROOT });
  await mm(http).setStatus("u1", "online");
  expect(seen[0]?.url.endsWith("/users/u1/typing")).toBe(true);
  expect(body(seen[0])).toEqual({ channel_id: CH, parent_id: ROOT });
  expect(seen[1]?.url.endsWith("/users/u1/status")).toBe(true);
  expect(body(seen[1])).toEqual({ user_id: "u1", status: "online" });
});

test("boot names the Mattermost account, skips an unconfigured one, and fails without the provider's text", async () => {
  const me = { id: "u1", username: "dori" };
  expect(
    (
      await mattermostBootLines(
        mattermostCheck(() => ({ me: async () => me })),
        1000,
      )
    ).lines,
  ).toEqual(["MATTERMOST authenticated user=u1 username=dori (users/me only; inbox delivery unverified)"]);
  expect(await mattermostBootLines(mattermostCheck(null), 1000)).toEqual({
    failed: false,
    lines: ["MATTERMOST skipped (DORI_MATTERMOST_URL or token not set)"],
  });
  const failing = mattermostCheck(() => ({
    me: async () => {
      throw new Error("secret internals");
    },
  }));
  expect(await mattermostBootLines(failing, 1000)).toEqual({ failed: true, lines: ["MATTERMOST auth failed"] });
});
