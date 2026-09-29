<script lang="ts">
	import { gameStore } from '$lib/store/game/gameStore.svelte';
	import PaneProse from '$lib/tweakpane/PaneProse.svelte';
	import {
		Button,
		Checkbox,
		Pane,
		Point,
		Wheel,
		Text,
		AutoValue,
		Folder,
		FpsGraph,
		Monitor,
		Slider
	} from 'svelte-tweakpane-ui';
	import { environmentIntensity } from '$lib/store/environment';
	import { DEG2RAD } from 'three/src/math/MathUtils.js';
	import { purgeUndefinedValues } from '$lib/utils/transforms/data';
	import type { GameDTO } from '$lib/store/game/types';
	import { gameActions } from '$lib/store/game/actions';
	import { keybindReference } from '$lib/verbs/registry';
	import { hintBarEnabled } from '$lib/hint/hintUi';
	import { weightEnabled } from '$lib/utils/weight.svelte';
	import { soundEnabled } from '$lib/sound';
	import { classicMouse } from '$lib/store/mouseMode';
	import { connectionStore } from '$lib/store/connectionStore.svelte';
	import {
		listScenarios,
		getScenario,
		applyScenario,
		claimSeat,
		isSeatPlaceholder,
		type SeatIndex
	} from '$lib/scenario/scenario';
	import { buildInviteUrl, pickInviteSeat } from '$lib/scenario/invite';
	import { List } from 'svelte-tweakpane-ui';
	import HUDPieces from '$lib/HUDPieces.svelte';
	import { page } from '$app/state';
	import { goto } from '$app/navigation';
	import toast from 'svelte-french-toast';

	function clearOverlay() {
		gameStore.updateState({ overlays: { table: null } });
		imageUrl = '';
	}

	let rot = $state(0);
	// world height of the overlay in table units (plane is aspect-normalized)
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

	let lobbyId = $state(page.url.searchParams.get('lobby') ?? '');
	// /play with no ?lobby rolls a name and replaceState()s it in after this pane
	// has already mounted — adopt it so the share link isn't empty
	$effect(() => {
		const fromUrl = page.url.searchParams.get('lobby');
		if (fromUrl && !lobbyId) lobbyId = fromUrl;
	});
	const lobbyUrl = $derived(
		new URLSearchParams({ server: $connectionStore.serverUrl, lobby: lobbyId }).toString()
	);

	// scenario presets (built at /setup, stored in localStorage)
	let selectedScenario = $state(listScenarios()[0]?.name ?? '');
	let scenarioNames = $state(listScenarios().map((s) => s.name));
	const scenarioOptions = $derived(
		scenarioNames.length
			? Object.fromEntries(scenarioNames.map((n) => [n, n]))
			: { '(none — build one at /setup)': '' }
	);
	// An empty table's most useful control is the one that fills it, so Scenarios
	// opens itself until there are decks and then gets out of the way. `expanded`
	// is a plain reactive prop on Folder, so this needs no manual toggling.
	const isTableEmpty = $derived(Object.keys($gameStore?.decks ?? {}).length === 0);

	// unclaimed placeholder seats present in the synced state
	const openSeats = $derived(
		Object.keys($gameStore?.players ?? {})
			.filter(isSeatPlaceholder)
			.map((id) => Number(id.slice(4)) as SeatIndex)
			.sort()
	);

	async function seedLobby() {
		const scenario = getScenario(selectedScenario);
		if (!scenario) return toast.error('No preset selected — build one at /setup');
		const report = await applyScenario(scenario);
		// a pack the preset needs and this browser doesn't have (someone else's
		// local pack, a dead url) has to be visible here too — the table would
		// otherwise come up quietly missing that content
		for (const { id, reason } of report.failedPacks) {
			toast.error(`Pack '${id}' failed to load: ${reason}`, { duration: 6000 });
		}
		toast('Lobby seeded — everyone claim a seat to take its decks');
	}

	function handleClaimSeat(seat: SeatIndex) {
		if (claimSeat(seat)) toast(`You claimed seat ${seat}`);
		else toast.error(`Seat ${seat} is no longer open`);
	}

	// invite link that auto-claims the opposing (first open, non-mine) seat on
	// join; without open seats it degrades to a plain lobby link
	function copyInvite() {
		const inviteSeat = pickInviteSeat(openSeats, gameActions.getMySeat());
		const url = buildInviteUrl({
			origin: page.url.origin,
			server: $connectionStore.serverUrl,
			lobby: lobbyId,
			seat: inviteSeat
		});
		navigator.clipboard.writeText(url);
		toast(
			inviteSeat === undefined
				? `Copied lobby link (no open seats): ${url}`
				: `Copied invite — joiner auto-claims seat ${inviteSeat}`
		);
	}

	// The reference card (#115), generated from the verb registry so a binding
	// and its label can never disagree again (#113). Ordered as you meet them:
	// the wheel, the camera, one card, a pile, a piece, then the drag modifiers.
	const KEYBINDS = keybindReference();
