import { describe, it, expect } from 'vitest';
import {
	parseScenarioFile,
	serializeScenarioFile,
	scenarioFileName,
	SCENARIO_SCHEMA_URL,
	type Scenario
} from '../file';

const scenario: Scenario = {
	name: 'duel',
	createdAt: 1700000000000,
	state: {
		cards: { 'card:seat0:main-AS': { position: [0, 0.1, 0], faceImageUrl: 'gen:std52/AS' } },
		decks: {},
		pieces: { 'piece:seat0:hp-0': { kind: 'counter', name: 'HP', value: 20, maxValue: 20 } },
		overlays: {},
		players: { seat0: { id: 'seat0', seat: 0, joinTimestamp: 0, tray: {}, metadata: {} } }
	}
};

describe('tbps round-trip', () => {
	it('export → parse returns the same scenario', () => {
		expect(parseScenarioFile(serializeScenarioFile(scenario))).toEqual(scenario);
	});

	it('writes the discriminator and $schema line', () => {
		const file = JSON.parse(serializeScenarioFile(scenario));
		expect(file.tbps).toBe(1);
		expect(file.$schema).toBe(SCENARIO_SCHEMA_URL);
	});

	it('names files <name>.tbps.json', () => {
		expect(scenarioFileName('duel')).toBe('duel.tbps.json');
	});
});

describe('legacy scenario-<name>.json fallback (v0)', () => {
	it('accepts files without a tbps field', () => {
		const legacy = { name: 'old', createdAt: 123, state: { cards: {}, decks: {}, players: {} } };
		expect(parseScenarioFile(JSON.stringify(legacy))).toEqual(legacy);
	});

	it('defaults a missing createdAt', () => {
		const legacy = { name: 'old', state: {} };
		const parsed = parseScenarioFile(JSON.stringify(legacy));
		expect(parsed.createdAt).toBeTypeOf('number');
	});
});

describe('snapPoints', () => {
	const withSnap: Scenario = {
		...scenario,
		snapPoints: [{ position: [0, 2.5], rotation: 0, radius: 1 }, { position: [-4, 0] }]
	};

	it('round-trips through export → parse', () => {
		expect(parseScenarioFile(serializeScenarioFile(withSnap))).toEqual(withSnap);
	});

	it('is written at the top level, not buried in state', () => {
		const file = JSON.parse(serializeScenarioFile(withSnap));
		expect(file.snapPoints).toHaveLength(2);
		expect(file.state.snapPoints).toBeUndefined();
	});

	it('does not decide the file version — a hand-placed table stays v1', () => {
		expect(JSON.parse(serializeScenarioFile(withSnap)).tbps).toBe(1);
	});

	it('keeps a rotation of 0 distinct from no rotation at all', () => {
		const parsed = parseScenarioFile(serializeScenarioFile(withSnap));
		expect(parsed.snapPoints?.[0].rotation).toBe(0);
		expect(parsed.snapPoints?.[1]).toEqual({ position: [-4, 0] });
	});

	it('leaves a scenario without the field untouched — no key invented on read', () => {
		const parsed = parseScenarioFile(serializeScenarioFile(scenario));
		expect(parsed).toEqual(scenario);
		expect('snapPoints' in parsed).toBe(false);
	});

	it('reports the offending path for a malformed point', () => {
		const bad = (points: unknown) =>
			JSON.stringify({ tbps: 1, name: 'x', state: {}, snapPoints: points });
		expect(() => parseScenarioFile(bad('nope'))).toThrow(/`snapPoints` must be an array/);
		expect(() => parseScenarioFile(bad([{}]))).toThrow(
			/snapPoints\[0\]\.position must be \[x, z\]/
		);
		expect(() => parseScenarioFile(bad([{ position: [0, 0, 0] }]))).toThrow(
			/snapPoints\[0\]\.position/
		);
		expect(() => parseScenarioFile(bad([{ position: [0, 0], rotation: 'east' }]))).toThrow(
			/snapPoints\[0\]\.rotation must be a yaw in degrees/
		);
		expect(() => parseScenarioFile(bad([{ position: [0, 0], radius: 0 }]))).toThrow(
			/snapPoints\[0\]\.radius must be a positive number/
		);
	});
});

describe('parseScenarioFile errors', () => {
	it('rejects non-JSON', () => {
		expect(() => parseScenarioFile('nope')).toThrow(/valid JSON/);
	});

	it('rejects unknown versions', () => {
		expect(() => parseScenarioFile(JSON.stringify({ tbps: 9, name: 'x', state: {} }))).toThrow(
			/version 9/
		);
	});

	it('refuses a counter value outside its own range, naming both bounds', () => {
		const withCounter = (piece: Record<string, unknown>) =>
			JSON.stringify({
				tbps: 1,
				name: 'x',
				state: { pieces: { 'piece:seat0:dial-0': { kind: 'counter', name: 'Dial', ...piece } } }
			});

		expect(() => parseScenarioFile(withCounter({ value: 2, minValue: 3, maxValue: 17 }))).toThrow(
			'state.pieces["piece:seat0:dial-0"].value must be between 3 and 17, got 2'
		);
		expect(() => parseScenarioFile(withCounter({ value: 18, minValue: 3, maxValue: 17 }))).toThrow(
			/between 3 and 17/
		);
		// no minValue means 0, as it always did
		expect(() => parseScenarioFile(withCounter({ value: -1, maxValue: 17 }))).toThrow(
			/between 0 and 17/
		);
		// both ends of the range are inside it
		for (const value of [3, 17]) {
			expect(
				parseScenarioFile(withCounter({ value, minValue: 3, maxValue: 17 })).state.pieces
			).toMatchObject({ 'piece:seat0:dial-0': { value, minValue: 3 } });
		}
	});

	it('does not hold a die, or an override that names no kind, to a counter range', () => {
		const parsed = parseScenarioFile(
			JSON.stringify({
				tbps: 1,
				name: 'x',
				state: {
					pieces: {
						'piece:seat0:d20-0': { kind: 'die', sides: 20, value: 20, maxValue: 6 },
						'piece:seat0:dial-0': { value: -4 }
					}
				}
			})
		);
		expect(Object.keys(parsed.state.pieces ?? {})).toHaveLength(2);
	});

	it('rejects files without a name or state', () => {
		expect(() => parseScenarioFile(JSON.stringify({ state: {} }))).toThrow(/name/);
		expect(() => parseScenarioFile(JSON.stringify({ name: 'x' }))).toThrow(/state/);
	});
});
