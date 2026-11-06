#!/usr/bin/env node
// Commodex escrow on Avalanche Fuji (TESTNET ONLY): compile, deploy, mint test USDC.
//
//   node escrow.mjs compile
//   node escrow.mjs whoami                       (address + balance of the key, sends nothing)
//   node escrow.mjs deploy                       (deploys CommodexEscrow on Circle's Fuji USDC, once)
//   ESCROW_TOKEN=mock node escrow.mjs deploy     (old path: deploys our own tUSDC first)
//   node escrow.mjs token                        (USDC balance of the key, sends nothing)
//   node escrow.mjs mint <0x address> <amount>   (owner mints test tUSDC, amount in whole tUSDC)
//   node escrow.mjs status <tradeId>             (reads the escrow record, sends nothing)
//   node escrow.mjs demo <amount> [seller]       (key = buyer, COMMODEX_OPERATOR_KEY_FILE = operator signs the
//                                                 terms; approve, fund a 7-day trade, release;
//                                                 needs Circle test USDC from https://faucet.circle.com/)
//
// The signer key is read from the file named by COMMODEX_FUJI_KEY_FILE (one line, the Fuji
// test wallet key). It is never printed or written. The operator defaults to the Commodex
// staging server wallet and can be overridden with ESCROW_OPERATOR. Every deploy and mint is
// appended to evidence/fuji-escrow.json with its Snowtrace link. The anchor evidence file is
// not touched.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { ethers } from 'ethers';

const here = dirname(fileURLToPath(import.meta.url));
const RPC = process.env.FUJI_RPC || 'https://api.avax-test.network/ext/bc/C/rpc';
const CHAIN_ID = 43113n;
const EXPLORER = 'https://testnet.snowtrace.io';
const DEFAULT_OPERATOR = '0x215edFA8C9Db88A972FbEDb810b884ADe94fca7B'; // Commodex staging server wallet
// Circle test USDC on Avalanche Fuji, from https://developers.circle.com/stablecoins/usdc-contract-addresses
// (checked 2026-11-01). Test tokens from https://faucet.circle.com/ . Owner decision 2026-11-01.
const CIRCLE_FUJI_USDC = '0x5425890298aed601595a70AB815c96711a31Bc65';
const ERC20_READ_ABI = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)'];
const BUILD = join(here, 'build', 'CommodexEscrow.json');
const EVIDENCE = join(here, 'evidence', 'fuji-escrow.json');

