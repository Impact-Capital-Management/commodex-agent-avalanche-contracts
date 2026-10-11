// Local test of CommodexAnchor on an in-memory chain (ganache). No Fuji funds used.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import ganache from 'ganache';
import { ethers } from 'ethers';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', 'contracts', 'CommodexAnchor.sol'), 'utf8');
const out = JSON.parse(solc.compile(JSON.stringify({
  language: 'Solidity',
  sources: { 'CommodexAnchor.sol': { content: source } },
  settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
})));
const errors = (out.errors || []).filter((e) => e.severity === 'error');
assert.equal(errors.length, 0, errors.map((e) => e.formattedMessage).join('\n'));
const { abi, evm } = out.contracts['CommodexAnchor.sol'].CommodexAnchor;

const chain = ganache.provider({ logging: { quiet: true }, chain: { chainId: 43113 }, wallet: { totalAccounts: 2 } });
const provider = new ethers.BrowserProvider(chain);
const operator = await provider.getSigner(0);
const stranger = await provider.getSigner(1);

let passed = 0;
const ok = (name) => { passed += 1; console.log(`ok ${passed} - ${name}`); };

const c = await new ethers.ContractFactory(abi, '0x' + evm.bytecode.object, operator).deploy();
await c.waitForDeployment();
assert.equal(await c.operator(), await operator.getAddress());
ok('deployer is the operator');

const hash = ethers.keccak256(ethers.toUtf8Bytes('commodex ledger head #1'));
const kind = ethers.keccak256(ethers.toUtf8Bytes('LEDGER_HEAD'));
const rc = await (await c.anchor(hash, kind, 'GH-GOLD-2026-v1/ledger/1')).wait();
const ev = rc.logs.map((l) => c.interface.parseLog(l)).find((l) => l?.name === 'Anchored');
assert.equal(ev.args.hash, hash);
assert.equal(ev.args.kind, kind);
assert.equal(ev.args.ref, 'GH-GOLD-2026-v1/ledger/1');
assert.equal(await c.anchoredAtBlock(hash), BigInt(rc.blockNumber));
ok('anchor stores the block and emits Anchored');

await assert.rejects(c.anchor(hash, kind, 'again'), /AlreadyAnchored|revert/);
ok('same hash cannot be anchored twice');

await assert.rejects(c.anchor(ethers.ZeroHash, kind, ''), /ZeroHash|revert/);
ok('zero hash refused');

await assert.rejects(c.connect(stranger).anchor(ethers.id('x'), kind, ''), /NotOperator|revert/);
ok('only the operator can anchor');

await assert.rejects(c.setOperator(ethers.ZeroAddress), /ZeroOperator|revert/);
ok('operator cannot be set to the zero address');

await (await c.setOperator(await stranger.getAddress())).wait();
await (await c.connect(stranger).anchor(ethers.id('y'), kind, '')).wait();
await assert.rejects(c.anchor(ethers.id('z'), kind, ''), /NotOperator|revert/);
ok('operator hand-over works and the old operator loses access');

console.log(`\n${passed}/7 passed`);
