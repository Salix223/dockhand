/**
 * Git-sync notification digest - NO db/docker imports, so it unit-tests under the bun
 * runner. A scheduled or webhook-driven sync fires one result per stack, often dozens in the
 * same second. The collector holds them per environment and sends one message per event
 * type instead, so a cycle costs at most three mails per environment.
 *
 * Messages stay on the existing git_sync_* events: channel subscriptions are unchanged.
 */

export type GitSyncEvent = 'git_sync_success' | 'git_sync_failed' | 'git_sync_skipped';

export interface GitSyncEntry {
	event: GitSyncEvent;
	stackName: string;
	error?: string;
}

export interface GitSyncMessage {
	event: GitSyncEvent;
	title: string;
	message: string;
	type: 'info' | 'success' | 'error';
}

const MAX_ERROR_LENGTH = 200;

/** Failed first: it is the part that needs attention. */
const EVENT_ORDER: GitSyncEvent[] = ['git_sync_failed', 'git_sync_success', 'git_sync_skipped'];

function singleLine(error: string | undefined): string {
	const text = (error || 'unknown error').replace(/\s+/g, ' ').trim();
	return text.length > MAX_ERROR_LENGTH ? `${text.slice(0, MAX_ERROR_LENGTH - 1)}…` : text;
}

/** The message for one stack: what an unbatched sync sends. */
export function formatGitSyncEntry(entry: GitSyncEntry): GitSyncMessage {
	const { event, stackName } = entry;
	if (event === 'git_sync_skipped') {
		return { event, title: 'Git sync skipped', message: `Stack "${stackName}" sync skipped: no changes detected`, type: 'info' };
	}
	if (event === 'git_sync_success') {
		return { event, title: 'Git stack deployed', message: `Stack "${stackName}" was synced and deployed successfully`, type: 'success' };
	}
	return { event, title: 'Git sync failed', message: `Stack "${stackName}" sync failed: ${entry.error || 'unknown error'}`, type: 'error' };
}

/**
 * One message for all entries of a single event. A lone entry keeps its per-stack text;
 * several are listed by name (the later result wins when a stack appears twice).
 */
export function formatGitSyncDigest(entries: GitSyncEntry[]): GitSyncMessage {
	const byStack = new Map<string, GitSyncEntry>();
	for (const entry of entries) byStack.set(entry.stackName, entry);
	const unique = [...byStack.values()].sort((a, b) => a.stackName.localeCompare(b.stackName));
	if (unique.length === 1) return formatGitSyncEntry(unique[0]);

	const n = unique.length;
	const event = unique[0].event;
	const list = (line: (e: GitSyncEntry) => string) => unique.map((e) => `- ${line(e)}`).join('\n');

	if (event === 'git_sync_skipped') {
		return { event, title: `Git sync skipped: ${n} stacks`, message: `${n} stacks synced with no changes detected:\n${list((e) => e.stackName)}`, type: 'info' };
	}
	if (event === 'git_sync_success') {
		return { event, title: `Git stacks deployed: ${n}`, message: `${n} stacks were synced and deployed successfully:\n${list((e) => e.stackName)}`, type: 'success' };
	}
	return { event, title: `Git sync failed: ${n} stacks`, message: `${n} stacks failed to sync or deploy:\n${list((e) => `${e.stackName}: ${singleLine(e.error)}`)}`, type: 'error' };
}

export interface GitSyncDigestOptions {
	/** Delivers one message for an environment (null = no environment). Errors are swallowed. */
	send: (envId: number | null, message: GitSyncMessage) => Promise<void>;
	/** Flush an environment this long after its last entry. */
	quietMs: number;
	/** Flush an environment at the latest this long after its first entry. */
	maxMs: number;
	timers?: {
		set: (fn: () => void, ms: number) => unknown;
		clear: (handle: unknown) => void;
	};
}

interface Pending {
	entries: GitSyncEntry[];
	quiet: unknown;
	max: unknown;
}

const defaultTimers = {
	set: (fn: () => void, ms: number): unknown => {
		const handle = setTimeout(fn, ms);
		(handle as { unref?: () => void }).unref?.();
		return handle;
	},
	clear: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

export function createGitSyncDigest(options: GitSyncDigestOptions) {
	const timers = options.timers ?? defaultTimers;
	const pending = new Map<number | null, Pending>();
	// One send at a time across environments: a flush of several environments must not
	// open all their SMTP connections together.
	let chain: Promise<void> = Promise.resolve();

	function flushEnv(envId: number | null): void {
		const batch = pending.get(envId);
		if (!batch) return;
		pending.delete(envId);
		timers.clear(batch.quiet);
		timers.clear(batch.max);

		for (const event of EVENT_ORDER) {
			const entries = batch.entries.filter((e) => e.event === event);
			if (entries.length === 0) continue;
			const message = formatGitSyncDigest(entries);
			chain = chain.then(() => options.send(envId, message)).catch(() => {});
		}
	}

	return {
		add(envId: number | null, entry: GitSyncEntry): void {
			let batch = pending.get(envId);
			if (!batch) {
				batch = { entries: [], quiet: undefined, max: undefined };
				pending.set(envId, batch);
				batch.max = timers.set(() => flushEnv(envId), options.maxMs);
			}
			batch.entries.push(entry);
			if (batch.quiet !== undefined) timers.clear(batch.quiet);
			batch.quiet = timers.set(() => flushEnv(envId), options.quietMs);
		},

		/** Send everything held now; resolves once the sends finished. */
		async flush(): Promise<void> {
			for (const envId of [...pending.keys()]) flushEnv(envId);
			await chain;
		}
	};
}
