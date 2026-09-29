import { beforeEach, describe, expect, it } from 'vitest';
import { get } from 'svelte/store';
import type { Vec3 } from '$lib/websocket/cameraStream';
import {
	CAMERA_EXPIRE_MS,
	CAMERA_FADE_MS,
	CAMERA_MIN_OPACITY,
	CAMERA_SEQ_RESET_GAP,
	CAMERA_STALE_MS,
	POINTER_FADE_MS,
	POINTER_IDLE_MS,
	applyCameraSample,
	cameraOpacity,
	parseCameraSample,
	pointerOpacity,
	pruneExpiredCameras,
	remoteCameraActions,
	remoteCameraStore,
	type RemoteCameraMap
} from '../remoteCameraStore.svelte';

const sample = (seq: number, x = 0) => ({ p: [x, 25, 0], t: [0, 0, 0], seq });

describe('parseCameraSample', () => {
	it('accepts a well-formed payload', () => {
		expect(parseCameraSample(sample(1))).toEqual({ p: [0, 25, 0], t: [0, 0, 0], seq: 1 });
	});

	it.each([
		['null', null],
		['a string', 'nope'],
		['a missing target', { p: [0, 0, 0], seq: 1 }],
		['a short vector', { p: [0, 0], t: [0, 0, 0], seq: 1 }],
		['a non-numeric vector', { p: [0, '25', 0], t: [0, 0, 0], seq: 1 }],
		['NaN', { p: [0, NaN, 0], t: [0, 0, 0], seq: 1 }],
		['a missing seq', { p: [0, 0, 0], t: [0, 0, 0] }]
	])('rejects %s', (_label, value) => {
		expect(parseCameraSample(value)).toBeNull();
	});
});

describe('applyCameraSample', () => {
	const empty: RemoteCameraMap = {};

	it('stores the first sample with its arrival time', () => {
		const next = applyCameraSample(empty, 'bob', sample(1, 3), 1_000);
		expect(next.bob).toEqual({
			p: [3, 25, 0],
			t: [0, 0, 0],
			seq: 1,
			lastSeen: 1_000,
			c: null,
			pointerAt: 1_000,
			pointerFrom: null
		});
	});

	it('applies a newer seq', () => {
		const first = applyCameraSample(empty, 'bob', sample(1, 3), 1_000);
		const second = applyCameraSample(first, 'bob', sample(2, 7), 1_400);
		expect(second.bob).toMatchObject({ p: [7, 25, 0], seq: 2, lastSeen: 1_400 });
	});

	it('drops a reordered (older) sample, keeping the newest pose', () => {
		const first = applyCameraSample(empty, 'bob', sample(5, 7), 1_000);
		const stale = applyCameraSample(first, 'bob', sample(4, 3), 1_100);
		expect(stale).toBe(first); // same object → no subscriber churn
		expect(stale.bob).toMatchObject({ p: [7, 25, 0], seq: 5, lastSeen: 1_000 });
	});

	it('drops a duplicate seq', () => {
		const first = applyCameraSample(empty, 'bob', sample(5, 7), 1_000);
		expect(applyCameraSample(first, 'bob', sample(5, 3), 1_100)).toBe(first);
	});

	it('accepts a restarted stream — a peer that reloaded begins at seq 1 again', () => {
		const first = applyCameraSample(empty, 'bob', sample(CAMERA_SEQ_RESET_GAP + 50, 7), 1_000);
		const restarted = applyCameraSample(first, 'bob', sample(1, 3), 9_000);
		expect(restarted.bob).toMatchObject({ p: [3, 25, 0], seq: 1, lastSeen: 9_000 });
	});

	it('keeps players independent', () => {
		let map = applyCameraSample(empty, 'bob', sample(9), 1_000);
		map = applyCameraSample(map, 'ana', sample(1), 1_050);
		expect(Object.keys(map).sort()).toEqual(['ana', 'bob']);
	});

	it('ignores malformed payloads and empty ids', () => {
		expect(applyCameraSample(empty, 'bob', { nope: true }, 1)).toBe(empty);
		expect(applyCameraSample(empty, '', sample(1), 1)).toBe(empty);
	});
});

