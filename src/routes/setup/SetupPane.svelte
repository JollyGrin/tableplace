<script lang="ts">
	import {
		Button,
		Pane,
		Element,
		Folder,
		List,
		Text,
		Point,
		Wheel,
		AutoValue,
		Checkbox,
		Slider,
		Stepper,
		TabGroup,
		TabPage
	} from 'svelte-tweakpane-ui';
	import { gameStore } from '$lib/store/game/gameStore.svelte';
	import { gameActions } from '$lib/store/game/actions';
	import { cameraTransforms } from '$lib/utils/transforms/camera';
	import { importTtsFile } from '$lib/tts/import';
	import { spawnPack, STANDARD_52 } from '$lib/packs';
	import PackLibrary from '$lib/packs/PackLibrary.svelte';
	import {
		saveScenario,
		listScenarios,
		getScenario,
		deleteScenario,
		applyScenario,
		ensureSeatPlaceholder,
		seatPlaceholderId,
		isSeatPlaceholder,
		exportScenarioToFile,
		importScenarioFromText,
		type SeatIndex
	} from '$lib/scenario/scenario';
	import { setSelectedDeck } from '$lib/store/deckSelection';
	import { snapPointIds } from '$lib/store/game/actions/snap';
	import {
		snapEditor,
		setSnapDefaults,
		setSnapLinking,
		setSnapPlacing
	} from '$lib/store/snapEditor';
	import {
		SNAP_GRID_COLS_DEFAULT,
		SNAP_GRID_PITCH_DEFAULT,
		SNAP_GRID_ROWS_DEFAULT,
		SNAP_GRID_YAW_STEP_DEFAULT,
		SNAP_RADIUS_DEFAULT
	} from '$lib/utils/constants-snap';
	import HUDPieces from '$lib/HUDPieces.svelte';
	import PaneProse from '$lib/tweakpane/PaneProse.svelte';
	import FileDropZone from '$lib/files/FileDropZone.svelte';
	import { openDroppedFile } from '$lib/files/drop';
	import { purgeUndefinedValues } from '$lib/utils/transforms/data';
	import { tick } from 'svelte';
	import { DEG2RAD } from 'three/src/math/MathUtils.js';
	import type { GameDTO } from '$lib/store/game/types';
	import toast from 'svelte-french-toast';

	let activeSeat: SeatIndex = $state(0);
	const seatOptions = { 'Seat 0 (near)': 0, 'Seat 1 (far)': 1, 'Seat 2': 2, 'Seat 3': 3 };

	let deckFileInput: HTMLInputElement | undefined = $state();
	let scenarioFileInput: HTMLInputElement | undefined = $state();
	let isImporting = $state(false);

	let scenarioName = $state('my-scenario');
	let selectedScenario = $state(listScenarios()[0]?.name ?? '');
	let scenarioNames = $state(listScenarios().map((s) => s.name));
	const scenarioOptions = $derived(
		scenarioNames.length
			? Object.fromEntries(scenarioNames.map((n) => [n, n]))
			: { '(none saved)': '' }
	);

	function refreshScenarios() {
		scenarioNames = listScenarios().map((s) => s.name);
	}

	async function handleImportDeck(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		isImporting = true;
		try {
			ensureSeatPlaceholder(activeSeat);
			const report = await importTtsFile(await file.text(), {
				ownerId: seatPlaceholderId(activeSeat),
				mirror: activeSeat === 1
			});
			toast(`Seat ${activeSeat}: imported ${report.decks} deck(s), ${report.cards} cards`, {
				duration: 5000
			});
		} catch (error) {
			toast.error(`Import failed: ${error instanceof Error ? error.message : 'invalid file'}`);
		} finally {
			isImporting = false;
			input.value = '';
		}
	}

	function viewFromSeat() {
		gameActions.setSeat(activeSeat);
		cameraTransforms.resetView();
	}

	function handleSave() {
		const name = scenarioName.trim();
		if (!name) return toast.error('Name the scenario first');
		saveScenario(name);
		refreshScenarios();
		selectedScenario = name;
		toast(`Saved scenario: ${name}`);
	}

	/**
	 * Reflect the table's overlay in the controls after a scenario lands. Read
	 * from the store, not from the file: a v2 scenario's overlay may have come
	 * from a pack rather than from `state`.
	 */
	function syncOverlayControls() {
		const overlay = $gameStore?.overlays?.table;
		imageUrl = overlay?.imageUrl ?? '';
		scale = overlay?.scale ?? 12;
		rot = (overlay?.rotation?.[1] ?? 0) / DEG2RAD;
		point3d = { x: overlay?.position?.[0] ?? 0, y: overlay?.position?.[2] ?? 0 };
	}

	async function handleLoad() {
		const scenario = getScenario(selectedScenario);
		if (!scenario) return toast.error('Pick a saved scenario first');
		const report = await applyScenario(scenario);
		scenarioName = scenario.name;
		syncOverlayControls();
		for (const { id, reason } of report.failedPacks) {
			toast.error(`Pack '${id}' failed to load: ${reason}`, { duration: 6000 });
		}
		toast(`Loaded: ${scenario.name}`);
	}

	/**
	 * A file dropped on the table routes by its own discriminator: a pack joins
	 * the library and spawns for the seat being edited, a scenario is saved and
	 * loaded. Same destinations as the buttons, one gesture.
	 */
	async function handleDroppedFile(file: File) {
		const opened = await openDroppedFile(file, {
			ownerId: seatPlaceholderId(activeSeat),
			beforeSpawn: () => ensureSeatPlaceholder(activeSeat)
		});
		if (opened?.kind !== 'scenario') return;
		refreshScenarios();
		selectedScenario = opened.scenario.name;
		scenarioName = opened.scenario.name;
		syncOverlayControls();
	}

	/** Put pack content on the table for the active seat — the v2 authoring flow. */
	function handleSpawnStandard52() {
		ensureSeatPlaceholder(activeSeat);
		spawnPack(STANDARD_52, { ownerId: seatPlaceholderId(activeSeat) });
		toast(`Seat ${activeSeat}: spawned ${STANDARD_52.name}`);
	}

	// ── second-click guard for the two irreversible buttons ───────────────────
	// `Clear table` sits directly under `Delete selected`, and neither could be
	// undone (#114). A browser `confirm()` is out — it steals focus from a
	// draggable pane — and so is swapping the button for a confirm pair: an
	// `{#if}` that REPLACES a blade tears the whole pane down (see the note in
	// create/BulkSheet.svelte). So the button arms itself instead: the first
	// click renames it to the question and ADDS a Cancel beside it (adding
	// blades is safe), and only the second click goes through.

	/** an armed button someone walked away from goes back to being safe */
	const CONFIRM_TIMEOUT_MS = 5000;

	let armed: 'clear' | 'delete' | null = $state(null);
	let armedTimer: ReturnType<typeof setTimeout> | undefined;

	function arm(which: 'clear' | 'delete') {
		clearTimeout(armedTimer);
		armed = which;
		armedTimer = setTimeout(() => (armed = null), CONFIRM_TIMEOUT_MS);
	}

	function disarm() {
		clearTimeout(armedTimer);
		armed = null;
	}

	$effect(() => disarm);

	/**
	 * Nothing to lose: an empty table clears without asking. Overlays are judged
	 * by their `imageUrl` rather than their presence — the pane's own effect
	 * keeps an `overlays.table` record alive for the Position/Scale/Rotation
	 * controls whether or not a map was ever picked, so a bare one isn't content.
	 */
	const tableIsEmpty = $derived.by(() => {
		const s = $gameStore;
		for (const collection of ['cards', 'decks', 'pieces', 'snapPoints'] as const) {
			if (Object.values(s?.[collection] ?? {}).some(Boolean)) return false;
		}
		if (Object.values(s?.overlays ?? {}).some((o) => o?.imageUrl)) return false;
		return !Object.keys(s?.players ?? {}).some(isSeatPlaceholder);
	});

	function handleDelete() {
		if (!selectedScenario) return;
		if (armed !== 'delete') return arm('delete');
		disarm();
		deleteScenario(selectedScenario);
		refreshScenarios();
		selectedScenario = scenarioNames[0] ?? '';
	}

	function handleClearTable() {
		if (!tableIsEmpty && armed !== 'clear') return arm('clear');
		disarm();
		clearTable();
	}

	function handleExport() {
		const scenario = getScenario(selectedScenario);
		if (!scenario) return toast.error('Pick a saved scenario first');
		exportScenarioToFile(scenario);
	}

	async function handleOpenScenarioFile(event: Event) {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		if (!file) return;
		try {
			const scenario = importScenarioFromText(await file.text());
			refreshScenarios();
			selectedScenario = scenario.name;
			toast(`Opened scenario: ${scenario.name} — "Load selected" puts it on the table`);
		} catch (error) {
			toast.error(
				`Could not open the scenario: ${error instanceof Error ? error.message : 'invalid file'}`
			);
		} finally {
			input.value = '';
		}
	}

	function clearTable() {
		const s = $gameStore;
		const update: Record<string, Record<string, null>> = {
			cards: {},
			decks: {},
			pieces: {},
			overlays: {},
			snapPoints: {},
			players: {}
		};
		for (const collection of ['cards', 'decks', 'pieces', 'overlays', 'snapPoints'] as const) {
			for (const key of Object.keys(s?.[collection] ?? {})) update[collection][key] = null;
		}
		for (const key of Object.keys(s?.players ?? {})) {
			if (isSeatPlaceholder(key)) update.players[key] = null;
		}
		gameStore.updateState(update as Parameters<typeof gameStore.updateState>[0]);
		imageUrl = '';
	}

	// all decks on the table, any owner (placeholder seats included)
	const deckIds = $derived(
		Object.keys($gameStore?.decks ?? {}).filter((key) => $gameStore?.decks?.[key])
	);

	function setDeckField(deckId: string, patch: Record<string, unknown>) {
		gameStore.updateState({ decks: { [deckId]: patch } });
	}

	// ── one selection, two controls ───────────────────────────────────────────
	// `activeSeat` (what every Seats button acts on) and the Decks tab strip used
	// to be unrelated state 80px apart: the strip could read `seat1 main` while
	// the buttons all said "for seat 0" (#114). They are tied together here —
	// click a tab and the seat follows it, change the seat and the strip jumps to
	// that seat's first deck.
	//
	// The strip's own cursor is an INDEX, which shifts whenever a deck is spawned
	// or deleted, so the deck ID is what's canonical: `deckTabIndex` is only the
	// transport to and from tweakpane, re-derived from the id whenever `deckIds`
	// moves. `synced` remembers what this component last agreed to, which is how
	// the effect below tells WHICH of the three inputs actually changed — two
	// plain effects would fight, and a seat with no decks would have its own
	// selection undone by the tab strip.

	/** owner seat of `deck:<owner>:<slot>`; undefined for a real player's deck */
	function deckSeat(deckId: string | undefined): SeatIndex | undefined {
		const owner = deckId?.split(':')[1];
		return owner && isSeatPlaceholder(owner) ? (Number(owner.slice(4)) as SeatIndex) : undefined;
	}

	function firstDeckForSeat(ids: string[], seat: SeatIndex): string | undefined {
		return ids.find((id) => deckSeat(id) === seat);
	}

	let selectedDeck: string | null = $state(null);
	let deckTabIndex = $state(0);
	let synced = { seat: 0 as number, index: 0, ids: '' };

	/** Move the strip's cursor, recording it so the effect below knows it's ours. */
	function setTabIndex(index: number, ids: string[]) {
		deckTabIndex = index;
		synced = { seat: activeSeat, index, ids: ids.join('\n') };
	}

	/** Point both controls at one deck. The single writer for either cursor. */
	function pointAt(deckId: string | null, ids: string[]) {
		selectedDeck = deckId;
		const seat = deckSeat(deckId ?? undefined);
		if (seat !== undefined) activeSeat = seat;
		setTabIndex(deckId ? Math.max(0, ids.indexOf(deckId)) : 0, ids);
	}

	/**
	 * tweakpane builds a tab page from the child component's `onMount`, one flush
	 * AFTER `deckIds` grows — so an index written in the same flush addresses a
	 * page that doesn't exist yet, and `TabGroup` only re-applies `selectedIndex`
	 * when the NUMBER changes, so it never retries. Park the cursor out of range
	 * (`pages.at()` misses, which is a no-op rather than a selection) and put it
	 * back once the pages are there. Without this the outline on the table and
	 * the tab strip disagree the first time a deck spawns for the far seat.
	 */
	function reassertTab(ids: string[]) {
		const want = deckTabIndex;
		const parked = ids.length;
		setTabIndex(parked, ids);
		tick().then(() => {
			if (deckTabIndex === parked) setTabIndex(want, ids);
		});
	}

	$effect(() => {
		const ids = deckIds;
		const idsKey = ids.join('\n');
		const index = deckTabIndex;
		const seat = activeSeat;

		if (idsKey !== synced.ids) {
			// decks spawned or went away. A deck just spawned FOR the seat being
			// edited is what you want to position next, so it wins; otherwise hold
			// whatever was selected, and only then fall back to the seat's first.
			const before = synced.ids ? synced.ids.split('\n') : [];
			const added = ids.find((id) => !before.includes(id) && deckSeat(id) === seat);
			const keep = selectedDeck && ids.includes(selectedDeck) ? selectedDeck : null;
			pointAt(added ?? keep ?? firstDeckForSeat(ids, seat) ?? ids[0] ?? null, ids);
			if (ids.length) reassertTab(ids);
		} else if (index !== synced.index) {
			// a tab was clicked — the seat follows it
			pointAt(ids[index] ?? null, ids);
		} else if (seat !== synced.seat) {
			// the seat was changed — the strip follows it, when that seat has a deck
			const id = firstDeckForSeat(ids, seat);
			if (id) pointAt(id, ids);
			else synced.seat = seat;
		}
	});

	// publish to the scene, and stop highlighting when the editor goes away
	$effect(() => {
		setSelectedDeck(selectedDeck);
		return () => setSelectedDeck(null);
	});

	// Snap points — authored placement guides. The scene has the direct
	// manipulation (click to place while armed, drag a marker to move,
	// right-click to delete); these are the exact numbers.
	let newRadius = $state(SNAP_RADIUS_DEFAULT);
	let newRotation = $state(0);
	const snapIds = $derived(snapPointIds($gameStore));

	$effect(() => {
		// what a click-placed point gets stamped with
		setSnapDefaults({ radius: newRadius, rotation: newRotation || undefined });
	});

	/** a comma-separated tweakpane text field ↔ a list */
	const splitList = (text: unknown) =>
		String(text ?? '')
			.split(',')
			.map((item) => item.trim())
			.filter(Boolean);
	const snapLabel = (snapId: string) => snapId.replace('snap:', '#');

	// Reach (tableplace-190): how many snap-point links a piece usually
	// travels. Picked from a list rather than by clicking the piece, so the
	// scene's own drag handling stays untouched.
	const pieceIds = $derived(
		Object.keys($gameStore?.pieces ?? {}).filter((id) => $gameStore?.pieces?.[id])
	);
	let reachPiece = $state('');
	const reachPieceId = $derived(pieceIds.includes(reachPiece) ? reachPiece : (pieceIds[0] ?? ''));
	const reachPieceOptions = $derived(
		pieceIds.length
			? Object.fromEntries(
					pieceIds.map((id) => [`${$gameStore?.pieces?.[id]?.name ?? 'piece'} (${id})`, id])
				)
			: { '(no pieces)': '' }
	);
	const reachValue = $derived($gameStore?.pieces?.[reachPieceId]?.reach ?? 0);

	function setReach(value: number | undefined) {
		const next = Math.max(0, Math.round(value ?? 0));
		// switching the picked piece re-emits its value; only a real edit is a patch
		if (!reachPieceId || next === reachValue) return;
		gameActions.setPieceReach(reachPieceId, next);
	}

	function addSnapPoint() {
		gameActions.addSnapPoint({
			position: [0, 0],
			radius: newRadius,
			rotation: newRotation || undefined
		});
	}

	/**
	 * Switch one point between a discrete spot and a grid. Turning grid on
	 * stamps workable lattice defaults (keeping any the point already had);
	 * turning it off nulls the grid fields so a re-save doesn't carry ghosts.
	 * `undefined` here means "delete the field" — see updateSnapPoint.
	 */
	function setSnapGrid(snapId: string, grid: boolean) {
		const point = $gameStore?.snapPoints?.[snapId];
		if (grid) {
			gameActions.updateSnapPoint(snapId, {
				kind: 'grid',
				pitch: point?.pitch ?? SNAP_GRID_PITCH_DEFAULT,
				cols: point?.cols ?? SNAP_GRID_COLS_DEFAULT,
				rows: point?.rows ?? SNAP_GRID_ROWS_DEFAULT
			});
		} else {
			gameActions.updateSnapPoint(snapId, {
				kind: undefined,
				pitch: undefined,
				cols: undefined,
				rows: undefined,
				yawStep: undefined
			});
		}
	}

	// overlay controls — same shape as the /play settings pane
	let rot = $state(0);
	let scale = $state($gameStore?.overlays?.table?.scale ?? 12);
	let point3d = $state({ x: 0, y: 0 });
	let imageUrl = $state($gameStore?.overlays?.table?.imageUrl ?? '');

	$effect(() => {
		const _imageUrl = imageUrl === '' ? undefined : imageUrl;
		gameStore.updateState({
			overlays: {
				table: purgeUndefinedValues({
					imageUrl: _imageUrl,
					rotation: [0, rot * DEG2RAD, 0],
					position: [point3d.x, 0.255, point3d.y],
					scale
				}) as NonNullable<GameDTO['overlays']>[string]
			}
		});
	});
