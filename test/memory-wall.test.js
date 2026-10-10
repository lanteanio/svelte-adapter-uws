import { test } from 'vitest';
import v8 from 'node:v8';
import assert from 'node:assert/strict';

import {
	GROUP_LIST_EVERY,
	bindingCandidates,
	cgroupMemoryLimitCandidates,
	createMemoryWallReader,
	memoryWallRatio,
	parseCgroupMemoryLimit
} from '../src/runtime/utils/memory-wall.js';

const createReader = (deps) => createMemoryWallReader({
	heapStatistics: () => ({ heap_size_limit: 0 }),
	...deps
});

test('a limit file is parsed, and "unlimited" is no wall at all', () => {
	assert.equal(parseCgroupMemoryLimit('536870912\n'), 536870912);
	assert.equal(parseCgroupMemoryLimit('max'), null, 'the cgroup v2 spelling');
	// v1 reports unlimited as a page-rounded near-2^63 sentinel, not a word.
	assert.equal(parseCgroupMemoryLimit('9223372036854771712'), null);
	for (const junk of ['', ' ', 'abc', '-1', '0', '1.5', '0x10']) {
		assert.equal(parseCgroupMemoryLimit(junk), null, `unparseable: ${JSON.stringify(junk)}`);
	}
});

test('candidates cover the container default and the host-namespace shape', () => {
	// A private cgroup namespace presents the pod limit at the ROOT; a host
	// namespace puts it on the process's own group or an ancestor.
	const roots = cgroupMemoryLimitCandidates(null);
	assert.ok(roots.includes('/sys/fs/cgroup/memory.max'), 'v2 root');
	assert.ok(roots.includes('/sys/fs/cgroup/memory/memory.limit_in_bytes'), 'v1 root');

	const v2 = cgroupMemoryLimitCandidates('0::/kubepods/burstable/pod123/abc\n');
	assert.equal(v2[0], '/sys/fs/cgroup/kubepods/burstable/pod123/abc/memory.max',
		'the process own group comes first');
	assert.ok(v2.indexOf('/sys/fs/cgroup/kubepods/memory.max') > 0, 'then its ancestors');
	assert.ok(v2.indexOf('/sys/fs/cgroup/kubepods/burstable/pod123/memory.max')
		< v2.indexOf('/sys/fs/cgroup/kubepods/memory.max'), 'nearest first');

	const v1 = cgroupMemoryLimitCandidates('7:memory,cpu:/docker/deadbeef\n');
	assert.ok(v1.includes('/sys/fs/cgroup/memory/docker/deadbeef/memory.limit_in_bytes'));
	// A controller line that is not memory contributes nothing.
	const other = cgroupMemoryLimitCandidates('3:cpuset:/docker/deadbeef\n');
	assert.equal(other.length, 2, 'only the two roots');
});

test('a hierarchy outside the cgroup namespace contributes nothing, its root included', () => {
	// The kernel spells a group outside the reader's namespace with a leading
	// `..`. Nothing visible from inside is then an ancestor of the process.
	assert.deepEqual(cgroupMemoryLimitCandidates('0::/../sibling/x\n'),
		['/sys/fs/cgroup/memory/memory.limit_in_bytes'], 'no v2 candidate, not even the root');
	assert.deepEqual(cgroupMemoryLimitCandidates('4:memory:/../x\n0::/\n'),
		['/sys/fs/cgroup/memory.max'], 'no v1 candidate, not even the v1 root');
	assert.deepEqual(cgroupMemoryLimitCandidates('0::/../x\n0::/y\n'),
		['/sys/fs/cgroup/memory/memory.limit_in_bytes'], 'a later line does not reopen it');
	assert.equal(cgroupMemoryLimitCandidates('0::/..foo/x\n')[0], '/sys/fs/cgroup/..foo/x/memory.max',
		'a group whose name starts with dots is an ordinary group');
});

test('only the first line of each hierarchy counts, and the depth cap keeps the nearest groups', () => {
	// A real kernel writes one line per hierarchy; the bound has to hold for
	// any content, since every candidate is read every sample.
	const deep = Array.from({ length: 20 }, (_, i) => `g${i + 1}`).join('/');
	const list = cgroupMemoryLimitCandidates(`0::/${deep}\n0::/other/path\n`);
	const groups = list.filter((p) => p !== '/sys/fs/cgroup/memory.max' && p.endsWith('/memory.max'));
	assert.equal(groups.length, 16, 'MAX_CGROUP_DEPTH groups');
	assert.equal(groups[0], `/sys/fs/cgroup/${deep}/memory.max`, 'the own group first');
	assert.equal(groups[15], `/sys/fs/cgroup/${deep.split('/').slice(0, 5).join('/')}/memory.max`,
		'down to the fifth level: the nearest sixteen');
	assert.ok(!list.some((p) => p.includes('/other/')), 'a second unified line is ignored');
	assert.equal(list.length, 18, 'plus the two roots');
	const v1 = cgroupMemoryLimitCandidates('4:memory:/a\n5:memory:/b\n');
	assert.ok(v1.includes('/sys/fs/cgroup/memory/a/memory.limit_in_bytes'));
	assert.ok(!v1.some((p) => p.includes('/memory/b/')), 'a second memory line is ignored');
});

