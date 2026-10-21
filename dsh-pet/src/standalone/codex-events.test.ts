import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync, readdirSync, rmSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startCodexEvents, translateCodexEvent } from './codex-events.ts';
import { createStandaloneContext } from './context.ts';

const event = (hook: string, extra = {}) => ({ hook_event_name: hook, session_id: 's', created: Date.now(), ...extra });
const name = (id: number) => `1792500000000-00000000-0000-0000-0000-${String(id).padStart(12, '0')}.json`;
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'pet-codex-events-'));
  let now = Date.now();
  const seen: Array<{ session: { id: string }; event: { type: string; data: Record<string, unknown>; seq: number } }> =
    [];
  const bridge = startCodexEvents({
    directory: dir,
    now: () => now,
    emit: (session, event) => {
      seen.push({ session, event });
    },
  });
  return {
    dir,
    seen,
    bridge,
    advance: (ms: number) => {
      now += ms;
    },
    cleanup: () => {
      bridge.dispose();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
test('Codex mapping preserves waiting, completed, continued and interrupted states', () => {
  assert.equal(translateCodexEvent(event('UserPromptSubmit'))?.type, 'turn/start');
  assert.equal(
    translateCodexEvent(event('PreToolUse', { tool_name: 'functions.request_user_input' }))?.data.name,
    'ask_user_question',
  );
  assert.equal(translateCodexEvent(event('PermissionRequest'))?.type, 'approval/asked');
  assert.equal(translateCodexEvent(event('Stop', { stop_hook_active: true }))?.type, 'tool/result');
  assert.deepEqual(translateCodexEvent(event('Stop'))?.data, { reason: { kind: 'completed' } });
  assert.deepEqual(translateCodexEvent(event('Interrupt'))?.data, { reason: { kind: 'aborted' } });
  assert.equal(translateCodexEvent(event('unsupported')), null);
});
test('queue is consumed once with namespaced sessions and monotonic sequence', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, name(1)), JSON.stringify(event('UserPromptSubmit')));
    writeFileSync(join(f.dir, name(2)), JSON.stringify(event('Stop')));
    f.bridge.poll();
    f.bridge.poll();
    assert.deepEqual(
      f.seen.map((x) => [x.session.id, x.event.type, x.event.seq]),
      [
        ['codex:s', 'turn/start', 1],
        ['codex:s', 'turn/end', 2],
      ],
    );
    assert.deepEqual(readdirSync(f.dir), []);
  } finally {
    f.cleanup();
  }
});
test('stale, future, malformed and oversized events are discarded; unrelated files preserved', () => {
  const f = fixture();
  try {
    const events = [
      event('Stop', { created: Date.now() - 130_000 }),
      event('Stop', { created: Date.now() + 60_000 }),
      event('Stop', { tool_name: {} }),
      event('Stop', { stop_hook_active: 'false' }),
    ];
    events.forEach((e, i) => writeFileSync(join(f.dir, name(i)), JSON.stringify(e)));
    writeFileSync(join(f.dir, name(10)), '{broken');
    writeFileSync(join(f.dir, name(11)), 'x'.repeat(5000));
    writeFileSync(join(f.dir, 'user.json'), 'keep');
    f.bridge.poll();
    assert.equal(f.seen.length, 0);
    assert.deepEqual(readdirSync(f.dir), ['user.json']);
  } finally {
    f.cleanup();
  }
});
test('dead sessions expire independently and dispose stops delivery', () => {
  const f = fixture();
  try {
    writeFileSync(join(f.dir, name(1)), JSON.stringify(event('UserPromptSubmit')));
    f.bridge.poll();
    f.advance(30 * 60_000 + 1);
    f.bridge.poll();
    assert.equal(f.seen.length, 2);
    assert.deepEqual(f.seen[1]?.event.data, { reason: { kind: 'aborted' } });
    f.bridge.dispose();
    writeFileSync(join(f.dir, name(2)), JSON.stringify(event('Stop')));
    f.bridge.poll();
    assert.equal(f.seen.length, 2);
  } finally {
    f.cleanup();
  }
});
test('symlink entries cannot read or remove an external target', { skip: process.platform === 'win32' }, () => {
  const f = fixture();
  try {
    const target = join(f.dir, 'external.json');
    writeFileSync(target, JSON.stringify(event('Stop')));
    symlinkSync(target, join(f.dir, name(1)));
    f.bridge.poll();
    assert.ok(existsSync(target));
    assert.equal(f.seen.length, 0);
  } finally {
    f.cleanup();
  }
});
test('queue path must be absolute', () => {
  assert.throws(() => startCodexEvents({ directory: 'relative', emit: () => {} }), /absolute/);
});
test('standalone external events are opt-in; effect disposal releases subscriptions', async () => {
  const events = new EventEmitter();
  const logger = { info() {}, warn() {}, error() {}, debug() {} };
  const c = createStandaloneContext({ port: 31340, logger, events });
  let calls = 0;
  const effect = c.ctx.effect as (fn: () => unknown) => void;
  const on = c.ctx.on as (name: string, listener: (...args: unknown[]) => void) => () => void;
  effect(() =>
    on('session/event', () => {
      calls++;
    }),
  );
  events.emit('session/event', {}, {});
  assert.equal(calls, 1);
  await c.dispose();
  events.emit('session/event', {}, {});
  assert.equal(calls, 1);
  const plain = createStandaloneContext({ port: 31340, logger });
  assert.equal(typeof (plain.ctx.on as () => unknown)(), 'function');
  await plain.dispose();
});
