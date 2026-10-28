// @ts-expect-error -- bun:test is a runtime built-in with no types installed
import { describe, expect, test } from 'bun:test';
import {
	createGitSyncDigest,
	formatGitSyncDigest,
	formatGitSyncEntry,
	type GitSyncEntry,
	type GitSyncMessage
} from '../src/lib/server/notifications/git-sync-digest-core';

const skipped = (stackName: string): GitSyncEntry => ({ event: 'git_sync_skipped', stackName });
const ok = (stackName: string): GitSyncEntry => ({ event: 'git_sync_success', stackName });
const failed = (stackName: string, error?: string): GitSyncEntry => ({ event: 'git_sync_failed', stackName, error });

describe('formatGitSyncDigest', () => {
	test('a lone entry keeps the per-stack text', () => {
		expect(formatGitSyncDigest([skipped('web')])).toEqual(formatGitSyncEntry(skipped('web')));
		expect(formatGitSyncEntry(skipped('web')).message).toBe('Stack "web" sync skipped: no changes detected');
		expect(formatGitSyncEntry(failed('web', 'boom')).message).toBe('Stack "web" sync failed: boom');
	});

	test('several entries are listed by sorted name with a count in the title', () => {
		const msg = formatGitSyncDigest([skipped('b'), skipped('a'), skipped('c')]);
		expect(msg.event).toBe('git_sync_skipped');
		expect(msg.title).toBe('Git sync skipped: 3 stacks');
		expect(msg.message).toBe('3 stacks synced with no changes detected:\n- a\n- b\n- c');
		expect(msg.type).toBe('info');
	});

	test('failures list the error, collapsed to one line and truncated', () => {
		const long = 'x'.repeat(500);
		const msg = formatGitSyncDigest([failed('a', 'line one\nline two'), failed('b', long), failed('c')]);
		expect(msg.type).toBe('error');
		const lines = msg.message.split('\n');
		expect(lines[1]).toBe('- a: line one line two');
		expect(lines[2].length).toBeLessThan(215);
		expect(lines[2].endsWith('…')).toBe(true);
		expect(lines[3]).toBe('- c: unknown error');
	});

	test('a stack seen twice counts once, the later result wins', () => {
		const msg = formatGitSyncDigest([failed('a', 'first'), failed('a', 'second'), failed('b', 'x')]);
		expect(msg.title).toBe('Git sync failed: 2 stacks');
		expect(msg.message).toContain('- a: second');
		expect(msg.message).not.toContain('first');
	});

	test('a stack seen twice and nothing else degrades to the lone-entry text', () => {
		expect(formatGitSyncDigest([ok('a'), ok('a')])).toEqual(formatGitSyncEntry(ok('a')));
	});
});

/** Fake timers: advance() fires due callbacks in time order. */
function fakeClock() {
	let now = 0;
	let nextId = 1;
	const tasks = new Map<number, { at: number; fn: () => void }>();
	return {
		timers: {
			set: (fn: () => void, ms: number) => {
				const id = nextId++;
				tasks.set(id, { at: now + ms, fn });
				return id;
			},
			clear: (handle: unknown) => {
				tasks.delete(handle as number);
			}
		},
		async advance(ms: number) {
			const target = now + ms;
			for (;;) {
				const due = [...tasks.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
				if (!due) break;
				tasks.delete(due[0]);
				now = due[1].at;
				due[1].fn();
			}
			now = target;
			await new Promise((r) => setTimeout(r, 0));
		},
		pending: () => tasks.size
	};
}

function setup(send?: (envId: number | null, m: GitSyncMessage) => Promise<void>) {
	const sent: { envId: number | null; msg: GitSyncMessage }[] = [];
	const clock = fakeClock();
	const digest = createGitSyncDigest({
		quietMs: 30_000,
		maxMs: 300_000,
		timers: clock.timers,
		send: send ?? (async (envId, msg) => { sent.push({ envId, msg }); })
	});
	return { digest, clock, sent };
}

describe('createGitSyncDigest', () => {
	test('nothing is sent before the quiet window ends', async () => {
		const { digest, clock, sent } = setup();
		digest.add(1, skipped('a'));
		await clock.advance(29_000);
		expect(sent).toHaveLength(0);
		await clock.advance(1_000);
		expect(sent).toHaveLength(1);
	});

	test('a burst becomes one message per event type, failed first', async () => {
		const { digest, clock, sent } = setup();
		for (let i = 0; i < 30; i++) digest.add(1, skipped(`s${i}`));
		digest.add(1, ok('deployed'));
		digest.add(1, failed('broken', 'nope'));
		await clock.advance(30_000);
		expect(sent.map((s) => s.msg.event)).toEqual(['git_sync_failed', 'git_sync_success', 'git_sync_skipped']);
		expect(sent[2].msg.title).toBe('Git sync skipped: 30 stacks');
		expect(sent[1].msg).toEqual(formatGitSyncEntry(ok('deployed')));
	});

	test('each new entry restarts the quiet window', async () => {
		const { digest, clock, sent } = setup();
		digest.add(1, skipped('a'));
		await clock.advance(20_000);
		digest.add(1, skipped('b'));
		await clock.advance(20_000);
		expect(sent).toHaveLength(0);
		await clock.advance(10_000);
		expect(sent).toHaveLength(1);
		expect(sent[0].msg.title).toBe('Git sync skipped: 2 stacks');
	});

	test('the max window flushes even while entries keep arriving', async () => {
		const { digest, clock, sent } = setup();
		for (let t = 0; t < 300_000; t += 10_000) {
			digest.add(1, skipped(`s${t}`));
			await clock.advance(10_000);
		}
		expect(sent).toHaveLength(1);
		expect(clock.pending()).toBe(0);
	});

	test('environments are kept apart', async () => {
		const { digest, clock, sent } = setup();
		digest.add(1, skipped('a'));
		digest.add(2, skipped('b'));
		digest.add(null, skipped('c'));
		await clock.advance(30_000);
		expect(sent.map((s) => s.envId).sort()).toEqual([1, 2, null].sort());
		expect(sent.every((s) => s.msg.title === 'Git sync skipped')).toBe(true);
	});

	test('sends never overlap, across environments', async () => {
		let active = 0;
		let maxActive = 0;
		const { digest, clock } = setup(async () => {
			active++;
			maxActive = Math.max(maxActive, active);
			await new Promise((r) => setTimeout(r, 5));
			active--;
		});
		for (const env of [1, 2, 3]) digest.add(env, failed(`s${env}`, 'x'));
		await clock.advance(30_000);
		await digest.flush();
		expect(maxActive).toBe(1);
	});

	test('a failing send does not block later ones', async () => {
		let calls = 0;
		const { digest, clock } = setup(async () => {
			calls++;
			if (calls === 1) throw new Error('smtp down');
		});
		digest.add(1, failed('a', 'x'));
		digest.add(1, skipped('b'));
		await clock.advance(30_000);
		await digest.flush();
		expect(calls).toBe(2);
	});

	test('flush() sends what is held and cancels the timers', async () => {
		const { digest, clock, sent } = setup();
		digest.add(1, skipped('a'));
		digest.add(2, ok('b'));
		await digest.flush();
		expect(sent).toHaveLength(2);
		expect(clock.pending()).toBe(0);
		await clock.advance(600_000);
		expect(sent).toHaveLength(2);
	});
});
