import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { run, smallCodexEvent } from '../codex-hook.mjs';

test('Codex hook payload allowlist drops prompts, tool input/output and arbitrary fields', () => {
  assert.deepEqual(
    smallCodexEvent(
      {
        hook_event_name: 'PreToolUse',
        session_id: 's',
        tool_name: 'Bash',
        stop_hook_active: false,
        prompt: 'private',
        tool_input: 'secret',
        tool_response: 'secret',
        extra: 'private',
      },
      42,
    ),
    { hook_event_name: 'PreToolUse', session_id: 's', created: 42, tool_name: 'Bash', stop_hook_active: false },
  );
  assert.equal(smallCodexEvent({ hook_event_name: 'unsupported', session_id: 's' }), null);
  assert.equal(smallCodexEvent({ hook_event_name: 'Stop', session_id: '' }), null);
});
test('hook writer atomically produces a small event in explicit queue', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-codex-hook-'));
  try {
    await run(Readable.from([JSON.stringify({ hook_event_name: 'Stop', session_id: 's', prompt: 'secret' })]), dir);
    const files = readdirSync(dir);
    assert.equal(files.length, 1);
    assert.match(files[0], /^\d{13}-[a-f0-9-]{36}\.json$/);
    assert.doesNotMatch(readFileSync(join(dir, files[0]), 'utf8'), /prompt|secret/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
test('oversized input and internal pet processes do not queue events', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-codex-hook-'));
  const old = process.env.CODEX_PET_INTERNAL;
  try {
    await run(Readable.from(['x'.repeat(2 * 1024 * 1024 + 1)]), dir);
    process.env.CODEX_PET_INTERNAL = '1';
    await run(Readable.from(['{"hook_event_name":"Stop","session_id":"s"}']), dir);
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    if (old === undefined) delete process.env.CODEX_PET_INTERNAL;
    else process.env.CODEX_PET_INTERNAL = old;
    rmSync(dir, { recursive: true });
  }
});
test('command hook fails open without stdout/stderr on malformed JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pet-codex-hook-'));
  try {
    const r = spawnSync(process.execPath, [fileURLToPath(new URL('../codex-hook.mjs', import.meta.url)), dir], {
      input: '{broken',
      encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, '');
    assert.equal(r.stderr, '');
    assert.deepEqual(readdirSync(dir), []);
  } finally {
    rmSync(dir, { recursive: true });
  }
});