</script>

<Pane
	position="draggable"
	title="Settings"
	expanded={true}
	width={300}
	y={0}
	x={0}
	localStoreId="table-settings"
>
	<Folder title="Connection" expanded={false}>
		<!-- read-only value, so a `Monitor` rather than an input that refuses you (#115) -->
		<Monitor label="My ID" value={localStorage.getItem('myPlayerId') ?? ''} />
		<Text label="Server:" bind:value={$connectionStore.serverUrl} />
		<Text label="Lobby:" bind:value={lobbyId} />
		<Button
			title="Share lobby: {lobbyId}"
			on:click={() => {
				// copy an invite that seats the joiner; my own navigation must NOT
				// carry ?seat= or I'd claim the seat meant for the opponent
				copyInvite();
				goto(`/play?${lobbyUrl}`, { invalidateAll: true });
			}}
		/>
		<PaneProse>
			<div class="p-1 font-sans text-[11px] leading-snug text-white/50">
				Share copies an invite link — whoever opens it is seated at the first open seat and gets its
				decks.
			</div>
		</PaneProse>
	</Folder>
	<Folder title="Scenarios" expanded={isTableEmpty}>
		<List label="Preset" bind:value={selectedScenario} options={scenarioOptions} />
		<Button title="Seed lobby with preset" on:click={seedLobby} />
		<Button
			title="Refresh preset list"
			on:click={() => (scenarioNames = listScenarios().map((s) => s.name))}
		/>
		{#each openSeats as seat (seat)}
			<Button title="Claim seat {seat}" on:click={() => handleClaimSeat(seat)} />
		{/each}
		<Button title="Copy opponent invite" on:click={copyInvite} />
		<!--
			Always mounted, after the `{#each}` above: a blade computes its index from
			its own DOM position when it is created, so seats appearing and vanishing
			insert around this rather than displacing it.
		-->
		<PaneProse>
			<div class="p-1 font-sans text-[11px] leading-snug text-white/50">
				Build presets at /setup. Seeding replaces the table for the whole lobby; each player then
				claims a seat to take over its decks.
			</div>
		</PaneProse>
	</Folder>
	<HUDPieces ownerId={gameActions.getMyId() ?? undefined} />
	<Folder title="Overlays" expanded={false}>
		<Button title="Clear overlay" on:click={clearOverlay} />
		<Text label="Image URL" bind:value={imageUrl}></Text>
		<Point bind:value={point3d} label="Position" />
		<AutoValue label="Scale" bind:value={scale} />
		<Wheel label="Rotation" bind:value={rot} format={(v) => `${(Math.abs(v) % 360).toFixed(0)}°`} />
	</Folder>
	<Folder title="Keybinds" expanded={false}>
		<Button
			on:click={() => gameActions?.setSeat()}
			label="Seat: {$gameStore?.players?.[gameActions?.getMe()?.id ?? 0]?.seat}"
			title="Next Seat"
		/>
		<!-- the bottom-left line naming what the pointer can do; on by default -->
		<Checkbox label="Hint bar" bind:value={$hintBarEnabled} />
		<!-- lean, landing bounce and flip hop (tableplace-203); always off under
		     prefers-reduced-motion, whatever this says -->
		<Checkbox label="Weight" bind:value={$weightEnabled} />
		<!-- table sounds (tableplace-204); the same switch as the speaker on the table -->
		<Checkbox label="Sound" bind:value={$soundEnabled} />
		<!-- tableplace-202 moved orbit to right-drag so left-drag on the felt can
		     box-select; this puts the old mapping back, for one release -->
		<Checkbox label="Classic mouse" bind:value={$classicMouse} />
		<!--
			One prose blade where eleven disabled `Text` blades used to be (#115): a
			keybind is something you read, not a field you were locked out of, and
			the list now costs one row of the pane's height instead of eleven. The
			folder stays closed by default — #113.
		-->
		<PaneProse>
			<dl
				class="grid grid-cols-[1fr_auto] items-baseline gap-x-3 gap-y-0.5 p-1 font-sans text-[11px] leading-snug"
			>
				{#each KEYBINDS as { action, key } (action)}
					<dt class="text-white/50">{action}</dt>
					<dd class="justify-self-end font-mono text-white/80">{key}</dd>
				{/each}
			</dl>
		</PaneProse>
	</Folder>
	<!-- instrumentation, not settings: out of the player's way until asked for -->
	<Folder title="Debug" expanded={false}>
		<FpsGraph />
		<Slider label="Env light" bind:value={$environmentIntensity} min={0} max={2} step={0.05} />
	</Folder>
</Pane>
