import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { run } from "../src/run.ts";
import { withState } from "./fakes.ts";

const cli = join(import.meta.dir, "../src/cli.ts");
const recorder = join(import.meta.dir, "record-fetch.ts");
const CH = "c".repeat(26);
const ROOT = "r".repeat(26);

const dori = async (dir: string, extraEnv: string[], args: string[]) => {
  const config = join(dir, "config.json");
  const log = join(dir, "fetch.jsonl");
  writeFileSync(config, JSON.stringify({ stateDir: dir, defaultCwd: dir, hooks: {} }));
  const r = await run(
    [
      "env",
      `DORI_CONFIG=${config}`,
      "DORI_MATTERMOST_URL=https://mm.example",
      "DORI_MATTERMOST_TOKEN=tok",
      `DORI_TEST_FETCH_LOG=${log}`,
      ...extraEnv,
      process.execPath,
      "--preload",
      recorder,
      cli,
      ...args,
    ],
    { timeoutMs: 20_000 },
  );
  const requests = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { ...r, requests };
};

test("send mattermost refuses a blocked channel or thread root before anything is sent", async () => {
  const state = withState();
  try {
    for (const blocked of [CH, ROOT]) {
      const r = await dori(
        state.dir,
        [`DORI_MATTERMOST_BLOCKED=other,${blocked}`],
        ["send", "mattermost", "--thread", `mattermost:${CH}:${ROOT}`, "--text", "hello"],
      );
      expect(r.code).toBe(3);
      expect(r.err).toContain("DORI_MATTERMOST_BLOCKED");
      expect(r.requests).toEqual([]);
    }
  } finally {
    state.done();
  }
});

test("send mattermost refuses a target that is not a Mattermost id, and an empty --thread, before any request", async () => {
  const state = withState();
  try {
    for (const flags of [["--to", "general"], ["--to", CH, "--thread", "123.456"], ["--to", CH, "--thread", ""], []]) {
      const r = await dori(state.dir, [], ["send", "mattermost", "--text", "hello", ...flags]);
      expect(r.code).toBe(1);
      expect(r.requests).toEqual([]);
    }
  } finally {
    state.done();
  }
});

test("a thread reply goes to the channel with its root, and typing/thread/download refuse other platforms", async () => {
  const state = withState();
  try {
    const r = await dori(state.dir, [], ["send", "mattermost", "--thread", `mattermost:${CH}:${ROOT}`, "--text", "hi"]);
    expect(r.code).toBe(0);
    const sent = JSON.parse(r.requests[0] ?? "{}") as { url: string; body: Record<string, unknown> };
    expect(sent.url).toBe("https://mm.example/api/v4/posts");
    expect(sent.body).toEqual({ channel_id: CH, message: "hi", root_id: ROOT });
    for (const command of ["typing", "thread", "download"]) {
      const other = await dori(state.dir, [], [command, "slack"]);
      expect(other.code).toBe(1);
      expect(other.err).toContain("supports mattermost only");
    }
  } finally {
    state.done();
  }
});