function compile() {
  const sources = {
    'CommodexEscrow.sol': readFileSync(join(here, 'contracts', 'CommodexEscrow.sol'), 'utf8'),
    'mocks/TestTokens.sol': readFileSync(join(here, 'contracts', 'mocks', 'TestTokens.sol'), 'utf8'),
  };
  const input = {
    language: 'Solidity',
    sources: Object.fromEntries(Object.entries(sources).map(([k, v]) => [k, { content: v }])),
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const escrow = out.contracts['CommodexEscrow.sol'].CommodexEscrow;
  const token = out.contracts['mocks/TestTokens.sol'].MockUSDC;
  const artifact = {
    compiler: solc.version(),
    CommodexEscrow: { abi: escrow.abi, bytecode: '0x' + escrow.evm.bytecode.object },
    MockUSDC: { abi: token.abi, bytecode: '0x' + token.evm.bytecode.object },
  };
  mkdirSync(dirname(BUILD), { recursive: true });
  writeFileSync(BUILD, JSON.stringify(artifact, null, 2));
  console.log(`compiled with solc ${artifact.compiler} -> build/CommodexEscrow.json`);
  return artifact;
}

function artifact() {
  return existsSync(BUILD) ? JSON.parse(readFileSync(BUILD, 'utf8')) : compile();
}

function evidence() {
  return existsSync(EVIDENCE) ? JSON.parse(readFileSync(EVIDENCE, 'utf8')) : { network: 'Avalanche Fuji C-Chain', chainId: 43113, testnetOnly: true, token: null, escrow: null, deployer: null, entries: [] };
}

function saveEvidence(e) {
  mkdirSync(dirname(EVIDENCE), { recursive: true });
  writeFileSync(EVIDENCE, JSON.stringify(e, null, 2) + '\n');
}

// Accepts a private key with or without 0x, quotes, spaces or a Notepad BOM, or a 12/24-word
// recovery phrase. Never prints the secret, only its shape.
function walletFromFile(file) {
  const raw = readFileSync(file, 'utf8').replace(/^﻿/, '').trim().replace(/^["']|["']$/g, '').trim();
  const hex = raw.replace(/\s+/g, '').replace(/^0x/i, '');
  if (/^[0-9a-fA-F]{64}$/.test(hex)) return new ethers.Wallet('0x' + hex);
  const words = raw.toLowerCase().split(/\s+/).filter(Boolean);
  if ([12, 15, 18, 21, 24].includes(words.length) && words.every((w) => /^[a-z]+$/.test(w))) {
    return ethers.Wallet.fromPhrase(words.join(' '));
  }
  throw new Error('The key file is not a private key (64 hex characters, optional 0x) or a 12/24-word phrase. Keep only the key on one line.');
}

async function signer() {
  const file = process.env.COMMODEX_FUJI_KEY_FILE;
  if (!file) throw new Error('Set COMMODEX_FUJI_KEY_FILE to the file holding the Fuji test wallet key.');
  const provider = new ethers.JsonRpcProvider(RPC);
  const net = await provider.getNetwork();
  if (net.chainId !== CHAIN_ID) throw new Error(`RPC answers chain ${net.chainId}, expected 43113 (Fuji). Refusing.`);
  return walletFromFile(file).connect(provider);
}

function readOnlyContract(address, abi) {
  const provider = new ethers.JsonRpcProvider(RPC);
  return new ethers.Contract(address, abi, provider);
}

async function whoami() {
  const w = await signer();
  const bal = await w.provider.getBalance(w.address);
  console.log(`key file belongs to ${w.address}`);
  console.log(`balance ${ethers.formatEther(bal)} AVAX on Fuji`);
}

async function deploy() {
  const e = evidence();
  if (e.escrow && String(e.contractVersion || '').startsWith('v3')) throw new Error(`Escrow v3 already deployed at ${e.escrow} (evidence/fuji-escrow.json). Refusing to deploy a second one.`);
  if (e.escrow) {
    // v2 (no operator authorization on funding) is retired: keep its record, deploy v3 beside it.
    const { previous = [], ...v2 } = e;
    e.previous = [...previous, { contractVersion: v2.contractVersion || 'v2-2026-11-01', escrow: v2.escrow, token: v2.token, deployer: v2.deployer, operator: v2.operator ?? null, entries: v2.entries }];
    e.entries = [];
  }
  const a = artifact();
  const w = await signer();
  const operator = ethers.getAddress(process.env.ESCROW_OPERATOR || DEFAULT_OPERATOR);
  const bal = await w.provider.getBalance(w.address);
  console.log(`deployer ${w.address}, balance ${ethers.formatEther(bal)} AVAX, operator ${operator}`);

  const useMock = (process.env.ESCROW_TOKEN || '').toLowerCase() === 'mock';
  let tokenAddress;
  let tokenEntry = null;
  if (useMock) {
    const token = await new ethers.ContractFactory(a.MockUSDC.abi, a.MockUSDC.bytecode, w).deploy();
    const tokenTx = token.deploymentTransaction();
    console.log(`tUSDC deploy tx ${tokenTx.hash}, waiting...`);
    const tokenRc = await tokenTx.wait();
    tokenAddress = await token.getAddress();
    tokenEntry = { step: 'deploy-tusdc', txHash: tokenTx.hash, block: tokenRc.blockNumber, tx: `${EXPLORER}/tx/${tokenTx.hash}`, address: `${EXPLORER}/address/${tokenAddress}` };
  } else {
    tokenAddress = ethers.getAddress(CIRCLE_FUJI_USDC);
    const code = await w.provider.getCode(tokenAddress);
    if (code === '0x') throw new Error(`No contract at Circle Fuji USDC ${tokenAddress}. Refusing.`);
    const t = new ethers.Contract(tokenAddress, ERC20_READ_ABI, w.provider);
    const [sym, dec] = [await t.symbol(), await t.decimals()];
    if (Number(dec) !== 6) throw new Error(`Token ${tokenAddress} has ${dec} decimals, expected 6. Refusing.`);
    console.log(`token: Circle ${sym} on Fuji at ${tokenAddress} (6 decimals)`);
  }

  const escrow = await new ethers.ContractFactory(a.CommodexEscrow.abi, a.CommodexEscrow.bytecode, w)
    .deploy(tokenAddress, operator, w.address);
  const escrowTx = escrow.deploymentTransaction();
  console.log(`escrow deploy tx ${escrowTx.hash}, waiting...`);
  const escrowRc = await escrowTx.wait();
  const escrowAddress = await escrow.getAddress();

  const now = new Date().toISOString();
  e.token = tokenAddress;
  e.tokenKind = useMock ? 'tUSDC (Commodex mock)' : 'Circle USDC (Fuji test)';
  e.contractVersion = 'v3-2026-11-06 (v2 rules + operator EIP-712 authorization of every escrow, fee fixed at funding)';
  e.escrow = escrowAddress;
  e.deployer = w.address;
  e.operator = operator;
  e.feeRecipient = w.address;
  if (tokenEntry) e.entries.push({ ...tokenEntry, at: now });
  e.entries.push({ step: 'deploy-escrow', txHash: escrowTx.hash, block: escrowRc.blockNumber, at: now, tx: `${EXPLORER}/tx/${escrowTx.hash}`, address: `${EXPLORER}/address/${escrowAddress}` });
  saveEvidence(e);
  console.log(`token at ${tokenAddress}\nCommodexEscrow at ${escrowAddress} (block ${escrowRc.blockNumber})\n${EXPLORER}/address/${escrowAddress}`);
}

async function mint(to, amount) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to || '') || !amount) throw new Error('usage: node escrow.mjs mint <0x address> <amount in whole tUSDC>');
  const e = evidence();
  if (!e.token) throw new Error('No tUSDC recorded yet. Run deploy first.');
  if (!String(e.tokenKind || '').startsWith('tUSDC')) throw new Error('The escrow uses Circle USDC, which we cannot mint. Get test USDC from https://faucet.circle.com/ .');
  const w = await signer();
  const token = new ethers.Contract(e.token, artifact().MockUSDC.abi, w);
  const units = ethers.parseUnits(amount, 6);
  const tx = await token.mint(ethers.getAddress(to), units);
  console.log(`mint tx ${tx.hash}, waiting...`);
  const rc = await tx.wait();
  e.entries.push({ step: 'mint', to: ethers.getAddress(to), amount, txHash: tx.hash, block: rc.blockNumber, at: new Date().toISOString(), tx: `${EXPLORER}/tx/${tx.hash}` });
  saveEvidence(e);
  console.log(`minted ${amount} tUSDC to ${to} in block ${rc.blockNumber}\n${EXPLORER}/tx/${tx.hash}`);
}

