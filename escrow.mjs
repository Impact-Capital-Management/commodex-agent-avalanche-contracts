#!/usr/bin/env node
// Commodex escrow on Avalanche Fuji (TESTNET ONLY): compile, deploy, mint test USDC.
//
//   node escrow.mjs compile
//   node escrow.mjs whoami                       (address + balance of the key, sends nothing)
//   node escrow.mjs deploy                       (deploys tUSDC + CommodexEscrow, once)
//   node escrow.mjs mint <0x address> <amount>   (owner mints test tUSDC, amount in whole tUSDC)
//   node escrow.mjs status <tradeId>             (reads the escrow record, sends nothing)
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
  if (e.escrow) throw new Error(`Escrow already deployed at ${e.escrow} (evidence/fuji-escrow.json). Refusing to deploy a second one.`);
  const a = artifact();
  const w = await signer();
  const operator = ethers.getAddress(process.env.ESCROW_OPERATOR || DEFAULT_OPERATOR);
  const bal = await w.provider.getBalance(w.address);
  console.log(`deployer ${w.address}, balance ${ethers.formatEther(bal)} AVAX, operator ${operator}`);

  const token = await new ethers.ContractFactory(a.MockUSDC.abi, a.MockUSDC.bytecode, w).deploy();
  const tokenTx = token.deploymentTransaction();
  console.log(`tUSDC deploy tx ${tokenTx.hash}, waiting...`);
  const tokenRc = await tokenTx.wait();
  const tokenAddress = await token.getAddress();

  const escrow = await new ethers.ContractFactory(a.CommodexEscrow.abi, a.CommodexEscrow.bytecode, w)
    .deploy(tokenAddress, operator, w.address);
  const escrowTx = escrow.deploymentTransaction();
  console.log(`escrow deploy tx ${escrowTx.hash}, waiting...`);
  const escrowRc = await escrowTx.wait();
  const escrowAddress = await escrow.getAddress();

  const now = new Date().toISOString();
  e.token = tokenAddress;
  e.escrow = escrowAddress;
  e.deployer = w.address;
  e.operator = operator;
  e.feeRecipient = w.address;
  e.entries.push({ step: 'deploy-tusdc', txHash: tokenTx.hash, block: tokenRc.blockNumber, at: now, tx: `${EXPLORER}/tx/${tokenTx.hash}`, address: `${EXPLORER}/address/${tokenAddress}` });
  e.entries.push({ step: 'deploy-escrow', txHash: escrowTx.hash, block: escrowRc.blockNumber, at: now, tx: `${EXPLORER}/tx/${escrowTx.hash}`, address: `${EXPLORER}/address/${escrowAddress}` });
  saveEvidence(e);
  console.log(`tUSDC at ${tokenAddress}\nCommodexEscrow at ${escrowAddress} (block ${escrowRc.blockNumber})\n${EXPLORER}/address/${escrowAddress}`);
}

async function mint(to, amount) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to || '') || !amount) throw new Error('usage: node escrow.mjs mint <0x address> <amount in whole tUSDC>');
  const e = evidence();
  if (!e.token) throw new Error('No tUSDC recorded yet. Run deploy first.');
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

async function status(tradeId) {
  const e = evidence();
  if (!e.escrow) throw new Error('No escrow recorded yet.');
  const id = /^0x[0-9a-fA-F]{64}$/.test(tradeId || '') ? tradeId : ethers.id(`trade-${tradeId}`);
  const c = readOnlyContract(e.escrow, artifact().CommodexEscrow.abi);
  const r = await c.escrows(id);
  const names = ['NONE', 'FUNDED', 'DISPUTED', 'RELEASED', 'REFUNDED'];
  console.log(`trade ${id}\nstatus ${names[Number(r.status)]}\nbuyer ${r.buyer}\nseller ${r.seller}\namount ${ethers.formatUnits(r.amount, 6)} tUSDC\ndeadline ${new Date(Number(r.deadline) * 1000).toISOString()}`);
}

const [cmd, ...args] = process.argv.slice(2);
const run = {
  compile: async () => compile(),
  whoami,
  deploy,
  mint: () => mint(args[0], args[1]),
  status: () => status(args[0]),
}[cmd];
if (!run) {
  console.log('usage: node escrow.mjs compile | whoami | deploy | mint <0x address> <amount> | status <tradeId>');
  process.exit(2);
}
run().catch((err) => { console.error(err.shortMessage || err.message); process.exit(1); });