test('a cgroup v1 ancestor applies only in hierarchical mode', () => {
	const own = '/sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes';
	const parent = '/sys/fs/cgroup/memory/docker/memory.limit_in_bytes';
	const root = '/sys/fs/cgroup/memory/memory.limit_in_bytes';
	const candidates = cgroupMemoryLimitCandidates('4:memory:/docker/abc\n');
	assert.deepEqual(candidates, [own, parent, '/sys/fs/cgroup/memory.max', root]);
	const flagOf = (path) => path.replace(/memory\.limit_in_bytes$/, 'memory.use_hierarchy');
	/** @param {Record<string, string>} flags */
	const reading = (flags) => (path) => {
		if (path in flags) return flags[path];
		throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
	};
	assert.deepEqual(bindingCandidates(candidates, reading({ [flagOf(parent)]: '0\n', [flagOf(root)]: '1\n' })),
		[own, '/sys/fs/cgroup/memory.max', root], 'the non-hierarchical parent is dropped');
	assert.deepEqual(bindingCandidates(candidates, reading({ [flagOf(own)]: '0\n', [flagOf(parent)]: '1\n', [flagOf(root)]: '1\n' })),
		candidates, 'the own group applies whatever its flag');
	assert.deepEqual(bindingCandidates(candidates, reading({ [flagOf(parent)]: '0\n', [flagOf(root)]: '0\n' })),
		[own, '/sys/fs/cgroup/memory.max', root], 'and so does the v1 root, never checked');
	assert.deepEqual(bindingCandidates(candidates, reading({})), candidates, 'an unreadable flag keeps its group');
	assert.deepEqual(bindingCandidates(candidates, reading({ [flagOf(parent)]: 'garbage\n' })), candidates,
		'only an explicit 0 drops one');
});

test('the fold is the worst arm, and an unknown arm contributes nothing', () => {
	// Each wall is measured with its own numerator: heapUsed against the engine
	// ceiling, RESIDENT SET against the cgroup limit, because the OOM killer
	// charges the whole resident set and never the JS heap alone.
	assert.equal(memoryWallRatio({ heapUsed: 50, rss: 10, heapSizeLimit: 100, cgroupLimitBytes: 100 }), 0.5);
	assert.equal(memoryWallRatio({ heapUsed: 10, rss: 90, heapSizeLimit: 100, cgroupLimitBytes: 100 }), 0.9,
		'the container arm wins when it is nearer');
	assert.equal(memoryWallRatio({ heapUsed: 90, rss: 10, heapSizeLimit: 100, cgroupLimitBytes: null }), 0.9,
		'no container wall: the engine arm still reads');
	// No discoverable wall on either arm reads 0 - the signal degrades to
	// SILENCE, never to a fabricated alarm.
	assert.equal(memoryWallRatio({ heapUsed: 999, rss: 999, heapSizeLimit: null, cgroupLimitBytes: null }), 0);
	// Clamped: past the wall is still 1, not a number above it.
	assert.equal(memoryWallRatio({ heapUsed: 0, rss: 500, heapSizeLimit: null, cgroupLimitBytes: 100 }), 1);
});

test('the default reader measures the V8 allocation ceiling', () => {
	const limit = v8.getHeapStatistics().heap_size_limit;
	const reader = createMemoryWallReader({
		readFile() { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }
	});
	assert.equal(reader.ratio({ heapUsed: limit / 2, rss: 0 }), 0.5);
});

test('the container arm reads the discovered limit, and a value edit is tracked', () => {
	let limit = '1000';
	const reader = createReader({
		readFile: (path) => {
			if (path === '/proc/self/cgroup') return '0::/\n';
			if (path.endsWith('memory.max')) return limit;
			const e = new Error('nope'); /** @type {any} */ (e).code = 'ENOENT'; throw e;
		}
	});
	assert.equal(reader.ratio({ heapUsed: 0, rss: 500 }), 0.5);
	// Every sample re-reads the limit files, so a runtime edit of the VALUE is
	// seen.
	limit = '2000';
	assert.equal(reader.ratio({ heapUsed: 0, rss: 500 }), 0.25);
});

test('an engine ceiling still folds in where one is reported', () => {
	// An injected engine ceiling participates in the same worst-of fold.
	const reader = createReader({
		readFile: () => { const e = new Error('nope'); /** @type {any} */ (e).code = 'ENOENT'; throw e; },
		heapStatistics: () => ({ heap_size_limit: 1000 })
	});
	assert.equal(reader.ratio({ heapUsed: 700, rss: 0 }), 0.7);
});

const GiB = 2 ** 30;
const SELF = '/proc/self/cgroup';
const ROOT_V2 = '/sys/fs/cgroup/memory.max';
const ROOT_V1 = '/sys/fs/cgroup/memory/memory.limit_in_bytes';
const mem = (heapUsed, rss) => ({ heapUsed, rss });

