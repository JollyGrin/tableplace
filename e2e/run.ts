/**
 * The headless render harness's entry point: `bun run test:e2e`.
 *
 * Why this exists at all — #102 shipped to production through 457 green unit
 * tests, a clean `svelte-check` and a clean build, because jsdom never executes
 * three.js geometry or a raycast. Everything under `e2e/` runs in a real
 * (software-rendered) browser so that class of failure has somewhere to be
 * caught.
 *
 * Deliberately not vitest: vitest's environment here is jsdom, and a second
 * project config that shells out to a browser would be more moving parts than
 * a 60-line runner.
 *
 *   bun run test:e2e                    # everything
 *   bun run test:e2e freeze             # specs whose name contains "freeze"
 *   E2E_HEADED=1 E2E_VERBOSE=1 …        # watch it, with server logs
 */

import { launchBrowser } from './browser';
import { startServers } from './servers';
import { SPECS, type Spec } from './specs';

async function main() {
	const filter = process.argv[2];
	const specs: Spec[] = SPECS.filter((spec) => !filter || spec.name.includes(filter));
	if (!specs.length) {
		console.error(`No spec matches ${JSON.stringify(filter)}`);
		process.exit(1);
	}

	console.log('▸ starting vite dev + Go relay…');
	const servers = await startServers();
	console.log(`  web ${servers.web}   relay ${servers.relay}`);

	let failed = 0;
	for (const spec of specs) {
		const started = Date.now();
		// A BROWSER PER SPEC, not one for the run.
		//
		// Every table here draws through SwiftShader, and a software rasteriser's
		// cost does not go away when the page that made it closes: run twenty-odd
		// specs through one Chrome and the last ones are starting behind everything
		// the earlier ones left in the GPU process. That is not a hypothesis — the
		// suite reached a length where identical two-client specs passed in the
		// middle and timed out waiting for the bridge at the end, on the same
		// commit, while a spec between them took five minutes to do thirty seconds
		// of work. A spec's result has to mean something about the spec, not about
		// its position in the list, and a launch is a couple of seconds against
		// runs that are minutes each.
		const browser = await launchBrowser();
		try {
			await spec.run({ browser, servers });
			console.log(`  ✓ ${spec.name} (${Date.now() - started}ms)`);
		} catch (error) {
			failed++;
			console.log(`  ✗ ${spec.name} (${Date.now() - started}ms)`);
			console.log(
				String((error as Error)?.stack ?? error)
					.split('\n')
					.map((line) => `      ${line}`)
					.join('\n')
			);
		} finally {
			await browser.close().catch(() => {});
		}
	}

	await servers.stop();

	console.log(failed ? `\n${failed}/${specs.length} failed` : `\n${specs.length} passed`);
	process.exit(failed ? 1 : 0);
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