describe('remote pointer (tableplace-197)', () => {
	const empty: RemoteCameraMap = {};
	const pointing = (seq: number, c: unknown) => ({ ...sample(seq), c });

	it('parses the optional pointer', () => {
		expect(parseCameraSample(pointing(1, [2, -3]))).toEqual({
			p: [0, 25, 0],
			t: [0, 0, 0],
			seq: 1,
			c: [2, -3]
		});
	});

	it('a malformed pointer loses only the pointer, never the pose', () => {
		for (const c of [[1], [1, 2, 3], ['1', 2], [NaN, 0], 'here', {}])
			expect(parseCameraSample(pointing(1, c))).toEqual({ p: [0, 25, 0], t: [0, 0, 0], seq: 1 });
	});

	it('a sample from a sender that predates pointers reads as no pointer', () => {
		expect(applyCameraSample(empty, 'bob', sample(1), 1_000).bob.c).toBeNull();
	});

	it('an absent pointer hides it — the sender left the canvas', () => {
		const shown = applyCameraSample(empty, 'bob', pointing(1, [2, 3]), 1_000);
		expect(shown.bob.c).toEqual([2, 3]);
		expect(applyCameraSample(shown, 'bob', sample(2), 1_300).bob.c).toBeNull();
	});

	it('pointerAt follows the pointer moving, not samples arriving', () => {
		let map = applyCameraSample(empty, 'bob', pointing(1, [2, 3]), 1_000);
		expect(map.bob.pointerAt).toBe(1_000);
		// an orbit under a parked pointer: new pose, same table point
		map = applyCameraSample(map, 'bob', { p: [9, 25, 0], t: [0, 0, 0], seq: 2, c: [2, 3] }, 1_400);
		expect(map.bob).toMatchObject({ lastSeen: 1_400, pointerAt: 1_000 });
		map = applyCameraSample(map, 'bob', pointing(3, [4, 3]), 1_800);
		expect(map.bob.pointerAt).toBe(1_800);
	});

	it('creep in small steps under a settling camera does not hold the fade off', () => {
		let map = applyCameraSample(empty, 'bob', pointing(1, [2, 3]), 1_000);
		for (let i = 1; i <= 5; i++)
			map = applyCameraSample(map, 'bob', pointing(1 + i, [2 + i * 0.02, 3]), 1_000 + i * 400);
		expect(map.bob.pointerAt).toBe(1_000);
		// …but past the gate from where it last moved, it is a move
		map = applyCameraSample(map, 'bob', pointing(10, [2.2, 3]), 4_000);
		expect(map.bob.pointerAt).toBe(4_000);
	});

	it('a pointer coming back counts as a move', () => {
		let map = applyCameraSample(empty, 'bob', pointing(1, [2, 3]), 1_000);
		map = applyCameraSample(map, 'bob', sample(2), 1_400);
		map = applyCameraSample(map, 'bob', pointing(3, [2, 3]), 9_000);
		expect(map.bob.pointerAt).toBe(9_000);
	});

	it('pointerOpacity: full for POINTER_IDLE_MS, then gone over POINTER_FADE_MS', () => {
		expect(pointerOpacity(0)).toBe(1);
		expect(pointerOpacity(POINTER_IDLE_MS)).toBe(1);
		expect(pointerOpacity(POINTER_IDLE_MS + POINTER_FADE_MS / 2)).toBeCloseTo(0.5);
		expect(pointerOpacity(POINTER_IDLE_MS + POINTER_FADE_MS)).toBe(0);
		expect(pointerOpacity(POINTER_IDLE_MS * 10)).toBe(0);
	});
});

