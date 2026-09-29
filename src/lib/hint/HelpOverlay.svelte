<script lang="ts">
	import { verbReference } from '$lib/verbs/registry';
	import { helpOpen, toggleHelp } from './hintUi';

	/**
	 * The `?` reference: every verb in the registry with its key or gesture,
	 * grouped by what it acts on. Generated, never hand-written — a verb added
	 * to the registry shows up here with no edit to this file.
	 */
	const SECTIONS = verbReference();

	// Esc closes it. Never preventDefault — the same Esc still reaches
	// TableScene's drag cancel if a drag is live.
	function onKeyDown(event: KeyboardEvent) {
		if ($helpOpen && event.key === 'Escape') toggleHelp(false);
	}
</script>

<svelte:window onkeydown={onKeyDown} />

{#if $helpOpen}
	<!-- the scrim closes it on a click; the key closes it too, so no role is lost -->
	<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
	<div
		class="fixed inset-0 z-40 flex items-start justify-center overflow-auto bg-black/40 p-4 pt-16"
		onclick={(event) => event.target === event.currentTarget && toggleHelp(false)}
	>
		<div
			data-testid="verb-reference"
			role="dialog"
			aria-modal="true"
			aria-label="Every verb on the table"
			class="w-full max-w-2xl rounded-lg bg-neutral-900/95 p-4 font-sans text-sm text-white/80 shadow-xl"
		>
			<header class="mb-3 flex items-center justify-between gap-3">
				<b class="text-base font-semibold text-white">Every verb on the table</b>
				<button
					class="rounded border border-white/20 px-2 py-0.5 text-xs text-white/70 hover:bg-white/10"
					onclick={() => toggleHelp(false)}
				>
					Close <kbd class="font-mono">Esc</kbd>
				</button>
			</header>
			<div class="grid grid-cols-[repeat(auto-fit,minmax(240px,1fr))] gap-x-6 gap-y-3">
				{#each SECTIONS as section (section.title)}
					<section>
						<h3 class="mb-1 text-xs tracking-widest text-white/40 uppercase">{section.title}</h3>
						<dl class="grid grid-cols-[1fr_auto] gap-x-3 gap-y-0.5 text-xs">
							{#each section.rows as row, i (i)}
								<dt class="text-white/60">{row.action}</dt>
								<dd class="justify-self-end font-mono text-white/90">{row.key}</dd>
							{/each}
						</dl>
					</section>
				{/each}
			</div>
		</div>
	</div>
{/if}
