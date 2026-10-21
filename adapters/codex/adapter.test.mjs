import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import {
  createAggregator,
  stateFor,
  writeStatus,
  acquireQueue,
  serve,
} from "./adapter.mjs";

const e = (hook, session = "s", extra = {}) => ({
  hook_event_name: hook,
  session_id: session,
  created: 1792500000000,
  ...extra,
});
test("hook mapping distinguishes continued stop and questions", () => {
  assert.equal(stateFor(e("Stop")), "success");
  assert.equal(stateFor(e("Stop", "s", { stop_hook_active: true })), "result");
  assert.equal(
    stateFor(
      e("PreToolUse", "s", { tool_name: "functions.request_user_input" }),
    ),
    "waiting",
  );
  assert.equal(stateFor(e("Interrupt")), null);
});
test("adapter aggregates parallel sessions before writing upstream single slot", () => {
  const a = createAggregator(),
    now = 1792500000000;
  a.accept(e("PermissionRequest", "a"), now);
  a.accept(e("Stop", "b"), now);
  assert.equal(a.snapshot(now), "waiting");
  a.accept(e("Interrupt", "a"), now);
  assert.equal(a.snapshot(now), "success");
  assert.equal(a.snapshot(now + 10001), null);
});
test("active sessions expire; bad timestamps and types cannot set state", () => {
  const a = createAggregator(),
    now = 1792500000000;
  a.accept(e("PreToolUse"), now);
  assert.equal(a.snapshot(now), "working");
  assert.equal(a.snapshot(now + 30 * 60000 + 1), null);
  for (const value of [
    e("Stop", "s", { created: 0 }),
    e("Stop", "s", { created: now + 60000 }),
    e("Stop", "s", { stop_hook_active: "false" }),
    null,
  ])
    a.accept(value, now);
  assert.equal(a.snapshot(now), null);
});
test("queue duplicate lock cannot start a second adapter or remove first lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-external-"));
  try {
    const release = acquireQueue(dir);
    assert.throws(() => acquireQueue(dir), /already/);
    assert.ok(existsSync(join(dir, ".adapter.pid")));
    release();
    assert.equal(existsSync(join(dir, ".adapter.pid")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("work-status uses only loopback, fixed API, and redacted capability header", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-external-"));
  const manifest = join(dir, "runtime.json");
  const raw = {
    name: "dsh-pet-standalone",
    port: 31340,
    token: "a".repeat(43),
    settingsUrl: "https://untrusted.example/",
  };
  writeFileSync(manifest, JSON.stringify(raw));
  const calls = [];
  const mock = async (url, options) => {
    calls.push({ url, options });
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(0) };
  };
  try {
    await writeStatus(manifest, "working", mock);
    await writeStatus(manifest, null, mock);
    assert.equal(
      calls[0].url,
      "http://127.0.0.1:31340/dsh-pet-7340/work-status",
    );
    assert.equal(calls[0].options.redirect, "error");
    assert.deepEqual(JSON.parse(calls[0].options.body), {
      state: "working",
      task: null,
    });
    assert.equal(calls[1].options.method, "DELETE");
    await assert.rejects(writeStatus(manifest, "invalid", mock));
    writeFileSync(manifest, JSON.stringify({ ...raw, port: 0 }));
    await assert.rejects(writeStatus(manifest, "working", mock));
    assert.equal(calls.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
test("real loopback request succeeds; failures do not report a successful write", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-external-"));
  const manifest = join(dir, "runtime.json");
  let received;
  const server = createServer((req, res) => {
    received = {
      url: req.url,
      method: req.method,
      token: req.headers["x-dsh-pet-token"],
    };
    res.writeHead(204);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    writeFileSync(
      manifest,
      JSON.stringify({
        name: "dsh-pet-standalone",
        port: server.address().port,
        token: "b".repeat(43),
      }),
    );
    await writeStatus(manifest, null);
    assert.equal(received.method, "DELETE");
    assert.equal(received.token, "b".repeat(43));
    await assert.rejects(
      writeStatus(manifest, "working", async () => ({ ok: false })),
      /unavailable/,
    );
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
test("worker consumes queue and explicitly clears API on shutdown", async () => {
  const dir = mkdtempSync(join(tmpdir(), "codex-external-"));
  const runtimeFile = join(dir, "runtime.json");
  const calls = [];
  let stopped = false;
  const server = createServer((req, res) => {
    calls.push(req.method);
    res.writeHead(204);
    res.end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    writeFileSync(
      runtimeFile,
      JSON.stringify({
        name: "dsh-pet-standalone",
        port: server.address().port,
        token: "c".repeat(43),
      }),
    );
    const now = Date.now();
    writeFileSync(
      join(dir, `${now}-00000000-0000-0000-0000-000000000000.json`),
      JSON.stringify({ ...e("UserPromptSubmit"), created: now }),
    );
    await serve({
      directory: dir,
      runtimeFile,
      stopped: () => stopped,
      sleep: async () => {
        stopped = true;
      },
    });
    assert.deepEqual(calls, ["POST", "DELETE"]);
    assert.equal(existsSync(join(dir, ".adapter.pid")), false);
  } finally {
    await new Promise((r) => server.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
});
