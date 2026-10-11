#!/usr/bin/env node
// Commodex M0 on Avalanche Fuji: compile, deploy and use CommodexAnchor.
//
//   node anchor.mjs compile
//   node anchor.mjs deploy
//   node anchor.mjs anchor <0x32-byte-hash | text> <KIND> <ref>
//   node anchor.mjs check  <0x32-byte-hash>
//
// The signer key is read from the file named by COMMODEX_FUJI_KEY_FILE (one line,
// 0x… private key of the Fuji test wallet). It is never printed or written.
// Every mined transaction is appended to evidence/fuji-evidence.json with its
// Snowtrace link, ready to cite wherever the transaction is referenced.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import solc from 'solc';
import { ethers } from 'ethers';

const here = dirname(fileURLToPath(import.meta.url));
const RPC = process.env.FUJI_RPC || 'https://api.avax-test.network/ext/bc/C/rpc';
const CHAIN_ID = 43113n;
const EXPLORER = 'https://testnet.snowtrace.io';
const BUILD = join(here, 'build', 'CommodexAnchor.json');
const EVIDENCE = join(here, 'evidence', 'fuji-evidence.json');

function compile() {
  const source = readFileSync(join(here, 'contracts', 'CommodexAnchor.sol'), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'CommodexAnchor.sol': { content: source } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'paris', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (out.errors || []).filter((e) => e.severity === 'error');
  if (errors.length) throw new Error(errors.map((e) => e.formattedMessage).join('\n'));
  const c = out.contracts['CommodexAnchor.sol'].CommodexAnchor;
  const artifact = { contractName: 'CommodexAnchor', compiler: solc.version(), abi: c.abi, bytecode: '0x' + c.evm.bytecode.object };
  mkdirSync(dirname(BUILD), { recursive: true });
  writeFileSync(BUILD, JSON.stringify(artifact, null, 2));
  console.log(`compiled with solc ${artifact.compiler} -> build/CommodexAnchor.json`);
  return artifact;
}

function artifact() {
  return existsSync(BUILD) ? JSON.parse(readFileSync(BUILD, 'utf8')) : compile();
}

function evidence() {
  return existsSync(EVIDENCE) ? JSON.parse(readFileSync(EVIDENCE, 'utf8')) : { network: 'Avalanche Fuji C-Chain', chainId: 43113, contract: null, deployer: null, entries: [] };
}

function saveEvidence(e) {
  mkdirSync(dirname(EVIDENCE), { recursive: true });
  writeFileSync(EVIDENCE, JSON.stringify(e, null, 2) + '\n');
}

async function signer() {
  const file = process.env.COMMODEX_FUJI_KEY_FILE;
  if (!file) throw new Error('Set COMMODEX_FUJI_KEY_FILE to the file holding the Fuji test wallet key.');
  const key = readFileSync(file, 'utf8').trim();
  const provider = new ethers.JsonRpcProvider(RPC);
  const net = await provider.getNetwork();
  if (net.chainId !== CHAIN_ID) throw new Error(`RPC answers chain ${net.chainId}, expected 43113 (Fuji). Refusing.`);
  return new ethers.Wallet(key, provider);
}

function toHash(value) {
  return /^0x[0-9a-fA-F]{64}$/.test(value) ? value : ethers.keccak256(ethers.toUtf8Bytes(value));
}

async function deploy() {
  const a = artifact();
  const w = await signer();
  const bal = await w.provider.getBalance(w.address);
  console.log(`deployer ${w.address}, balance ${ethers.formatEther(bal)} AVAX`);
  const factory = new ethers.ContractFactory(a.abi, a.bytecode, w);
  const c = await factory.deploy();
  const tx = c.deploymentTransaction();
  console.log(`deploy tx ${tx.hash}, waiting for it to be mined...`);
  const rc = await tx.wait();
  const address = await c.getAddress();
  const e = evidence();
  e.contract = address;
  e.deployer = w.address;
  e.entries.push({ step: 'deploy', txHash: tx.hash, block: rc.blockNumber, at: new Date().toISOString(), tx: `${EXPLORER}/tx/${tx.hash}`, address: `${EXPLORER}/address/${address}` });
  saveEvidence(e);
  console.log(`CommodexAnchor at ${address} (block ${rc.blockNumber})\n${EXPLORER}/address/${address}`);
}

async function anchor(value, kind = 'TEST', ref = '') {
  if (!value) throw new Error('usage: node anchor.mjs anchor <0x hash | text> <KIND> <ref>');
  const e = evidence();
  if (!e.contract) throw new Error('No contract in evidence/fuji-evidence.json. Run deploy first.');
  const w = await signer();
  const c = new ethers.Contract(e.contract, artifact().abi, w);
  const hash = toHash(value);
  const kindHash = ethers.keccak256(ethers.toUtf8Bytes(kind));
  const tx = await c.anchor(hash, kindHash, ref);
  console.log(`anchor tx ${tx.hash}, waiting...`);
  const rc = await tx.wait();
  e.entries.push({ step: 'anchor', kind, ref, hash, txHash: tx.hash, block: rc.blockNumber, at: new Date().toISOString(), tx: `${EXPLORER}/tx/${tx.hash}` });
  saveEvidence(e);
  console.log(`anchored ${hash} as ${kind} in block ${rc.blockNumber}\n${EXPLORER}/tx/${tx.hash}`);
}

async function check(value) {
  const e = evidence();
  if (!e.contract) throw new Error('No contract recorded yet.');
  const provider = new ethers.JsonRpcProvider(RPC);
  const c = new ethers.Contract(e.contract, artifact().abi, provider);
  const block = await c.anchoredAtBlock(toHash(value));
  console.log(block === 0n ? 'not anchored' : `anchored in block ${block}`);
}

const [cmd, ...args] = process.argv.slice(2);
const run = { compile: async () => compile(), deploy, anchor: () => anchor(...args), check: () => check(args[0]) }[cmd];
if (!run) {
  console.log('usage: node anchor.mjs compile | deploy | anchor <hash|text> <KIND> <ref> | check <hash|text>');
  process.exit(2);
}
run().catch((err) => { console.error(err.shortMessage || err.message); process.exit(1); });