</script>

<Pane
	position="draggable"
	title="Scenario Setup (local)"
	expanded={true}
	y={0}
	x={0}
	width={320}
	localStoreId="setup-pane-v2"
>
	<Folder title="Seats" expanded={true}>
		<List label="Editing seat" bind:value={activeSeat} options={seatOptions} />
		<Button
			title="Spawn {STANDARD_52.name} for seat {activeSeat}"
			on:click={handleSpawnStandard52}
		/>
		<!-- the import-a-pack-into-a-scenario entry point: open once, then spawn
		     the same pack for any seat without going back to the file -->
		<PackLibrary
			ownerId={seatPlaceholderId(activeSeat)}
			spawnTitle="Spawn selected for seat {activeSeat}"
			beforeSpawn={() => ensureSeatPlaceholder(activeSeat)}
		/>
		<Button
			title={isImporting ? 'Opening…' : `Open a TTS deck (.json) for seat ${activeSeat}`}
			disabled={isImporting}
			on:click={() => deckFileInput?.click()}
		/>
		<Button title="View table from seat {activeSeat}" on:click={viewFromSeat} />
		<Element>
			<input
				bind:this={deckFileInput}
				type="file"
				accept=".json,application/json"
				class="hidden"
				onchange={handleImportDeck}
			/>
		</Element>
	</Folder>
	{#if deckIds.length > 0}
		<Folder title="Decks" expanded={true}>
			<TabGroup bind:selectedIndex={deckTabIndex}>
				{#each deckIds as deckId (deckId)}
					{@const deck = $gameStore?.decks?.[deckId]}
					{@const position = deck?.position ?? [0, 0.4, 0]}
					{@const rotY = (deck?.rotation?.[1] ?? 0) / DEG2RAD}
					<TabPage title={deckId.split(':').slice(1).join(' ')}>
						<Point
							label="position"
							value={[position[0], position[2]]}
							on:change={(e) => {
								//@ts-expect-error: does exist
								const x = e.detail.value?.x ?? position[0];
								//@ts-expect-error: does exist
								const z = e.detail.value?.y ?? position[2];
								setDeckField(deckId, { position: [x, position[1], z] });
							}}
						/>
						<Wheel
							label="rotation"
							value={rotY}
							format={(v) => `${(((v % 360) + 360) % 360).toFixed(0)}°`}
							on:change={(e) =>
								setDeckField(deckId, {
									rotation: [0, (e.detail.value ?? 0) * DEG2RAD, 0]
								})}
						/>
						<Checkbox
							label="face up"
							value={deck?.isFaceUp ?? false}
							on:change={(e) => setDeckField(deckId, { isFaceUp: !!e.detail.value })}
						/>
						{#if deck?.packOrigin}
							<Checkbox
								label="shuffle on load"
								value={deck?.shuffleOnLoad ?? false}
								on:change={(e) => setDeckField(deckId, { shuffleOnLoad: !!e.detail.value })}
							/>
						{/if}
					</TabPage>
				{/each}
			</TabGroup>
		</Folder>
	{/if}
	<HUDPieces
		ownerId={seatPlaceholderId(activeSeat)}
		beforeSpawn={() => ensureSeatPlaceholder(activeSeat)}
	/>
	<Folder title="Snap points" expanded={false}>
		<Checkbox
			label="place on click"
			value={$snapEditor.placing}
			on:change={(e) => setSnapPlacing(!!e.detail.value)}
		/>
		<Slider label="new radius" bind:value={newRadius} min={0.2} max={6} step={0.1} />
		<Wheel
			label="new rotation"
			bind:value={newRotation}
			format={(v) => (v === 0 ? 'none' : `${(((v % 360) + 360) % 360).toFixed(0)}°`)}
		/>
		<Button title="Add at table centre" on:click={addSnapPoint} />
		<!-- links: an optional board graph. Armed, a click on a marker picks it
		     and a click on a second one draws or removes the link between them -->
		<Checkbox
			label="draw links"
			value={!!$snapEditor.linking}
			on:change={(e) => setSnapLinking(!!e.detail.value)}
		/>
		<Button title="Clear all links" on:click={() => gameActions.clearSnapLinks()} />
		{#if snapIds.length > 0}
			<TabGroup>
				{#each snapIds as snapId (snapId)}
					{@const point = $gameStore?.snapPoints?.[snapId]}
					{@const position = point?.position ?? [0, 0]}
					<TabPage title={snapLabel(snapId)}>
						<Point
							label="position"
							value={[position[0], position[1]]}
							on:change={(e) => {
								//@ts-expect-error: does exist
								const x = e.detail.value?.x ?? position[0];
								//@ts-expect-error: does exist
								const z = e.detail.value?.y ?? position[1];
								gameActions.moveSnapPoint(snapId, [x, z]);
							}}
						/>
						<Slider
							label="radius"
							value={point?.radius ?? SNAP_RADIUS_DEFAULT}
							min={0.2}
							max={6}
							step={0.1}
							on:change={(e) =>
								gameActions.updateSnapPoint(snapId, { radius: e.detail.value ?? undefined })}
						/>
						<Wheel
							label="rotation"
							value={point?.rotation ?? 0}
							format={(v) => (v === 0 ? 'none' : `${(((v % 360) + 360) % 360).toFixed(0)}°`)}
							on:change={(e) =>
								gameActions.updateSnapPoint(snapId, {
									// 0 means "no authored yaw": a snap point that turns a card to
									// 0° and one that leaves it alone are different things, and
									// the wheel has no third state to say so. Harmless on a grid,
									// where the rotation is the lattice yaw and "none" IS 0°.
									rotation: e.detail.value ? e.detail.value : undefined
								})}
						/>
						<Slider
							label="elevation (y)"
							value={point?.y ?? 0}
							min={0}
							max={8}
							step={0.05}
							on:change={(e) =>
								gameActions.updateSnapPoint(snapId, {
									// 0 = back on the felt; an authored floor at exactly 0 would
									// sit below the table top, so the sentinel costs nothing
									y: e.detail.value ? e.detail.value : undefined
								})}
						/>
						<!-- grid sub-flow: blades are ADDED under the checkbox, never
						     swapped in place of it — replacing a blade tears the pane down -->
						<Checkbox
							label="grid"
							value={point?.kind === 'grid'}
							on:change={(e) => setSnapGrid(snapId, !!e.detail.value)}
						/>
						{#if point?.kind === 'grid'}
							<Slider
								label="pitch"
								value={point?.pitch ?? SNAP_GRID_PITCH_DEFAULT}
								min={0.5}
								max={8}
								step={0.1}
								on:change={(e) =>
									gameActions.updateSnapPoint(snapId, {
										pitch: e.detail.value ?? SNAP_GRID_PITCH_DEFAULT
									})}
							/>
							<Slider
								label="cols"
								value={point?.cols ?? SNAP_GRID_COLS_DEFAULT}
								min={1}
								max={20}
								step={1}
								on:change={(e) =>
									gameActions.updateSnapPoint(snapId, {
										cols: Math.round(e.detail.value ?? SNAP_GRID_COLS_DEFAULT)
									})}
							/>
							<Slider
								label="rows"
								value={point?.rows ?? SNAP_GRID_ROWS_DEFAULT}
								min={1}
								max={20}
								step={1}
								on:change={(e) =>
									gameActions.updateSnapPoint(snapId, {
										rows: Math.round(e.detail.value ?? SNAP_GRID_ROWS_DEFAULT)
									})}
							/>
							<Slider
								label="yaw step"
								value={point?.yawStep ?? SNAP_GRID_YAW_STEP_DEFAULT}
								min={15}
								max={180}
								step={15}
								on:change={(e) =>
									gameActions.updateSnapPoint(snapId, {
										yawStep: e.detail.value ?? SNAP_GRID_YAW_STEP_DEFAULT
									})}
							/>
						{/if}
						<Text
							label="links"
							value={(point?.links ?? []).map(snapLabel).join(', ') || 'none'}
							disabled
						/>
						<Text
							label="tags"
							value={(point?.tags ?? []).join(', ')}
							on:change={(e) => {
								const tags = splitList(e.detail.value);
								if (tags.join(',') !== (point?.tags ?? []).join(',')) {
									gameActions.setSnapTags(snapId, tags);
								}
							}}
						/>
						<Button
							title="Delete this point"
							on:click={() => gameActions.removeSnapPoint(snapId)}
						/>
					</TabPage>
				{/each}
			</TabGroup>
		{/if}
	</Folder>
	<Folder title="Piece reach" expanded={false}>
		<List label="piece" bind:value={reachPiece} options={reachPieceOptions} />
		<Stepper
			label="reach (links)"
			value={reachValue}
			min={0}
			step={1}
			on:change={(e) => setReach(e.detail.value)}
		/>
	</Folder>
	<Folder title="Overlay (map)" expanded={false}>
		<Text label="Image URL" bind:value={imageUrl}></Text>
		<Point bind:value={point3d} label="Position" />
		<AutoValue label="Scale" bind:value={scale} />
		<Wheel label="Rotation" bind:value={rot} format={(v) => `${(Math.abs(v) % 360).toFixed(0)}°`} />
	</Folder>
	<Folder title="Save / Load" expanded={true}>
		<Text label="Name" bind:value={scenarioName} />
		<Button title="Save scenario" on:click={handleSave} />
		<List label="Saved" bind:value={selectedScenario} options={scenarioOptions} />
		<Button title="Load selected" on:click={handleLoad} />
		<Button title="Export selected (.tbps.json)" on:click={handleExport} />
		<Button title="Open a scenario (.tbps.json)" on:click={() => scenarioFileInput?.click()} />
		<Button
			title={armed === 'delete' ? `Really delete "${selectedScenario}"?` : 'Delete selected'}
			on:click={handleDelete}
		/>
		{#if armed === 'delete'}
			<Button title="Keep it" on:click={disarm} />
		{/if}
		<Element>
			<input
				bind:this={scenarioFileInput}
				type="file"
				accept=".json,application/json"
				class="hidden"
				onchange={handleOpenScenarioFile}
			/>
		</Element>
	</Folder>
	<Button
		title={armed === 'clear' ? 'Really clear the whole table?' : 'Clear table'}
		on:click={handleClearTable}
	/>
	{#if armed === 'clear'}
		<Button title="Leave it alone" on:click={disarm} />
	{/if}

	<!--
		Prose, not a disabled `Textarea` (#115): six rows of dense explanation in a
		scroll box reads as a broken field, can't wrap to the pane and can't be
		selected. One always-mounted blade inside a folder that is closed by
		default — the pane is already the tallest thing on the route, and this is
		reference you read once. See the swap hazard in `BulkSheet.svelte:135-140`:
		adding a folder is fine, replacing a blade is not.
	-->
	<Folder title="How this works" expanded={false}>
		<PaneProse>
			<!--
				Bounded and scrolled inside itself (`max-h-64`, as `BulkSheet` bounds
				its grid): this folder is the last thing in the tallest pane on the
				route and a draggable tweakpane doesn't scroll, so an unbounded block
				would put its own tail under the bottom of the viewport — the exact
				failure #115 is about. Prose that scrolls is still prose; it wraps to
				the pane and can be selected.
			-->
			<div
				class="flex max-h-64 flex-col gap-2 overflow-y-auto p-1 font-sans text-[11px] leading-snug text-white/50"
			>
				<p>
					Everything here is local — no lobby is touched. Open a pack (or drop a
					<code class="font-mono text-white/65">.tbpp.json</code> on the table) and it joins your pack
					library, ready to spawn for any seat without picking the file again. Place the map, arrange,
					then Save.
				</p>
				<p>
					Pack decks save as a pack reference plus their card order, so a stacked deck reloads
					exactly; tick <em class="text-white/65 not-italic">shuffle on load</em> for a draw pile.
				</p>
				<p>
					<span class="text-white/65">Snap points:</span> arm
					<em class="text-white/65 not-italic">place on click</em> and click the felt, drag a ring
					to move it, right-click it to delete. They ride along in the scenario and pull dropped
					cards/tokens onto themselves in /play (hold Alt on release to ignore them); the rings only
					show here. A point can raise its floor (<em class="text-white/65 not-italic">elevation</em
					>) or become a
					<em class="text-white/65 not-italic">grid</em> of square cells that drops pull onto, cell by
					cell.
				</p>
				<p>
					Your library lives in this browser only — share a pack by exporting its
					<code class="font-mono text-white/65">.tbpp.json</code>. Seed a lobby from /play →
					Settings → Scenarios.
				</p>
				<p class="text-white/65">
					Note: cards in your hand tray are not saved — keep starting cards on the table.
				</p>
			</div>
		</PaneProse>
	</Folder>
</Pane>

<FileDropZone onfile={handleDroppedFile} />