async function tokenBalance() {
  const w = await signer();
  const e = evidence();
  const t = new ethers.Contract(e.token || CIRCLE_FUJI_USDC, ERC20_READ_ABI, w.provider);
  console.log(`${w.address} holds ${ethers.formatUnits(await t.balanceOf(w.address), 6)} ${await t.symbol()} on Fuji`);
}

// One real lifecycle on Fuji for the evidence file: the key's wallet is the buyer, approves the escrow,
// funds a trade for 7 days and releases it to the seller. Amount in whole USDC (default 1).
async function demo(amount = '1', sellerArg) {
  const e = evidence();
  if (!e.escrow) throw new Error('No escrow recorded yet. Run deploy first.');
  const w = await signer();
  const a = artifact();
  const seller = ethers.getAddress(sellerArg || process.env.ESCROW_DEMO_SELLER || e.operator || DEFAULT_OPERATOR);
  if (seller === w.address) throw new Error('Seller must differ from the buyer (the key wallet).');
  const units = ethers.parseUnits(String(amount), 6);
  const token = new ethers.Contract(e.token, ['function approve(address,uint256) returns (bool)', ...ERC20_READ_ABI], w);
  const have = await token.balanceOf(w.address);
  if (have < units) throw new Error(`Buyer ${w.address} holds ${ethers.formatUnits(have, 6)} USDC, needs ${amount}. Get test USDC from https://faucet.circle.com/ (Avalanche Fuji).`);
  const escrow = new ethers.Contract(e.escrow, a.CommodexEscrow.abi, w);
  const label = `demo-${new Date().toISOString()}`;
  const tradeId = ethers.id(`trade-${label}`);
  const deadline = BigInt(Math.floor(Date.now() / 1000) + 7 * 24 * 3600);
  const record = async (step, tx, extra = {}) => {
    const rc = await tx.wait();
    e.entries.push({ step, tradeId, txHash: tx.hash, block: rc.blockNumber, at: new Date().toISOString(), tx: `${EXPLORER}/tx/${tx.hash}`, ...extra });
    saveEvidence(e);
    console.log(`${step}: block ${rc.blockNumber}  ${EXPLORER}/tx/${tx.hash}`);
  };
  await record('demo-approve', await token.approve(e.escrow, units), { amount: String(amount) });
  // v3: the operator authorizes the exact terms. The operator key file stays on this machine; only the signature is used.
  const opFile = process.env.COMMODEX_OPERATOR_KEY_FILE;
  if (!opFile) throw new Error('Set COMMODEX_OPERATOR_KEY_FILE to the escrow operator key file: v3 needs its signature on every new escrow.');
  const op = walletFromFile(opFile);
  const contractOperator = await escrow.operator();
  if (op.address !== contractOperator) throw new Error(`COMMODEX_OPERATOR_KEY_FILE belongs to ${op.address}, but the escrow operator is ${contractOperator}.`);
  const operatorSig = await op.signTypedData(
    { name: 'CommodexEscrow', version: '3', chainId: CHAIN_ID, verifyingContract: e.escrow },
    { Fund: [{ name: 'tradeId', type: 'bytes32' }, { name: 'buyer', type: 'address' }, { name: 'seller', type: 'address' }, { name: 'amount', type: 'uint256' }, { name: 'deadline', type: 'uint64' }] },
    { tradeId, buyer: w.address, seller, amount: units, deadline },
  );
  await record('demo-fund', await escrow.createAndFund(tradeId, seller, units, deadline, operatorSig), { amount: String(amount), buyer: w.address, seller, deadline: Number(deadline), label });
  await record('demo-release-by-buyer', await escrow.release(tradeId), { seller });
  const r = await escrow.escrows(tradeId);
  console.log(`trade ${tradeId} status ${['NONE', 'FUNDED', 'DISPUTED', 'RELEASED', 'REFUNDED'][Number(r.status)]}`);
}

