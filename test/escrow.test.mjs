// Local tests of CommodexEscrow on an in-memory chain (ganache). No Fuji funds used.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { spawn } from 'node:child_process';
import { ethers } from 'ethers';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const sources = {
  'CommodexEscrow.sol': readFileSync(join(root, 'contracts', 'CommodexEscrow.sol'), 'utf8'),
  'mocks/TestTokens.sol': readFileSync(join(root, 'contracts', 'mocks', 'TestTokens.sol'), 'utf8'),
};
const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, { content: v }])),
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})));
const errors = (out.errors || []).filter((e) => e.severity === 'error');
assert.equal(errors.length, 0, errors.map((e) => e.formattedMessage).join('\n'));

const escrowArt = out.contracts['CommodexEscrow.sol'].CommodexEscrow;
const mocks = out.contracts['mocks/TestTokens.sol'];
const ONE = 1_000_000n; // 1 tUSDC (6 decimals)
const DAY = 24 * 3600;
const tid = (name) => ethers.id(`trade-${name}`);

// Ganache runs as its own process (as in the anchor work) and ethers talks to it over HTTP.
const PORT = 8555;
const RPC_URL = `http://127.0.0.1:${PORT}`;
const ganacheCli = join(root, 'node_modules', 'ganache', 'dist', 'node', 'cli.js');
const child = spawn(process.execPath, [ganacheCli, '--chain.chainId', '43113', '--server.port', String(PORT), '--wallet.totalAccounts', '6', '--logging.quiet'], { stdio: 'ignore' });
for (let i = 0; ; i += 1) {
  try {
    await fetch(RPC_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
    break;
  } catch (err) {
    if (i > 100) throw new Error(`ganache did not start on ${RPC_URL}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}
const provider = new ethers.JsonRpcProvider(RPC_URL, 43113, { staticNetwork: true });
provider.pollingInterval = 50; // ganache mines instantly; the 4 s default makes tx.wait() slow and racy
const chain = { request: ({ method, params }) => provider.send(method, params) };
const [owner, operator, buyer, seller, stranger, feeTo] = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => provider.getSigner(i)));
const addr = (s) => s.getAddress();

let passed = 0;
const ok = (name) => { passed += 1; console.log(`ok ${passed} - ${name}`); };

async function deploy(abi, bytecode, signer, args = []) {
  const c = await new ethers.ContractFactory(abi, '0x' + bytecode, signer).deploy(...args);
  await c.waitForDeployment();
  return c;
}

// Read the chain clock over the raw RPC: ethers caches 'latest' and would miss warps.
async function now() {
  const block = await chain.request({ method: 'eth_getBlockByNumber', params: ['latest', false] });
  return BigInt(parseInt(block.timestamp, 16));
}

async function warp(seconds) {
  await chain.request({ method: 'evm_increaseTime', params: [seconds] });
  await chain.request({ method: 'evm_mine', params: [] });
}

async function fresh(tokenName = 'MockUSDC') {
  const tokenArt = mocks[tokenName];
  const token = await deploy(tokenArt.abi, tokenArt.evm.bytecode.object, owner);
  await (await token.mint(await addr(buyer), 10_000n * ONE)).wait();
  const escrow = await deploy(escrowArt.abi, escrowArt.evm.bytecode.object, owner, [
    await token.getAddress(), await addr(operator), await addr(feeTo),
  ]);
  await (await token.connect(buyer).approve(await escrow.getAddress(), ethers.MaxUint256)).wait();
  return { token, escrow, esc: (s) => escrow.connect(s), tok: (s) => token.connect(s) };
}

async function fund(env, id, amount = 100n * ONE, window = DAY) {
  const deadline = (await now()) + BigInt(window);
  await (await env.esc(buyer).createAndFund(id, await addr(seller), amount, deadline)).wait();
  return deadline;
}

const status = async (env, id) => Number((await env.escrow.escrows(id)).status);
const bal = (env, s) => env.token.balanceOf(s);

// ---- 1. deployment
{
  const env = await fresh();
  assert.equal(await env.escrow.operator(), await addr(operator));
  assert.equal(await env.escrow.owner(), await addr(owner));
  assert.equal(await env.escrow.feeRecipient(), await addr(feeTo));
  assert.equal(await env.escrow.feeBps(), 0n);
  assert.equal(await env.escrow.paused(), false);
  assert.equal(await env.token.decimals(), 6n);
  await assert.rejects(deploy(escrowArt.abi, escrowArt.evm.bytecode.object, owner, [ethers.ZeroAddress, await addr(operator), await addr(feeTo)]), /revert|ZeroAddress/);
  await assert.rejects(deploy(escrowArt.abi, escrowArt.evm.bytecode.object, owner, [await env.token.getAddress(), ethers.ZeroAddress, await addr(feeTo)]), /revert|ZeroAddress/);
  ok('deploys with owner, operator, fee recipient set; zero addresses refused');
}

// ---- 2. happy path, buyer releases, no fee
{
  const env = await fresh();
  const id = tid('happy');
  await fund(env, id);
  assert.equal(await status(env, id), 1); // FUNDED
  assert.equal(await bal(env, await env.escrow.getAddress()), 100n * ONE);
  await (await env.esc(buyer).release(id)).wait();
  assert.equal(await bal(env, await addr(seller)), 100n * ONE);
  assert.equal(await bal(env, await env.escrow.getAddress()), 0n);
  assert.equal(await status(env, id), 3); // RELEASED
  ok('happy path: fund, buyer release, seller paid in full');
}

// ---- 3. fee applied on release
{
  const env = await fresh();
  await (await env.escrow.setFee(100)).wait(); // 1%
  const id = tid('fee');
  await fund(env, id);
  await (await env.esc(buyer).release(id)).wait();
  assert.equal(await bal(env, await addr(seller)), 99n * ONE);
  assert.equal(await bal(env, await addr(feeTo)), 1n * ONE);
  ok('1% fee: seller gets 99, fee recipient gets 1');
}

// ---- 4. release by operator on FUNDED trade; refund by seller; refund by operator; stranger refused
{
  const env = await fresh();
  const buyerStart = await bal(env, await addr(buyer));
  const id1 = tid('refund-seller');
  await fund(env, id1);
  await assert.rejects(env.esc(stranger).refund(id1), /NotParty|revert/);
  await (await env.esc(seller).refund(id1)).wait();
  assert.equal(await bal(env, await addr(buyer)), buyerStart);
  assert.equal(await status(env, id1), 4); // REFUNDED

  const id2 = tid('refund-operator');
  await fund(env, id2);
  await (await env.esc(operator).refund(id2)).wait();
  assert.equal(await status(env, id2), 4);

  const id3 = tid('release-operator');
  await fund(env, id3);
  await assert.rejects(env.esc(operator).release(id3), /NotParty|revert/);
  await assert.rejects(env.esc(seller).release(id3), /NotParty|revert/);
  assert.equal(await status(env, id3), 1);
  ok('refund by seller or operator returns full amount; stranger refused; only the buyer can release');
}

// ---- 5. operator force release: refused before deadline, allowed after; only operator
{
  const env = await fresh();
  const id = tid('force');
  await fund(env, id, 50n * ONE, DAY);
  await assert.rejects(env.esc(operator).forceRelease(id), /DeadlineNotReached|revert/);
  await warp(2 * DAY);
  // Explicit gasLimit: ganache estimates gas on a pending block that ignores evm_increaseTime.
  await assert.rejects(env.esc(stranger).forceRelease(id, { gasLimit: 500_000 }).then((tx) => tx.wait()), /NotOperator|revert/);
  await assert.rejects(env.esc(buyer).forceRelease(id, { gasLimit: 500_000 }).then((tx) => tx.wait()), /NotOperator|revert/);
  await (await env.esc(operator).forceRelease(id, { gasLimit: 500_000 })).wait();
  assert.equal(await bal(env, await addr(seller)), 50n * ONE);
  assert.equal(await status(env, id), 3);
  ok('force release: operator only, only after the deadline, seller paid');
}

// ---- 5b. buyer backstop: expire only OPERATOR_GRACE after deadline, undisputed only
{
  const env = await fresh();
  const id = tid('expiry');
  await fund(env, id, 50n * ONE, DAY);
  await assert.rejects(env.esc(stranger).expire(id), /NotExpired|revert/);
  await warp(2 * DAY);
  await assert.rejects(env.esc(stranger).expire(id, { gasLimit: 500_000 }).then((tx) => tx.wait()), /NotExpired|revert/);
  await warp(30 * DAY);
  const buyerBefore = await bal(env, await addr(buyer));
  await (await env.esc(stranger).expire(id, { gasLimit: 500_000 })).wait();
  assert.equal(await bal(env, await addr(buyer)), buyerBefore + 50n * ONE);
  assert.equal(await status(env, id), 4);
  ok('backstop: refused until 30 days after the deadline, then anyone returns funds to buyer');
}

// ---- 6. dispute flow
{
  const env = await fresh();
  const id = tid('dispute-seller-wins');
  await fund(env, id);
  await assert.rejects(env.esc(stranger).dispute(id), /NotParty|revert/);
  await (await env.esc(buyer).dispute(id)).wait();
  assert.equal(await status(env, id), 2); // DISPUTED
  await assert.rejects(env.esc(buyer).release(id), /WrongStatus|revert/);
  await assert.rejects(env.esc(seller).refund(id), /WrongStatus|revert/);
  await assert.rejects(env.esc(buyer).resolve(id, true), /NotOperator|revert/);
  await (await env.esc(operator).resolve(id, true)).wait();
  assert.equal(await bal(env, await addr(seller)), 100n * ONE);
  assert.equal(await status(env, id), 3);

  const id2 = tid('dispute-buyer-wins');
  await fund(env, id2);
  await (await env.esc(seller).dispute(id2)).wait();
  const buyerBefore = await bal(env, await addr(buyer));
  await (await env.esc(operator).resolve(id2, false)).wait();
  assert.equal(await bal(env, await addr(buyer)), buyerBefore + 100n * ONE);
  assert.equal(await status(env, id2), 4);

  const id3 = tid('resolve-not-disputed');
  await fund(env, id3);
  await assert.rejects(env.esc(operator).resolve(id3, true), /WrongStatus|revert/);
  ok('dispute: frozen against release/refund, operator resolves either way, third parties refused');
}

// ---- 7. a disputed trade never expires and cannot be force-released: operator must resolve
{
  const env = await fresh();
  const id = tid('dispute-then-expire');
  await fund(env, id, 40n * ONE, DAY);
  await (await env.esc(seller).dispute(id)).wait();
  await warp(40 * DAY);
  await assert.rejects(env.esc(stranger).expire(id, { gasLimit: 500_000 }).then((tx) => tx.wait()), /WrongStatus|revert/);
  await assert.rejects(env.esc(operator).forceRelease(id, { gasLimit: 500_000 }).then((tx) => tx.wait()), /WrongStatus|revert/);
  assert.equal(await status(env, id), 2);
  await (await env.esc(operator).resolve(id, false, { gasLimit: 500_000 })).wait();
  assert.equal(await status(env, id), 4);
  assert.equal(await bal(env, await addr(buyer)), 10_000n * ONE);
  ok('disputed trade: no expiry, no force release; operator resolve is the only exit');
}

// ---- 7b. 7-day default window is accepted
{
  const env = await fresh();
  assert.equal(await env.escrow.DEFAULT_WINDOW(), BigInt(7 * DAY));
  const id = tid('seven-days');
  await fund(env, id, ONE, 7 * DAY);
  assert.equal(await status(env, id), 1);
  ok('7-day default window constant and funding with it');
}

// ---- 8. duplicate trade id, input limits
{
  const env = await fresh();
  const id = tid('dup');
  await fund(env, id);
  await assert.rejects(fund(env, id), /TradeExists|revert/);

  const now0 = await now();
  const s = await addr(seller);
  const cases = [
    ['zero amount', tid('z1'), s, 0n, now0 + BigInt(DAY)],
    ['amount above cap', tid('z2'), s, 1_000_001n * ONE, now0 + BigInt(DAY)],
    ['deadline too soon', tid('z3'), s, ONE, now0 + 60n],
    ['deadline too far', tid('z4'), s, ONE, now0 + 31n * BigInt(DAY)],
    ['seller is buyer', tid('z5'), await addr(buyer), ONE, now0 + BigInt(DAY)],
    ['zero seller', tid('z6'), ethers.ZeroAddress, ONE, now0 + BigInt(DAY)],
    ['zero trade id', ethers.ZeroHash, s, ONE, now0 + BigInt(DAY)],
  ];
  for (const [label, trade, who, amount, deadline] of cases) {
    await assert.rejects(env.esc(buyer).createAndFund(trade, who, amount, deadline), /revert|BadAmount|BadDeadline|SellerIsBuyer|ZeroAddress|ZeroTrade/, label);
  }
  ok('duplicate trade id refused; zero/over-cap amount, bad deadline, seller=buyer, zero seller and zero trade id refused');
}

// ---- 9. pause blocks new trades only
{
  const env = await fresh();
  const a = tid('pause-a');
  const c = tid('pause-c');
  await fund(env, a);
  await fund(env, c);
  await (await env.escrow.pause()).wait();
  await assert.rejects(fund(env, tid('pause-b')), /ContractPaused|revert/);
  await (await env.esc(buyer).release(a)).wait();
  await (await env.esc(seller).refund(c)).wait();
  assert.equal(await status(env, a), 3);
  assert.equal(await status(env, c), 4);
  await (await env.escrow.unpause()).wait();
  await fund(env, tid('pause-after'));
  ok('pause refuses new escrows; release and refund of open trades still work');
}

// ---- 10. fee cap and admin access
{
  const env = await fresh();
  await assert.rejects(env.escrow.setFee(301), /FeeTooHigh|revert/);
  await (await env.escrow.setFee(300)).wait();
  await assert.rejects(env.esc(stranger).setFee(0), /NotOwner|revert/);
  await assert.rejects(env.esc(stranger).pause(), /NotOwner|revert/);
  await assert.rejects(env.escrow.setOperator(ethers.ZeroAddress), /ZeroAddress|revert/);
  await assert.rejects(env.esc(stranger).setOperator(await addr(stranger)), /NotOwner|revert/);
  ok('fee capped at 3%; only owner changes fee, pause, operator; operator cannot be zero');
}

// ---- 11. two-step ownership
{
  const env = await fresh();
  await (await env.escrow.transferOwnership(await addr(feeTo))).wait();
  await assert.rejects(env.esc(stranger).acceptOwnership(), /NotPending|revert/);
  await (await env.esc(feeTo).acceptOwnership()).wait();
  assert.equal(await env.escrow.owner(), await addr(feeTo));
  await assert.rejects(env.escrow.setFee(1), /NotOwner|revert/);
  await (await env.esc(feeTo).setFee(1)).wait();
  ok('ownership moves in two steps; old owner loses control');
}

// ---- 12. malicious token re-enters during payout: must not pay twice
{
  const env = await fresh('HookUSDC');
  const id = tid('reentry');
  await fund(env, id);
  const data = new ethers.Interface(escrowArt.abi).encodeFunctionData('release', [id]);
  await (await env.token.arm(await env.escrow.getAddress(), data)).wait();
  await (await env.esc(buyer).release(id)).wait();
  assert.equal(await env.token.hookRan(), true);
  assert.equal(await env.token.hookOk(), false);
  assert.equal(await bal(env, await addr(seller)), 100n * ONE);
  assert.equal(await bal(env, await env.escrow.getAddress()), 0n);
  ok('re-entry from a malicious token during payout is refused; seller paid once');
}

// ---- 13. fee-on-transfer token rejected on funding
{
  const env = await fresh('FeeOnTransferUSDC');
  const deadline = (await now()) + BigInt(DAY);
  await assert.rejects(env.esc(buyer).createAndFund(tid('fot'), await addr(seller), 10n * ONE, deadline), /FeeOnTransfer|revert/);
  ok('fee-on-transfer token refused at funding');
}

// ---- 14. terminal states are final
{
  const env = await fresh();
  const id = tid('terminal');
  await fund(env, id);
  await (await env.esc(buyer).release(id)).wait();
  await assert.rejects(env.esc(buyer).release(id), /WrongStatus|revert/);
  await assert.rejects(env.esc(seller).refund(id), /WrongStatus|revert/);
  await assert.rejects(env.esc(buyer).dispute(id), /WrongStatus|revert/);
  await assert.rejects(fund(env, id), /TradeExists|revert/);
  ok('released trade cannot be released, refunded, disputed or reused');
}

console.log(`\n${passed}/16 groups passed`);
child.kill();
