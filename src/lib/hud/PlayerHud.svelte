<script lang="ts">
	/**
	 * Overlay listing who is at the table: seat, hand size, deck counts, and
	 * which seats are still open. Open-seat rows are the primary claim
	 * affordance — clicking one sits you there and hands you its decks.
	 * Counts only — another player's card faces/ids are never rendered.
	 *
	 * Plain DOM (not svelte-tweakpane-ui) since this is player-facing game
	 * info, and anchored top-right so it clears the Settings (x=0) and Decks
	 * (x=310) panes.
	 */
	import { gameActions } from '$lib/store/game/actions';
	import { gameStore } from '$lib/store/game/gameStore.svelte';
	import { claimSeat, type SeatIndex } from '$lib/scenario/scenario';
	import { derivePlayerRows, summarize, type DeckCount } from './players';
	import toast from 'svelte-french-toast';

	/** `main 34 · discard 6` */
	const deckLine = (decks: DeckCount[]) => decks.map((d) => `${d.slot} ${d.count}`).join(' · ');

	const COLLAPSE_KEY = 'hud:players:collapsed';

	// getMyId() reads localStorage, which is only written once the websocket
	// init creates a player — re-read it whenever the store changes so a
	// first-time visitor's own row still gets marked
	const rows = $derived(derivePlayerRows($gameStore, gameActions.getMyId() ?? undefined));
	const summary = $derived(summarize(rows));

	let collapsed = $state(readCollapsed());

	function readCollapsed() {
		try {
			return localStorage.getItem(COLLAPSE_KEY) === 'true';
		} catch {
			return false;
		}
	}

	function toggle() {
		collapsed = !collapsed;
		try {
			localStorage.setItem(COLLAPSE_KEY, String(collapsed));
		} catch {
			// private mode / storage disabled — collapse still works for this session
		}
	}

	function handleClaimSeat(seat: number) {
		if (claimSeat(seat as SeatIndex)) toast(`Seat ${seat} claimed — your decks are ready`);
		else toast.error(`Seat ${seat} is no longer open`);
	}
</script>

<!-- wrapper is click-through so cards can still be dragged underneath -->
<div class="pointer-events-none fixed top-2 right-2 z-50 font-sans">
	<div
		class="pointer-events-auto w-64 rounded-md border border-white/10 bg-gray-900/80 text-white shadow-lg backdrop-blur-sm"
	>
		<button
			type="button"
			onclick={toggle}
			class="flex w-full items-center justify-between gap-2 px-3 py-2 text-left text-xs tracking-wide uppercase opacity-70 hover:opacity-100"
			aria-expanded={!collapsed}
		>
			<span>Players</span>
			<span class="flex items-center gap-2 normal-case opacity-80">
				{summary}
				<span class="text-[0.6rem]">{collapsed ? '▸' : '▾'}</span>
			</span>
		</button>

		{#if !collapsed}
			<ul class="max-h-[70vh] overflow-y-auto border-t border-white/10">
				{#if rows.length === 0}
					<li class="px-3 py-2 text-xs opacity-50">Nobody at the table yet</li>
				{/if}
				{#each rows as row (row.id)}
					{#snippet seatBadge()}
						<span
							class={[
								'mt-0.5 flex h-6 w-6 shrink-0 flex-col items-center justify-center rounded',
								row.isOpenSeat ? 'border border-dashed border-white/30' : 'bg-white/10'
							]}
							title="seat {row.seat} — {row.rotationDeg}°"
						>
							<span class="text-[0.65rem] leading-none font-bold">{row.seat}</span>
							<span class="text-[0.5rem] leading-none opacity-60">{row.rotationDeg}°</span>
						</span>
					{/snippet}
					<li
						class={[
							'border-b border-white/5 text-xs last:border-b-0',
							!row.isOpenSeat && 'flex gap-2 px-3 py-2',
							row.isMe && 'bg-emerald-400/10'
						]}
						data-open-seat={row.isOpenSeat}
					>
						{#if row.isOpenSeat}
							<!-- an open seat is claimable: sit here and take over its decks -->
							<button
								type="button"
								onclick={() => handleClaimSeat(row.seat)}
								class="flex w-full gap-2 px-3 py-2 text-left opacity-50 hover:bg-white/10 hover:opacity-100"
							>
								{@render seatBadge()}
								<span class="min-w-0 flex-1">
									<span class="block italic">Seat {row.seat} — open</span>
									{#if row.handCount > 0}
										<span class="block opacity-70">hand {row.handCount}</span>
									{/if}
									{#if row.decks.length > 0}
										<span class="block opacity-70">{deckLine(row.decks)}</span>
									{/if}
									<span class="block text-[0.6rem] text-emerald-300 uppercase">
										click to sit here
									</span>
								</span>
							</button>
						{:else}
							{@render seatBadge()}
							<span class="min-w-0 flex-1">
								<span class="flex items-baseline gap-1">
									<!-- presence dot: green = connected; hollow = offline or unknown
									     (a client that never got a presence patch must not show green) -->
									<span
										class={[
											'h-2 w-2 shrink-0 self-center rounded-full',
											row.connected ? 'bg-emerald-400' : 'border border-white/40 opacity-60'
										]}
										data-connected={row.connected}
										title={row.connected ? 'online' : 'offline'}
									></span>
									<span class="truncate font-medium" title={row.id}>{row.id}</span>
									{#if row.isMe}
										<span class="shrink-0 text-[0.6rem] text-emerald-300 uppercase">you</span>
									{/if}
								</span>
								<span class="block opacity-70">
									hand {row.handCount}{#if row.tableCount > 0}&nbsp;· table {row.tableCount}{/if}
								</span>
								{#if row.decks.length > 0}
									<span class="block opacity-70">{deckLine(row.decks)}</span>
								{/if}
							</span>
						{/if}
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>
