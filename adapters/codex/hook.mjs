/** Optional Codex command hook. No stdout, model requests, auto-start or config edits. */
import { mkdirSync, writeFileSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const supported = new Set([
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "PermissionRequest",
  "PreCompact",
  "PostCompact",
  "Stop",
  "Interrupt",
  "SessionEnd",
]);
export function smallCodexEvent(raw, now = Date.now()) {
  if (
    !raw ||
    !supported.has(raw.hook_event_name) ||
    typeof raw.session_id !== "string" ||
    !raw.session_id ||
    raw.session_id.length > 256
  )
    return null;
  const event = {
    hook_event_name: raw.hook_event_name,
    session_id: raw.session_id,
    created: now,
  };
  if (typeof raw.tool_name === "string")
    event.tool_name = raw.tool_name.slice(0, 256);
  if (typeof raw.stop_hook_active === "boolean")
    event.stop_hook_active = raw.stop_hook_active;
  return event;
}
export async function run(input = process.stdin, directory = process.argv[2]) {
  if (
    process.env.CODEX_PET_INTERNAL === "1" ||
    !directory ||
    !isAbsolute(directory)
  )
    return;
  let text = "";
  for await (const chunk of input) {
    text += chunk;
    if (Buffer.byteLength(text) > 2 * 1024 * 1024) return;
  }
  const event = smallCodexEvent(JSON.parse(text));
  if (!event) return;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, `${event.created}-${randomUUID()}`);
  writeFileSync(target + ".tmp", JSON.stringify(event), {
    mode: 0o600,
    flag: "wx",
  });
  renameSync(target + ".tmp", target + ".json");
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  run().catch(() => {}); // A companion failure must not block the user's Codex turn.
}