describe('pruneExpiredCameras', () => {
	const stale = (lastSeen: number) => ({
		p: [0, 0, 0] as Vec3,
		t: [0, 0, 0] as Vec3,
		seq: 1,
		lastSeen,
		c: null,
		pointerAt: lastSeen,
		pointerFrom: null
	});
	const NOW = 100_000;

	it('drops only entries past the expiry window', () => {
		const map: RemoteCameraMap = {
			fresh: stale(NOW),
			gone: stale(NOW - CAMERA_EXPIRE_MS - 1)
		};
		expect(Object.keys(pruneExpiredCameras(map, NOW))).toEqual(['fresh']);
	});

	it('returns the same map when nothing expired', () => {
		const map: RemoteCameraMap = { fresh: stale(NOW) };
		expect(pruneExpiredCameras(map, NOW)).toBe(map);
	});

	// #48 gave us a real presence flag, so a silent-but-present player must not
	// blink out just because their camera has not moved. The sender goes quiet
	// on purpose when a camera settles — expiry alone would punish sitting still.
	it('keeps a long-silent player the server says is still connected', () => {
		const map: RemoteCameraMap = { parked: stale(NOW - CAMERA_EXPIRE_MS * 10) };
		const kept = pruneExpiredCameras(map, NOW, CAMERA_EXPIRE_MS, {
			parked: { connected: true }
		});
		expect(Object.keys(kept)).toEqual(['parked']);
	});

	it('drops a player the server reports offline, without waiting out the expiry', () => {
		const map: RemoteCameraMap = { left: stale(NOW) };
		expect(pruneExpiredCameras(map, NOW, CAMERA_EXPIRE_MS, { left: { connected: false } })).toEqual(
			{}
		);
	});

	it('falls back to expiry when presence is unknown', () => {
		const map: RemoteCameraMap = {
			unknown: stale(NOW - CAMERA_EXPIRE_MS - 1),
			noRow: stale(NOW)
		};
		// a row with no `connected` field yet is offline-unknown, not connected
		const kept = pruneExpiredCameras(map, NOW, CAMERA_EXPIRE_MS, { unknown: {}, noRow: null });
		expect(Object.keys(kept)).toEqual(['noRow']);
	});
});

describe('cameraOpacity', () => {
	it('is fully opaque until the sample goes stale', () => {
		expect(cameraOpacity(0)).toBe(1);
		expect(cameraOpacity(CAMERA_STALE_MS)).toBe(1);
	});

	it('fades to the floor and stays there', () => {
		expect(cameraOpacity(CAMERA_STALE_MS + CAMERA_FADE_MS / 2)).toBeCloseTo(
			1 - (1 - CAMERA_MIN_OPACITY) / 2
		);
		expect(cameraOpacity(CAMERA_STALE_MS + CAMERA_FADE_MS)).toBeCloseTo(CAMERA_MIN_OPACITY);
		expect(cameraOpacity(CAMERA_EXPIRE_MS)).toBeCloseTo(CAMERA_MIN_OPACITY);
	});
});

describe('remoteCameraActions', () => {
	beforeEach(() => remoteCameraActions.reset());

	it('receive → tick expiry removes an avatar that stopped sending', () => {
		remoteCameraActions.receive('bob', sample(1), 1_000);
		expect(get(remoteCameraStore).bob).toBeDefined();

		remoteCameraActions.tick(1_000 + CAMERA_EXPIRE_MS - 1);
		expect(get(remoteCameraStore).bob).toBeDefined();

		remoteCameraActions.tick(1_000 + CAMERA_EXPIRE_MS);
		expect(get(remoteCameraStore).bob).toBeUndefined();
	});

	it('tick keeps a connected player past expiry and drops a disconnected one', () => {
		remoteCameraActions.receive('bob', sample(1), 1_000);
		remoteCameraActions.receive('ana', sample(1), 1_000);

		remoteCameraActions.tick(1_000 + CAMERA_EXPIRE_MS * 5, {
			bob: { connected: true },
			ana: { connected: false }
		});

		expect(Object.keys(get(remoteCameraStore))).toEqual(['bob']);
	});

	it('forget drops one player', () => {
		remoteCameraActions.receive('bob', sample(1), 1_000);
		remoteCameraActions.receive('ana', sample(1), 1_000);
		remoteCameraActions.forget('bob');
		expect(Object.keys(get(remoteCameraStore))).toEqual(['ana']);
	});

	it('retain keeps only players still in the roster', () => {
		remoteCameraActions.receive('bob', sample(1), 1_000);
		remoteCameraActions.receive('ana', sample(1), 1_000);
		remoteCameraActions.retain(['ana']);
		expect(Object.keys(get(remoteCameraStore))).toEqual(['ana']);
	});
});
