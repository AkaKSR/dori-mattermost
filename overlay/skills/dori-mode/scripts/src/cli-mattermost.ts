/** The Mattermost side of dori send, typing, presence, inbound, thread and download. */
import { mkdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { type Cli, die, every } from "./cli-context.ts";
import { expandHome } from "./config.ts";
import { fetchHttp } from "./messenger/http.ts";
import {
  isMattermostId,
  Mattermost,
  type MmTarget,
  parseThreadRef,
  THREAD_STATES,
  type ThreadState,
  threadRef,
  withThreadState,
} from "./messenger/mattermost.ts";
import { fileMmInboundStore, formatMattermostInbound, pollMattermostInbound } from "./messenger/mattermost-inbound.ts";
import { realTimers, typingWhile } from "./messenger/typing.ts";
import { realClock } from "./run.ts";

const env = (name: string): string | undefined => process.env[name]?.trim() || undefined;
const list = (name: string): Set<string> =>
  new Set(
    (env(name) ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  );

const client = (): Mattermost => {
  const url = env("DORI_MATTERMOST_URL") ?? die("DORI_MATTERMOST_URL is not set");
  const file = env("DORI_MATTERMOST_TOKEN_FILE");
  const token =
    env("DORI_MATTERMOST_TOKEN") ??
    (file ? readFileSync(expandHome(file), "utf8").trim() : undefined) ??
    die("DORI_MATTERMOST_TOKEN is not set (nor DORI_MATTERMOST_TOKEN_FILE)");
  return new Mattermost(fetchHttp, realClock, { url, token });
};

/** The client for boot: null when Mattermost is not configured, so the check is skipped rather than failed. */
export const configuredMattermost = (): (() => Mattermost) | null =>
  env("DORI_MATTERMOST_URL") && (env("DORI_MATTERMOST_TOKEN") ?? env("DORI_MATTERMOST_TOKEN_FILE")) ? client : null;

/** A channel or root post listed in DORI_MATTERMOST_BLOCKED is never written to, whatever asks. */
const allowed = <T extends MmTarget>(t: T): T => {
  const blocked = list("DORI_MATTERMOST_BLOCKED");
  for (const id of [t.channelId, t.rootId])
    if (id && blocked.has(id)) die(`mattermost ${id} is listed in DORI_MATTERMOST_BLOCKED; nothing was sent`, 3);
  return t;
};

const id = (value: string, what: string): string =>
  isMattermostId(value) ? value : die(`${what} must be a 26-character Mattermost id, got ${JSON.stringify(value)}`);

/** `--thread mattermost:<channel>:<root>`, or `--to <channel>` with an optional `--thread <root-post-id>`. */
const targetOf = ({ opt, values }: Cli): MmTarget => {
  if (values["thread"] !== undefined && !opt("thread")) die("--thread is empty: leave it out to post a new message");
  const thread = opt("thread");
  const ref = thread ? parseThreadRef(thread) : undefined;
  if (ref) return allowed(ref);
  const channelId = id(
    opt("to") ?? die("--to (a channel id) or --thread mattermost:<channel>:<root> is required"),
    "--to",
  );
  return allowed({ channelId, ...(thread ? { rootId: id(thread, "--thread") } : {}) });
};

export const sendMattermost = async (cli: Cli): Promise<void> => {
  const mm = client();
  const text = cli.need("text");
  if (cli.values["edit"] !== undefined) {
    const postId = id(cli.opt("edit") ?? "", "--edit");
    const post = await mm.getPost(postId);
    allowed({ channelId: post.channel_id, ...(post.root_id ? { rootId: post.root_id } : {}) });
    await mm.edit(postId, text);
    return;
  }
  const t = targetOf(cli);
  const fileIds: string[] = [];
  for (const path of cli.strings("file")) {
    const bytes = await Bun.file(path).bytes();
    fileIds.push(await mm.upload(t.channelId, basename(path), bytes));
  }
  const post = await mm.post(t, text, fileIds);
  console.log(`SENT ${post.id} ${threadRef(post.channel_id, post.root_id || post.id)}`);
};

export const typingMattermost = async (cli: Cli): Promise<void> => {
  const mm = client();
  const t = targetOf(cli);
  const me = await mm.me();
  // The first call is not swallowed: a wrong target or token fails here, before the loop hides it.
  await mm.typing(me.id, t);
  console.log(`TYPING_READY mattermost ${t.channelId} ${t.rootId ?? "-"}`);
  await typingWhile(
    () => mm.typing(me.id, t),
    realTimers,
    () => new Promise<never>(() => {}),
  );
};

export const presenceMattermost = async (): Promise<void> => {
  const mm = client();
  const me = await mm.me();
  console.log(`PRESENCE_READY mattermost ${me.username}`);
  await every(1, async () => {
    await mm.setStatus(me.id, "online");
    console.log("PRESENCE mattermost online");
  });
};

export const inboundMattermost = async (cli: Cli, minutes: number): Promise<void> => {
  const mm = client();
  const ownerId = id(
    env("DORI_MATTERMOST_OWNER_ID") ?? die("DORI_MATTERMOST_OWNER_ID is not set"),
    "DORI_MATTERMOST_OWNER_ID",
  );
  const me = await mm.me();
  const store = fileMmInboundStore(join(cli.config.stateDir, "mattermost-inbound.json"));
  const told = new Set<string>();
  const warn = (message: string) => {
    if (!told.has(message)) console.log(`WARN ${message}`.slice(0, 300));
    told.add(message);
  };
  console.log(`INBOUND_READY mattermost owner=${ownerId} self=${me.id}`);
  await every(minutes, async () => {
    await pollMattermostInbound(
      mm,
      store,
      { ownerId, selfId: me.id, ignore: list("DORI_MATTERMOST_IGNORE"), now: () => realClock.now(), warn },
      (i) => console.log(formatMattermostInbound(i)),
    );
  });
};

/**
 * Mattermost threads have no name, so the thread's state lives on its status line: the root when the Dori posted it,
 * else the Dori's first reply in the thread, else a new reply. `done` is the archive mark; `working` reopens it.
 */
export const threadMattermost = async ({ positionals, opt }: Cli): Promise<void> => {
  const ref = positionals[1] ?? die("thread mattermost needs a thread mattermost:<channel>:<root>");
  const t = allowed(parseThreadRef(ref) ?? die(`not a Mattermost thread reference: ${ref}`));
  const status = opt("status") ?? die(`--status is required (${THREAD_STATES.join("|")})`);
  if (!(THREAD_STATES as readonly string[]).includes(status)) die(`--status must be ${THREAD_STATES.join(", ")}`);
  const state = status as ThreadState;
  const note = opt("note");
  const mm = client();
  const me = await mm.me();
  const mine = (await mm.thread(t.rootId)).find((p) => p.user_id === me.id && p.type === "");
  const line = mine
    ? await mm.edit(mine.id, withThreadState(mine.message, state))
    : await mm.post(t, withThreadState(note ?? "", state).trim());
  if (mine && note) await mm.post(t, note);
  console.log(`THREAD mattermost ${ref} ${state} status=${line.id}`);
};

export const downloadMattermost = async ({ positionals, opt, config }: Cli): Promise<void> => {
  const fileId = id(positionals[1] ?? die("download mattermost needs a file id"), "file id");
  const dir = opt("to") ?? join(config.stateDir, "files");
  const file = await client().download(fileId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${fileId}-${basename(file.name)}`);
  await Bun.write(path, file.bytes);
  console.log(`FILE ${path}`);
};
