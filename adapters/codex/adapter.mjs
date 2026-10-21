/** Third-party Codex bridge: only talks to upstream's documented work-status API. */
import {
  mkdirSync,
  readdirSync,
  lstatSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const priority = {
  waiting: 60,
  error: 50,
  working: 40,
  thinking: 30,
  result: 25,
  success: 20,
};
export function stateFor(event) {
  switch (event.hook_event_name) {
    case "UserPromptSubmit":
    case "PostCompact":
      return "thinking";
    case "PreToolUse":
      return /request_user_input|ask_user_question/.test(event.tool_name || "")
        ? "waiting"
        : "working";
    case "PermissionRequest":
      return "waiting";
    case "PostToolUse":
    case "PreCompact":
      return "result";
    case "Stop":
      return event.stop_hook_active ? "result" : "success";
    case "Interrupt":
    case "SessionEnd":
      return null;
    default:
      return undefined;
  }
}
export function createAggregator() {
  const sessions = new Map();
  let seq = 0;
  return {
    accept(event, now = Date.now()) {
      if (
        !event ||
        typeof event.session_id !== "string" ||
        !event.session_id ||
        event.session_id.length > 256 ||
        typeof event.hook_event_name !== "string" ||
        !Number.isFinite(event.created) ||
        now - event.created > 120_000 ||
        event.created - now > 10_000 ||
        (event.tool_name !== undefined &&
          typeof event.tool_name !== "string") ||
        (event.stop_hook_active !== undefined &&
          typeof event.stop_hook_active !== "boolean")
      )
        return;
      const state = stateFor(event);
      if (state === undefined) return;
      if (state === null) sessions.delete(event.session_id);
      else
        sessions.set(event.session_id, {
          state,
          seq: ++seq,
          expires:
            now +
            (state === "success" || state === "error" ? 10_000 : 30 * 60_000),
        });
    },
    snapshot(now = Date.now()) {
      let best;
      for (const [id, item] of sessions) {
        if (item.expires <= now) {
          sessions.delete(id);
          continue;
        }
        if (
          !best ||
          priority[item.state] > priority[best.state] ||
          (priority[item.state] === priority[best.state] && item.seq > best.seq)
        )
          best = item;
      }
      return best?.state ?? null;
    },
  };
}
export async function writeStatus(runtimeFile, state, fetcher = fetch) {
  const runtime = JSON.parse(readFileSync(runtimeFile, "utf8"));
  if (
    runtime.name !== "dsh-pet-standalone" ||
    !Number.isInteger(runtime.port) ||
    runtime.port < 1 ||
    runtime.port > 65535 ||
    typeof runtime.token !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(runtime.token)
  )
    throw Error("Invalid local runtime manifest");
  if (state !== null && !Object.hasOwn(priority, state))
    throw Error("Invalid state");
  const response = await fetcher(
    `http://127.0.0.1:${runtime.port}/dsh-pet-7340/work-status`,
    {
      method: state === null ? "DELETE" : "POST",
      redirect: "error",
      signal: AbortSignal.timeout(2000),
      headers: {
        "x-dsh-pet-token": runtime.token,
        "content-type": "application/json",
      },
      ...(state === null
        ? {}
        : { body: JSON.stringify({ state, task: null }) }),
    },
  );
  if (!response.ok) throw Error("Work-status API unavailable");
  // Consume the small response so repeated updates do not retain network resources.
  await response.arrayBuffer();
}
export function acquireQueue(directory) {
  const lock = join(directory, ".adapter.pid");
  try {
    const pid = Number(readFileSync(lock, "utf8"));
    if (!Number.isInteger(pid) || pid <= 0) throw Error("Invalid adapter lock");
    let alive = true;
    try {
      process.kill(pid, 0);
    } catch (e) {
      if (e.code === "ESRCH") alive = false;
      else throw e;
    }
    if (alive) throw Error("An adapter already owns this queue");
    unlinkSync(lock);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
  }
  writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  return () => {
    try {
      if (readFileSync(lock, "utf8") === String(process.pid)) unlinkSync(lock);
    } catch {}
  };
}
export async function serve({
  directory,
  runtimeFile,
  stopped = () => false,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
}) {
  if (!isAbsolute(directory) || !isAbsolute(runtimeFile))
    throw Error("Use absolute queue and runtime paths");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const release = acquireQueue(directory);
  const aggregate = createAggregator();
  let sent;
  let runtimeIdentity;
  let connected;
  const status = (ok) => {
    if (connected !== ok) {
      connected = ok;
      try {
        writeFileSync(
          join(directory, "adapter-status.json"),
          JSON.stringify({ connected: ok, at: Date.now() }),
          { mode: 0o600 },
        );
      } catch {}
    }
  };
  try {
    while (!stopped()) {
      let names = [];
      try {
        names = readdirSync(directory);
      } catch {}
      for (const name of names
        .filter((n) => /^\d{13}-[a-f0-9-]{36}\.json$/.test(n))
        .sort()
        .slice(0, 100)) {
        const file = join(directory, name);
        try {
          const stat = lstatSync(file);
          if (stat.isFile() && stat.size <= 4096)
            aggregate.accept(JSON.parse(readFileSync(file, "utf8")));
        } catch {
        } finally {
          try {
            unlinkSync(file);
          } catch {}
        }
      }
      const state = aggregate.snapshot();
      try {
        // A restarted upstream service has a new capability; refresh even if state did not change.
        const identity = readFileSync(runtimeFile, "utf8");
        if (state !== sent || identity !== runtimeIdentity) {
          await writeStatus(runtimeFile, state);
          sent = state;
          runtimeIdentity = identity;
          status(true, state);
        }
      } catch {
        status(false, state);
        sent =
          undefined; /* Retry locally; never log the runtime capability or raw errors. */
      }
      await sleep(200);
    }
  } finally {
    // This adapter must be the sole writer of upstream's shared external `api` slot.
    try {
      await writeStatus(runtimeFile, null);
    } catch {}
    release();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const [directory, runtimeFile] = process.argv.slice(2);
  let stopped = false;
  process.on("SIGINT", () => {
    stopped = true;
  });
  process.on("SIGTERM", () => {
    stopped = true;
  });
  serve({ directory, runtimeFile, stopped: () => stopped }).catch(() => {
    console.error(
      "Codex adapter failed: check absolute paths, runtime file and queue ownership.",
    );
    process.exitCode = 1;
  });
}
