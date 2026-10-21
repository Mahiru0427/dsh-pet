/** Opt-in, local Codex hook transport. No prompts, model calls or credential access. */
import { lstatSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export interface CodexHookEvent {
  hook_event_name: string;
  session_id: string;
  created: number;
  tool_name?: string;
  stop_hook_active?: boolean;
}
export interface PetSessionEvent {
  type: string;
  data: Record<string, unknown>;
}
export function translateCodexEvent(event: CodexHookEvent): PetSessionEvent | null {
  switch (event.hook_event_name) {
    case 'UserPromptSubmit':
    case 'PostCompact':
      return { type: 'turn/start', data: {} };
    case 'PreToolUse':
      return {
        type: 'tool/call',
        data: {
          name: /request_user_input|ask_user_question/.test(event.tool_name ?? '')
            ? 'ask_user_question'
            : event.tool_name,
        },
      };
    case 'PostToolUse':
    case 'PreCompact':
      return { type: 'tool/result', data: {} };
    case 'PermissionRequest':
      return { type: 'approval/asked', data: {} };
    case 'Stop':
      return event.stop_hook_active
        ? { type: 'tool/result', data: {} }
        : { type: 'turn/end', data: { reason: { kind: 'completed' } } };
    case 'Interrupt':
    case 'SessionEnd':
      return { type: 'turn/end', data: { reason: { kind: 'aborted' } } };
    default:
      return null;
  }
}

export function startCodexEvents(options: {
  directory: string;
  emit: (session: { id: string }, event: PetSessionEvent & { seq: number }) => void;
  now?: () => number;
  intervalMs?: number;
}): { poll: () => void; dispose: () => void } {
  if (!isAbsolute(options.directory)) throw new Error('DSH_PET_CODEX_EVENTS must be an absolute path');
  mkdirSync(options.directory, { recursive: true, mode: 0o700 });
  const now = options.now ?? Date.now;
  const sessions = new Map<string, number>();
  let seq = 0;
  let disposed = false;
  const poll = (): void => {
    if (disposed) return;
    let names: string[];
    try {
      names = readdirSync(options.directory);
    } catch {
      return;
    }
    for (const name of names
      .filter((n) => /^\d{13}-[a-f0-9-]{36}\.json$/.test(n))
      .sort()
      .slice(0, 100)) {
      const file = join(options.directory, name);
      try {
        const stat = lstatSync(file);
        if (!stat.isFile() || stat.size > 4096) continue;
        const event = JSON.parse(readFileSync(file, 'utf8')) as CodexHookEvent;
        if (
          typeof event?.session_id !== 'string' ||
          !event.session_id ||
          event.session_id.length > 256 ||
          typeof event.hook_event_name !== 'string' ||
          !Number.isFinite(event.created) ||
          now() - event.created > 120_000 ||
          event.created - now() > 10_000 ||
          (event.tool_name !== undefined && typeof event.tool_name !== 'string') ||
          (event.stop_hook_active !== undefined && typeof event.stop_hook_active !== 'boolean')
        )
          continue;
        const translated = translateCodexEvent(event);
        if (!translated) continue;
        options.emit({ id: `codex:${event.session_id}` }, { ...translated, seq: ++seq });
        if (translated.type === 'turn/end') sessions.delete(event.session_id);
        else sessions.set(event.session_id, now());
      } catch {
        /* A malformed or disappearing event cannot stop the pet. */
      } finally {
        try {
          unlinkSync(file);
        } catch {
          /* Do not retry broken entries forever. */
        }
      }
    }
    for (const [id, last] of sessions)
      if (now() - last > 30 * 60_000) {
        options.emit({ id: `codex:${id}` }, { type: 'turn/end', data: { reason: { kind: 'aborted' } }, seq: ++seq });
        sessions.delete(id);
      }
  };
  const timer = setInterval(poll, options.intervalMs ?? 200);
  timer.unref();
  return {
    poll,
    dispose: () => {
      disposed = true;
      clearInterval(timer);
      sessions.clear();
    },
  };
}
