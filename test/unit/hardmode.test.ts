import {network} from 'hardhat';
import {expect} from 'chai';
import {loadFixture} from '@nomicfoundation/hardhat-network-helpers';
import {DEXES} from '../shared/dexes';
import {ExecutorMode, RouterMode, Stack, armArbitrage, createPool, events, fixtureFor, revertData, swap} from '../shared/stack';

const BUDGET = 2_000_000;
const AMOUNT = 10n ** 15n;

for (const dex of DEXES) {
	describe(`${dex.hookName}: hard mode`, () => {
		const setup = () => loadFixture(fixtureFor(dex));

		/// pool with an armed arbitrage and a 2M gas budget; `base` = gas of the same swap without a backrun
		async function prepare(s: Stack, opts: {hard: boolean; router?: RouterMode; executor?: ExecutorMode}) {
			const pool = await createPool(s, 10);
			const snapshot = await network.provider.send('evm_snapshot', []);
			const base = Number((await swap(s, pool, true, {amount: AMOUNT})).gasUsed);
			await network.provider.send('evm_revert', [snapshot]);
			await armArbitrage(s, pool, true, {mode: opts.executor});
			await (await s.mevxRouter.setModes(RouterMode.Normal, RouterMode.Normal, opts.router ?? RouterMode.Normal)).wait();
			await (await s.hook.setCallGasBudget(pool.poolId, BUDGET)).wait();
			await (await s.hook.setHardMode(pool.poolId, opts.hard)).wait();
			return {pool, base};
		}

		/// outcome of the user swap with gasLimit = base + share of the budget
		async function outcome(s: Stack, pool: any, base: number, share: number): Promise<'revert' | 'backrun' | 'noBackrun'> {
			const snapshot = await network.provider.send('evm_snapshot', []);
			try {
				const r = await swap(s, pool, true, {amount: AMOUNT, gasLimit: Math.floor(base + BUDGET * share)});
				return events(s.hook, r, 'ProfitShared').length ? 'backrun' : 'noBackrun';
			} catch (e: any) {
				// the pool manager wraps the hook's revert reason
				expect(String(e.data ?? e.error?.data ?? '')).to.include(revertData('Insufficient gas for afterSwap hook'));
				return 'revert';
			} finally {
				await network.provider.send('evm_revert', [snapshot]);
			}
		}

		it('backruns as in soft mode when the transaction has the gas', async () => {
			const s = await setup();
			const {pool, base} = await prepare(s, {hard: true});
			expect(await outcome(s, pool, base, 1.5)).to.equal('backrun');
		});

		it('a backrun that burns its gas because the transaction left it short of its budget reverts the swap', async () => {
			const s = await setup();
			const {pool, base} = await prepare(s, {hard: true, router: RouterMode.BurnGas});
			for (const share of [0.3, 0.6, 0.9, 1.0]) expect(await outcome(s, pool, base, share), `${share}`).to.equal('revert');
		});

		it('an executor that burns its gas short of the budget reverts the swap too', async () => {
			const s = await setup();
			const {pool, base} = await prepare(s, {hard: true, executor: ExecutorMode.BurnGas});
			expect(await outcome(s, pool, base, 0.6)).to.equal('revert');
		});

		it('a backrun that burns its whole budget with the budget available does not revert the swap', async () => {
			const s = await setup();
			const {pool, base} = await prepare(s, {hard: true, router: RouterMode.BurnGas});
			for (const share of [1.1, 1.5, 3]) expect(await outcome(s, pool, base, share), `${share}`).to.equal('noBackrun');
		});

		it('a backrun that fails without burning its gas does not revert the swap, whatever the gas', async () => {
			const s = await setup();
			const {pool, base} = await prepare(s, {hard: true, router: RouterMode.Revert});
			for (const share of [0.05, 0.3, 0.6, 1.0]) expect(await outcome(s, pool, base, share), `${share}`).to.equal('noBackrun');
		});

		it('soft mode: the same short swaps go through without the backrun', async () => {
			const s = await setup();
			const {pool, base} = await prepare(s, {hard: false, router: RouterMode.BurnGas});
			for (const share of [0.6, 0.9, 1.0, 1.5]) expect(await outcome(s, pool, base, share), `${share}`).to.equal('noBackrun');
		});

		it('with outOfGasDepth 0 an out of gas below the first call frame is not recognised', async () => {
			const s = await setup();
			const {pool, base} = await prepare(s, {hard: true, executor: ExecutorMode.BurnGas});
			await (await s.hook.setOutOfGasDepth(pool.poolId, 0)).wait();
			expect(await outcome(s, pool, base, 0.6)).to.equal('noBackrun');
		});
	});
}