/** @param {number} actual @param {number} expected @param {string} [message] */
function near(actual, expected, message) {
	assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? 'ratio'}: expected ${expected}, got ${actual}`);
}

/**
 * A cgroup filesystem the test edits between samples. `files` maps a path to
 * its content; a path absent from it reads ENOENT. `failing` maps a path, or
 * '*' for every path, to the error code its read throws.
 *
 * @param {Record<string, string>} files
 */
function cgroupFs(files) {
	/** @type {Map<string, string>} */
	const failing = new Map();
	/** @type {Map<string, number>} */
	const byPath = new Map();
	const fs = {
		files,
		failing,
		reads: 0,
		/** @param {string} path read attempts of one path, failed ones included */
		readsOf: (path) => byPath.get(path) ?? 0,
		/** @param {string} path */
		readFile(path) {
			fs.reads++;
			byPath.set(path, (byPath.get(path) ?? 0) + 1);
			const code = failing.get(path) ?? failing.get('*');
			if (code === undefined && path in files) return files[path];
			const error = new Error(`${code ?? 'ENOENT'}: ${path}`);
			/** @type {any} */ (error).code = code ?? 'ENOENT';
			throw error;
		}
	};
	return fs;
}

/**
 * Sample until the reader tries the group list again, and return that
 * sample's ratio: the list is read on a schedule, so a test of what happens
 * when it is hidden, absent or changed has to reach a read of it.
 *
 * @param {ReturnType<typeof createMemoryWallReader>} reader
 * @param {ReturnType<typeof cgroupFs>} fs
 * @param {number} rss
 */
function atNextListRead(reader, fs, rss) {
	const before = fs.readsOf(SELF);
	for (let sample = 0; sample <= GROUP_LIST_EVERY; sample++) {
		const ratio = reader.ratio(mem(1, rss));
		if (fs.readsOf(SELF) > before) return ratio;
	}
	assert.fail('the group list was not read within GROUP_LIST_EVERY samples');
}

// - When the reads stop ---------------------------------------------------------

test('a confirmed absence on a fresh reader stops the reads for good', () => {
	const fs = cgroupFs({});
	const reader = createReader({ readFile: fs.readFile });
	reader.ratio(mem(1, 1));
	const after = fs.reads;
	reader.ratio(mem(1, 1));
	reader.ratio(mem(1, 1));
	assert.equal(fs.reads, after, 'non-Linux: zero further cost');
});

test('a host with cgroups keeps looking with no limit anywhere, so a limit set on a running service is seen', () => {
	// `systemctl set-property app.service MemoryMax=1G` creates a limit file
	// that did not exist at start. A group list that reads proves cgroups, so
	// the sweep never stops; with no file to read it costs one failed open per
	// candidate.
	const self = '0::/system.slice/app.service\n';
	const fs = cgroupFs({ [SELF]: self });
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, GiB / 2)), 0);
	fs.reads = 0;
	near(reader.ratio(mem(1, GiB / 2)), 0);
	assert.equal(fs.reads, cgroupMemoryLimitCandidates(self).length, 'one failed open per candidate');
	fs.files['/sys/fs/cgroup/system.slice/app.service/memory.max'] = String(GiB);
	near(reader.ratio(mem(1, GiB / 2)), 0.5, 'the new limit is seen');
});

test('every absence spelling is a confirmed absence', () => {
	// These codes decide whether a reading is forgotten or stands, so each one
	// is pinned, as is the message fallback for an error that carries no code.
	for (const code of ['ENOENT', 'ENOTDIR', 'ENOSYS']) {
		const fs = cgroupFs({});
		fs.failing.set('*', code);
		const reader = createReader({ readFile: fs.readFile });
		reader.ratio(mem(1, 1));
		const after = fs.reads;
		reader.ratio(mem(1, 1));
		assert.equal(fs.reads, after, `${code} stops the reads`);
	}
	let reads = 0;
	const reader = createReader({ readFile: () => { reads++; throw new Error('ENOENT: no such file'); } });
	reader.ratio(mem(1, 1));
	const after = reads;
	reader.ratio(mem(1, 1));
	assert.equal(reads, after, 'classified by its message');
});

test('a transient failure does not stop the reads', () => {
	const fs = cgroupFs({ [ROOT_V2]: String(GiB) });
	fs.failing.set('*', 'EACCES');
	const reader = createReader({
		readFile: fs.readFile,
		heapStatistics: () => ({ heap_size_limit: 4 * GiB })
	});
	near(reader.ratio(mem(GiB / 2, GiB / 2)), 0.125,
		'nothing has been read yet, so nothing stands: the engine arm alone');
	fs.failing.clear();
	near(reader.ratio(mem(GiB / 2, GiB / 2)), 0.5, 'the wall is found once readable');
});

test('one failed read keeps a fresh reader looking, whether the list or a limit file', () => {
	// A read that fails in a way that proves nothing may have hidden the one
	// file that exists, so a sweep with one must not stop the reads - even when
	// every other read in it confirmed an absence.
	const hiddenList = cgroupFs({ [SELF]: '0::/pod\n', '/sys/fs/cgroup/pod/memory.max': String(GiB) });
	hiddenList.failing.set(SELF, 'EACCES');
	const first = createReader({ readFile: hiddenList.readFile });
	near(first.ratio(mem(1, GiB / 2)), 0, 'the roots are absent and the list is hidden');
	hiddenList.failing.clear();
	near(first.ratio(mem(1, GiB / 2)), 0.5, 'the list reads and leads to the wall');

	const hiddenFile = cgroupFs({ [ROOT_V2]: String(GiB) });
	hiddenFile.failing.set(ROOT_V2, 'EACCES');
	const second = createReader({ readFile: hiddenFile.readFile });
	near(second.ratio(mem(1, GiB / 2)), 0, 'no list, and the one limit file is hidden');
	hiddenFile.failing.clear();
	near(second.ratio(mem(1, GiB / 2)), 0.5, 'the file reads');
});

test('a failed read is not a limit file read, so a fresh reader still stops', () => {
	const fs = cgroupFs({});
	fs.failing.set('*', 'EACCES');
	const reader = createReader({ readFile: fs.readFile });
	reader.ratio(mem(1, 1));
	fs.failing.clear();
	reader.ratio(mem(1, 1));
	const after = fs.reads;
	reader.ratio(mem(1, 1));
	assert.equal(fs.reads, after, 'the all-absent sweep after the failure stops the reads');
});

test('a limit file read proves cgroups with no group list, unlimited or not, whatever else failed', () => {
	// With no list to read, what keeps a reader looking is having read a limit
	// FILE: one that said max proves cgroups as well as a number does, and so
	// does one read in a sweep where some other candidate failed.
	const unlimited = cgroupFs({ [ROOT_V2]: 'max\n' });
	const first = createReader({ readFile: unlimited.readFile });
	near(first.ratio(mem(1, GiB / 2)), 0);
	delete unlimited.files[ROOT_V2];
	near(first.ratio(mem(1, GiB / 2)), 0);
	unlimited.files[ROOT_V2] = String(GiB);
	near(first.ratio(mem(1, GiB / 2)), 0.5, 'a reader that only ever read max keeps looking');

	const uncertain = cgroupFs({ [ROOT_V2]: String(GiB) });
	uncertain.failing.set(ROOT_V1, 'EACCES');
	const second = createReader({ readFile: uncertain.readFile });
	near(second.ratio(mem(1, GiB / 2)), 0.5);
	uncertain.failing.clear();
	delete uncertain.files[ROOT_V2];
	near(second.ratio(mem(1, GiB / 2)), 0);
	uncertain.files[ROOT_V2] = String(GiB);
	near(second.ratio(mem(1, GiB / 2)), 0.5, 'a limit read beside a failing candidate counts');
});

test('a wall whose file is gone drops, and the reader keeps looking', () => {
	const fs = cgroupFs({ [SELF]: '0::/\n', [ROOT_V2]: String(GiB) });
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, GiB / 2)), 0.5);
	delete fs.files[ROOT_V2];
	// Sweeps that find every file absent: the wall is gone, so the reading
	// drops, and the reads go on.
	near(reader.ratio(mem(1, GiB / 2)), 0);
	near(reader.ratio(mem(1, GiB / 2)), 0);
	// The absence forgot the reading: a later failure has nothing to stand at.
	fs.failing.set(ROOT_V2, 'EACCES');
	near(reader.ratio(mem(1, GiB / 2)), 0, 'a vanished wall does not come back from a failed read');
	fs.failing.clear();
	fs.files[ROOT_V2] = String(GiB);
	near(reader.ratio(mem(1, GiB / 2)), 0.5, 'the wall is found again');
});

// - The sweep ------------------------------------------------------------------

test('the tightest limit across the process group and its ancestors is the wall', () => {
	const self = '0::/kubepods/pod1\n';
	const fs = cgroupFs({
		[SELF]: self,
		'/sys/fs/cgroup/kubepods/pod1/memory.max': String(2 * GiB),
		'/sys/fs/cgroup/kubepods/memory.max': String(GiB),
		[ROOT_V2]: 'max\n'
	});
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, GiB / 2)), 0.5, 'rss against the 1 GiB ancestor, not the nearer 2 GiB group');
	// The cost of sweeping: one read per candidate each sample, the list aside.
	fs.reads = 0;
	near(reader.ratio(mem(1, GiB / 2)), 0.5);
	assert.equal(fs.reads, cgroupMemoryLimitCandidates(self).length, 'one read of each limit file per sample');
});

test('the group list is read on the first sample and then every GROUP_LIST_EVERY samples', () => {
	// Reading /proc/self/cgroup takes the kernel's global cgroup lock on most
	// kernels in service, so it is not read on every sample.
	assert.equal(GROUP_LIST_EVERY, 60, 'a minute at the default 1 Hz');
	const fs = cgroupFs({ [SELF]: '0::/\n', [ROOT_V2]: String(GiB) });
	const reader = createReader({ readFile: fs.readFile });
	const listReadAt = [];
	for (let sample = 1; sample <= 2 * GROUP_LIST_EVERY + 1; sample++) {
		const before = fs.readsOf(SELF);
		reader.ratio(mem(1, 1));
		if (fs.readsOf(SELF) > before) listReadAt.push(sample);
	}
	assert.deepEqual(listReadAt, [1, 1 + GROUP_LIST_EVERY, 1 + 2 * GROUP_LIST_EVERY]);
});

test('an unlimited cgroup leaves the engine wall alone in the fold', () => {
	const fs = cgroupFs({ [ROOT_V2]: 'max\n' });
	const reader = createReader({
		readFile: fs.readFile,
		heapStatistics: () => ({ heap_size_limit: 2 * GiB })
	});
	near(reader.ratio(mem(GiB, 3 * GiB)), 0.5, 'rss has no wall here');
});

test('an unlimited root does not hide a nearer group that fails transiently', () => {
	const fs = cgroupFs({
		[SELF]: '0::/pod\n',
		'/sys/fs/cgroup/pod/memory.max': String(GiB),
		[ROOT_V2]: 'max\n'
	});
	fs.failing.set('/sys/fs/cgroup/pod/memory.max', 'EACCES');
	const reader = createReader({
		readFile: fs.readFile,
		heapStatistics: () => ({ heap_size_limit: 8 * GiB })
	});
	near(reader.ratio(mem(GiB, GiB / 2)), 0.125, 'the engine arm alone');
	fs.failing.clear();
	near(reader.ratio(mem(GiB, GiB / 2)), 0.5, 'the hidden wall is found');
});

test('a looser ancestor does not hide the nearer group once it reads', () => {
	const fs = cgroupFs({
		[SELF]: '0::/kubepods/pod1\n',
		'/sys/fs/cgroup/kubepods/pod1/memory.max': String(GiB),
		'/sys/fs/cgroup/kubepods/memory.max': String(8 * GiB)
	});
	fs.failing.set('/sys/fs/cgroup/kubepods/pod1/memory.max', 'EACCES');
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, 2 * GiB)), 0.25, 'the ancestor is the only wall visible');
	fs.failing.clear();
	assert.equal(reader.ratio(mem(1, 2 * GiB)), 1, 'past the nearer wall, clamped');
});

test('a group raised above its parent leaves the parent as the wall', () => {
	// On cgroup v2 every ancestor's limit applies, so raising the nearer group
	// moves the wall to whichever ancestor is now tightest.
	const a = '/sys/fs/cgroup/p/a/memory.max';
	const p = '/sys/fs/cgroup/p/memory.max';
	const fs = cgroupFs({ [SELF]: '0::/p/a\n', [a]: String(GiB), [p]: String(2 * GiB) });
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.9, 'the 1 GiB group');
	fs.files[a] = String(4 * GiB);
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.45, 'the 2 GiB parent, not the raised group');
});

test('an ancestor lowered after the first read is seen', () => {
	const a = '/sys/fs/cgroup/p/a/memory.max';
	const p = '/sys/fs/cgroup/p/memory.max';
	const fs = cgroupFs({ [SELF]: '0::/p/a\n', [a]: String(2 * GiB), [p]: String(4 * GiB) });
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, 0.8 * GiB)), 0.4, 'the 2 GiB group');
	fs.files[p] = String(GiB);
	near(reader.ratio(mem(1, 0.8 * GiB)), 0.8, 'the parent, lowered to 1 GiB');
});

test('an edit to any candidate is seen, the root included', () => {
	const pod = '/sys/fs/cgroup/pod/memory.max';
	const fs = cgroupFs({ [SELF]: '0::/pod\n', [pod]: 'max\n', [ROOT_V2]: 'max\n' });
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, GiB / 2)), 0);
	fs.files[ROOT_V2] = String(2 * GiB);
	near(reader.ratio(mem(1, GiB / 2)), 0.25, 'the root gained a limit');
	fs.files[pod] = String(GiB);
	near(reader.ratio(mem(1, GiB / 2)), 0.5, 'and then the process group did');
});

test('a non-hierarchical v1 ancestor is not the wall, and its flag is read with the group list', () => {
	const own = '/sys/fs/cgroup/memory/docker/abc/memory.limit_in_bytes';
	const parent = '/sys/fs/cgroup/memory/docker/memory.limit_in_bytes';
	const flag = '/sys/fs/cgroup/memory/docker/memory.use_hierarchy';
	const fs = cgroupFs({ [SELF]: '4:memory:/docker/abc\n', [own]: String(4 * GiB), [parent]: String(GiB), [flag]: '0\n' });
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, GiB)), 0.25, 'the 4 GiB container, not the 1 GiB parent that does not bind it');
	for (let sample = 1; sample < GROUP_LIST_EVERY; sample++) {
		near(reader.ratio(mem(1, GiB)), 0.25, `between list reads too, sample ${sample}`);
	}
	assert.equal(fs.readsOf(flag), 1, 'read with the first list only');
	near(reader.ratio(mem(1, GiB)), 0.25);
	assert.equal(fs.readsOf(flag), 2, 'and again with the next');

	const hierarchical = cgroupFs({ [SELF]: '4:memory:/docker/abc\n', [own]: String(4 * GiB), [parent]: String(GiB), [flag]: '1\n' });
	const second = createReader({ readFile: hierarchical.readFile });
	assert.equal(second.ratio(mem(1, GiB)), 1, 'in hierarchical mode the 1 GiB parent is the wall');
});

test('a v1 container on the host namespace keeps its own limit at the mount root, whatever its flag', () => {
	// The runtime bind-mounts the container's group onto /sys/fs/cgroup/memory
	// while /proc/self/cgroup keeps the host path, so the group's own limit is
	// the v1 root file and the path-built candidates do not exist.
	const fs = cgroupFs({
		[SELF]: '12:memory:/docker/abc123\n11:cpu,cpuacct:/docker/abc123\n1:name=systemd:/docker/abc123\n',
		[ROOT_V1]: String(GiB / 2),
		'/sys/fs/cgroup/memory/memory.use_hierarchy': '0\n'
	});
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, GiB / 4)), 0.5, 'the 512 MiB container limit');
});

test('a process outside its cgroup namespace reads no wall from the namespace root', () => {
	const fs = cgroupFs({ [SELF]: '0::/../other\n', [ROOT_V2]: String(GiB) });
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, GiB / 2)), 0, 'the root limit belongs to groups the process is not in');
});

test('a limit file that vanishes is replaced by the one that now carries the wall, in the same sample', () => {
	const fs = cgroupFs({ [SELF]: '0::/\n', [ROOT_V2]: String(GiB) });
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, GiB / 2)), 0.5);
	delete fs.files[ROOT_V2];
	fs.files[ROOT_V1] = String(2 * GiB);
	near(reader.ratio(mem(1, GiB)), 0.5, 'found on the spot, not 0');
});

// - A process that moves ---------------------------------------------------------

test('a move out of a group that is then removed is seen in the same sample', () => {
	// A group with members cannot be removed, so its file going away proves
	// the move. Reporting the sample from the old list would read no wall.
	const a = '/sys/fs/cgroup/a/memory.max';
	const b = '/sys/fs/cgroup/b/memory.max';
	const fs = cgroupFs({ [SELF]: '0::/a\n', [a]: String(GiB) });
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.9, 'group a');
	fs.files[SELF] = '0::/b\n';
	fs.files[b] = String(2 * GiB);
	delete fs.files[a];
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.45, 'group b, not 0');
});

test('a move out of an unlimited group under a live parent drops the parent wall, in one second pass', () => {
	// The old group read max, so the wall was its parent's, which lives on.
	// The second pass must report the new chain alone, read the list once,
	// and sweep each list exactly once.
	const fs = cgroupFs({
		[SELF]: '0::/p/a\n',
		'/sys/fs/cgroup/p/a/memory.max': 'max\n',
		'/sys/fs/cgroup/p/memory.max': String(GiB)
	});
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.9, 'the parent p');
	fs.files[SELF] = '0::/q/b\n';
	fs.files['/sys/fs/cgroup/q/memory.max'] = String(2 * GiB);
	fs.files['/sys/fs/cgroup/q/b/memory.max'] = 'max\n';
	delete fs.files['/sys/fs/cgroup/p/a/memory.max'];
	fs.reads = 0;
	const before = fs.readsOf(SELF);
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.45, 'the parent q, not p');
	assert.equal(fs.readsOf(SELF), before + 1, 'one list read');
	assert.equal(fs.reads, 4 + 1 + 4, 'the old list, the list, the new list');
});

test('a move is seen at once when any file this reader read goes away, not only the own group', () => {
	// The own group carries no limit file, so the file that vanishes with the
	// move is the parent's.
	const fs = cgroupFs({ [SELF]: '0::/p/g\n', '/sys/fs/cgroup/p/memory.max': String(GiB) });
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.9, 'the parent p');
	fs.files[SELF] = '0::/q/h\n';
	fs.files['/sys/fs/cgroup/q/memory.max'] = String(2 * GiB);
	delete fs.files['/sys/fs/cgroup/p/memory.max'];
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.45, 'the parent q, in the same sample');
});

test('a file gone on a sample that read the list is not taken for a move', () => {
	// The list read in that sample is current and still names the group, so
	// the absence is a memory controller switched off: no second pass, and no
	// extra read of the list on the sample after.
	const fs = cgroupFs({ [SELF]: '0::/\n', [ROOT_V2]: String(GiB) });
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, GiB / 2)), 0.5);
	for (let sample = 1; sample < GROUP_LIST_EVERY; sample++) reader.ratio(mem(1, GiB / 2));
	delete fs.files[ROOT_V2];
	const before = fs.readsOf(SELF);
	near(reader.ratio(mem(1, GiB / 2)), 0, 'the scheduled list read, and the file is gone');
	assert.equal(fs.readsOf(SELF), before + 1, 'one list read on that sample');
	near(reader.ratio(mem(1, GiB / 2)), 0);
	assert.equal(fs.readsOf(SELF), before + 1, 'and none on the next');
});

test('a move into a new group while the old one lives on is seen at the next list read', () => {
	const a = '/sys/fs/cgroup/a/memory.max';
	const b = '/sys/fs/cgroup/b/memory.max';
	const fs = cgroupFs({ [SELF]: '0::/a\n', [a]: String(GiB) });
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.9, 'group a');
	fs.files[SELF] = '0::/b\n';
	fs.files[b] = String(2 * GiB);
	for (let sample = 1; sample < GROUP_LIST_EVERY; sample++) {
		near(reader.ratio(mem(1, 0.9 * GiB)), 0.9, `before the list is due, sample ${sample}`);
	}
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.45, 'group b once the list is read');
});

test('a group the process returns to is not stood at the reading from before it left', () => {
	// Nothing re-reads a group the process has left, so its reading is not
	// current up to any failure and must not stand when the process is back.
	const a = '/sys/fs/cgroup/a/memory.max';
	const b = '/sys/fs/cgroup/b/memory.max';
	const fs = cgroupFs({ [SELF]: '0::/a\n', [a]: String(GiB), [b]: String(4 * GiB) });
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.9, 'group a');
	fs.files[SELF] = '0::/b\n';
	near(atNextListRead(reader, fs, 0.9 * GiB), 0.225, 'group b');
	fs.files[a] = String(2 * GiB);
	fs.files[SELF] = '0::/a\n';
	fs.failing.set(a, 'EACCES');
	near(atNextListRead(reader, fs, 0.9 * GiB), 0, 'back in a, whose file fails: no 1 GiB wall from before');
});

// - Standing through a failed read ---------------------------------------------

test('an unreadable limit file stands at its last reading, so the wall does not flap', () => {
	// Every consumer of this reading moves with it, so a sample that drops the
	// wall flaps them all at the sample cadence.
	const pod = '/sys/fs/cgroup/pod/memory.max';
	const fs = cgroupFs({ [SELF]: '0::/pod\n', [pod]: String(2 * GiB) });
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.45);
	fs.files[pod] = String(GiB);
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.9, 'a value edit');
	fs.failing.set('*', 'EACCES');
	for (let sample = 0; sample < 3; sample++) {
		near(reader.ratio(mem(1, 0.9 * GiB)), 0.9, `every read failing, sample ${sample}: the edited value stands`);
	}
	fs.failing.clear();
	fs.files[pod] = String(2 * GiB);
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.45, 'readable again, and the new value is the one used');
});

test('a nearer wall that turns unreadable holds against a looser ancestor that still reads', () => {
	const pod = '/sys/fs/cgroup/kubepods/pod1/memory.max';
	const fs = cgroupFs({
		[SELF]: '0::/kubepods/pod1\n',
		[pod]: String(GiB),
		'/sys/fs/cgroup/kubepods/memory.max': String(8 * GiB)
	});
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.9, 'the nearer group');
	fs.failing.set(pod, 'EACCES');
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.9, 'not the ancestor\'s 0.11');
});

test('a tighter ancestor that turns unreadable holds against a looser nearer group', () => {
	// The mirror: the stood value is not the first candidate swept, and must
	// still win the fold over one that answered.
	const pod = '/sys/fs/cgroup/kubepods/pod1/memory.max';
	const kube = '/sys/fs/cgroup/kubepods/memory.max';
	const fs = cgroupFs({ [SELF]: '0::/kubepods/pod1\n', [pod]: String(8 * GiB), [kube]: String(GiB) });
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.9, 'the 1 GiB ancestor');
	fs.failing.set(kube, 'EACCES');
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.9, 'not the nearer group\'s 0.11');
});

test('an ancestor that fails as the nearer group vanishes stands at its current value', () => {
	const a = '/sys/fs/cgroup/p/a/memory.max';
	const p = '/sys/fs/cgroup/p/memory.max';
	const fs = cgroupFs({ [SELF]: '0::/p/a\n', [a]: String(GiB), [p]: String(2 * GiB), [ROOT_V2]: 'max\n' });
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.9, 'the 1 GiB group');
	delete fs.files[a];
	fs.failing.set(p, 'EMFILE');
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.45, 'the group is gone, the parent stands at 2 GiB, not 0');
});

test('every readable file is re-read each sample, so what stands is current', () => {
	// An ancestor's reading must not date from the first sample: both were
	// raised here, and a stale 2 GiB ancestor would read 1 against the true 0.5.
	const svc = '/sys/fs/cgroup/system.slice/app.service/memory.max';
	const slice = '/sys/fs/cgroup/system.slice/memory.max';
	const fs = cgroupFs({ [SELF]: '0::/system.slice/app.service\n', [svc]: String(GiB), [slice]: String(2 * GiB) });
	const reader = createReader({ readFile: fs.readFile });
	assert.equal(reader.ratio(mem(1, 2 * GiB)), 1, 'the 1 GiB service');
	fs.files[svc] = String(4 * GiB);
	fs.files[slice] = String(8 * GiB);
	near(reader.ratio(mem(1, 2 * GiB)), 0.5, 'both resizes seen');
	fs.failing.set('*', 'EMFILE');
	near(reader.ratio(mem(1, 2 * GiB)), 0.5, 'both stand at their current values');
});

test('a wall seen while a nearer group was hidden still stands when everything fails', () => {
	const fs = cgroupFs({ [SELF]: '0::/pod\n', [ROOT_V2]: String(GiB) });
	fs.failing.set('/sys/fs/cgroup/pod/memory.max', 'EACCES');
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, GiB / 2)), 0.5, 'the root, while the nearer group is hidden');
	fs.failing.set('*', 'EACCES');
	near(reader.ratio(mem(1, GiB / 2)), 0.5, 'every read failing');
});

test('a stood value gives way to a fresh read', () => {
	const pod = '/sys/fs/cgroup/kubepods/pod1/memory.max';
	const kube = '/sys/fs/cgroup/kubepods/memory.max';
	const fs = cgroupFs({ [SELF]: '0::/kubepods/pod1\n', [pod]: String(GiB), [kube]: String(8 * GiB) });
	const reader = createReader({ readFile: fs.readFile });
	assert.equal(reader.ratio(mem(1, 4 * GiB)), 1, 'the 1 GiB pod');
	fs.failing.set(pod, 'EACCES');
	assert.equal(reader.ratio(mem(1, 4 * GiB)), 1, 'the pod stands');
	fs.failing.clear();
	fs.files[pod] = String(16 * GiB);
	near(reader.ratio(mem(1, 4 * GiB)), 0.5, 'read again: the 8 GiB ancestor is the wall now');
});

test('a nearer group found late is folded in at once', () => {
	const pod = '/sys/fs/cgroup/kubepods/pod1/memory.max';
	const kube = '/sys/fs/cgroup/kubepods/memory.max';
	const fs = cgroupFs({ [SELF]: '0::/kubepods/pod1\n', [pod]: String(GiB), [kube]: String(8 * GiB) });
	fs.failing.set(pod, 'EACCES');
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, 2 * GiB)), 0.25, 'the ancestor is all that is visible');
	fs.failing.set(kube, 'EACCES');
	near(reader.ratio(mem(1, 2 * GiB)), 0.25, 'and it stands');
	fs.failing.clear();
	assert.equal(reader.ratio(mem(1, 2 * GiB)), 1, 'the nearer group is found');
});

test('a limit lifted to unlimited does not come back from a failed read', () => {
	// "Unlimited" is a reading like any other: a file that last said max stands
	// at max. Remembering only finite limits would resurrect the lifted one -
	// a fabricated alarm.
	const pod = '/sys/fs/cgroup/pod/memory.max';
	const fs = cgroupFs({ [SELF]: '0::/pod\n', [pod]: String(GiB) });
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.9);
	fs.files[pod] = 'max\n';
	near(reader.ratio(mem(1, 0.9 * GiB)), 0, 'lifted');
	fs.failing.set(pod, 'EACCES');
	near(reader.ratio(mem(1, 0.9 * GiB)), 0, 'and it stands at unlimited');
});

test('a file that vanished has nothing to stand at when it later fails', () => {
	const pod = '/sys/fs/cgroup/pod/memory.max';
	const fs = cgroupFs({ [SELF]: '0::/pod\n', [pod]: String(GiB) });
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, GiB / 2)), 0.5);
	delete fs.files[pod];
	near(reader.ratio(mem(1, GiB / 2)), 0, 'gone');
	fs.failing.set(pod, 'EACCES');
	near(reader.ratio(mem(1, GiB / 2)), 0, 'and a later failure has nothing to stand at');
});

// - The group list ---------------------------------------------------------------

test('with the group list hidden, the last list read is swept', () => {
	const pod = '/sys/fs/cgroup/pod/memory.max';
	const fs = cgroupFs({ [SELF]: '0::/pod\n', [pod]: String(GiB) });
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, GiB / 2)), 0.5);
	fs.failing.set(SELF, 'EACCES');
	fs.files[pod] = String(2 * GiB);
	near(atNextListRead(reader, fs, GiB / 2), 0.25, 'the process group is still read, edit included');
	fs.failing.set(pod, 'EACCES');
	near(atNextListRead(reader, fs, GiB / 2), 0.25, 'and stands when it cannot be');
});

test('a hidden group list keeps a group that read unlimited in the sweep', () => {
	const pod = '/sys/fs/cgroup/pod/memory.max';
	const fs = cgroupFs({ [SELF]: '0::/pod\n', [pod]: 'max\n' });
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, GiB / 2)), 0);
	fs.failing.set(SELF, 'EACCES');
	fs.files[pod] = String(GiB);
	near(atNextListRead(reader, fs, GiB / 2), 0.5, 'the group gained a limit while the list was hidden');
});

test('a group list that is absent rather than hidden keeps the own group in the sweep', () => {
	// An absent list says nothing about which group the process lives in, so
	// it is no evidence the process left the one already read.
	const pod = '/sys/fs/cgroup/pod/memory.max';
	const fs = cgroupFs({ [SELF]: '0::/pod\n', [pod]: String(GiB) });
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.9);
	delete fs.files[SELF];
	fs.failing.set(pod, 'EACCES');
	near(atNextListRead(reader, fs, 0.9 * GiB), 0.9, 'the pod stands');
});

test('a list that fails is tried on every sample until it reads', () => {
	// While the list does not read, the last one that did is the best evidence
	// there is; the moment it reads again it is the authority.
	const a = '/sys/fs/cgroup/a/memory.max';
	const b = '/sys/fs/cgroup/b/memory.max';
	const fs = cgroupFs({ [SELF]: '0::/a\n', [a]: String(GiB), [ROOT_V2]: 'max\n' });
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.9, 'group a');
	delete fs.files[SELF];
	fs.files[b] = String(4 * GiB);
	near(atNextListRead(reader, fs, 0.9 * GiB), 0.9, 'list absent at its read: a is the last group known');
	const before = fs.readsOf(SELF);
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.9);
	assert.equal(fs.readsOf(SELF), before + 1, 'tried again on the next sample');
	fs.files[SELF] = '0::/b\n';
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.225, 'the list names b');
});

test('a hidden list is tried on every sample too, not left for the schedule', () => {
	const fs = cgroupFs({ [SELF]: '0::/pod\n', '/sys/fs/cgroup/pod/memory.max': String(GiB) });
	const reader = createReader({ readFile: fs.readFile });
	reader.ratio(mem(1, 1));
	fs.failing.set(SELF, 'EACCES');
	atNextListRead(reader, fs, 1);
	const before = fs.readsOf(SELF);
	reader.ratio(mem(1, 1));
	assert.equal(fs.readsOf(SELF), before + 1, 'tried again on the next sample');
});

test('a group file that vanishes while the list is hidden is read again when it returns', () => {
	const pod = '/sys/fs/cgroup/pod/memory.max';
	const fs = cgroupFs({ [SELF]: '0::/pod\n', [pod]: String(GiB) });
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.9);
	fs.failing.set(SELF, 'EACCES');
	delete fs.files[pod];
	near(reader.ratio(mem(1, 0.9 * GiB)), 0, 'gone');
	fs.files[pod] = String(GiB);
	near(reader.ratio(mem(1, 0.9 * GiB)), 0.9, 'back, with the list still hidden');
});

test('a hidden list on a fresh reader sweeps the roots, and the own group once the list reads', () => {
	const fs = cgroupFs({ [SELF]: '0::/pod\n', '/sys/fs/cgroup/pod/memory.max': String(GiB), [ROOT_V2]: String(8 * GiB) });
	fs.failing.set(SELF, 'EACCES');
	const reader = createReader({ readFile: fs.readFile });
	near(reader.ratio(mem(1, 2 * GiB)), 0.25, 'the root, while the list is hidden');
	fs.failing.clear();
	assert.equal(reader.ratio(mem(1, 2 * GiB)), 1, 'the process group is found');
});

// - The engine arm ---------------------------------------------------------------

test('the engine arm folds in beside a known cgroup wall', () => {
	const fs = cgroupFs({ [ROOT_V2]: String(8 * GiB) });
	const reader = createReader({
		readFile: fs.readFile,
		heapStatistics: () => ({ heap_size_limit: 2 * GiB })
	});
	near(reader.ratio(mem(GiB, GiB)), 0.5, 'heap 1 of 2 GiB beats rss 1 of 8 GiB');
});

test('a broken isolate reader with no cgroup reports calm, not NaN', () => {
	const reader = createReader({
		readFile: cgroupFs({}).readFile,
		heapStatistics: () => { throw new Error('no isolate'); }
	});
	assert.equal(reader.ratio(mem(GiB, GiB)), 0);
});

test('the engine ceiling is read once', () => {
	let calls = 0;
	const reader = createReader({
		readFile: cgroupFs({}).readFile,
		heapStatistics: () => { calls++; return { heap_size_limit: GiB }; }
	});
	reader.ratio(mem(1, 1));
	reader.ratio(mem(1, 1));
	assert.equal(calls, 1, 'treated as fixed for the process life');
});