async function status(tradeId) {
  const e = evidence();
  if (!e.escrow) throw new Error('No escrow recorded yet.');
  const id = /^0x[0-9a-fA-F]{64}$/.test(tradeId || '') ? tradeId : ethers.id(`trade-${tradeId}`);
  const c = readOnlyContract(e.escrow, artifact().CommodexEscrow.abi);
  const r = await c.escrows(id);
  const names = ['NONE', 'FUNDED', 'DISPUTED', 'RELEASED', 'REFUNDED'];
  console.log(`trade ${id}\nstatus ${names[Number(r.status)]}\nbuyer ${r.buyer}\nseller ${r.seller}\namount ${ethers.formatUnits(r.amount, 6)} USDC\ndeadline ${new Date(Number(r.deadline) * 1000).toISOString()}`);
}

const [cmd, ...args] = process.argv.slice(2);
const run = {
  compile: async () => compile(),
  whoami,
  deploy,
  mint: () => mint(args[0], args[1]),
  token: tokenBalance,
  demo: () => demo(args[0], args[1]),
  status: () => status(args[0]),
}[cmd];
if (!run) {
  console.log('usage: node escrow.mjs compile | whoami | token | deploy | mint <0x address> <amount> | status <tradeId> | demo <amount> [seller]');
  process.exit(2);
}
run().catch((err) => { console.error(err.shortMessage || err.message); process.exit(1); });
