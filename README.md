# commodex-agent-avalanche-contracts

Avalanche escrow contracts agent for the Commodex Avalanche C-Chain setup. Commodex: https://commodex.xyz/

- Production: https://commodex.xyz
- Testnet UI: https://wedevnext.commodex.xyz
- Fuji evidence page on the testnet UI: https://wedevnext.commodex.xyz/fuji
- Network: Avalanche Fuji C-Chain (EVM), chain id `43113`

## Agent

| | |
|---|---|
| Person | Emilija Jankauskaitė |
| Role | Avalanche contracts — writes and explains the Avalanche escrow contracts |
| FR scope | FR-03 |
| Squad page | https://team.impactcapital.ltd/showcase/commodex/ |

## Status — updated 1 November 2026

**Both contracts are deployed on Avalanche Fuji and source verified on the explorer.**
CommodexAnchor v0 has anchored four hashes since 11 Oct 2026. CommodexEscrow v2 was deployed on 1 Nov 2026
on Circle's test USDC. Full escrow specification: [`docs/escrow-spec.md`](docs/escrow-spec.md).

| Contract | What it does | State |
|---|---|---|
| [`contracts/CommodexAnchor.sol`](contracts/CommodexAnchor.sol) | Stores a 32-byte hash and the block it was mined in; emits `Anchored`. No funds, no token, no personal data. Only the operator may anchor; one hash once. | Deployed 11 Oct 2026 at [`0xe274C452dFb0D259FA413EEd3a830197a4Fd50ef`](https://testnet.snowtrace.io/address/0xe274C452dFb0D259FA413EEd3a830197a4Fd50ef); 7/7 local tests |
| [`contracts/CommodexEscrow.sol`](contracts/CommodexEscrow.sol) | USDC escrow for one trade at a time. The buyer funds and releases, under Commodex's supervision as operator: once the 7-day deadline passes without a release, the operator may force the release to the seller. The seller or operator refunds. Disputes are resolved by the operator only and never expire. A 30-day backstop after the deadline returns an untouched trade to the buyer. Fee 0% (capped at 3%). Pause blocks new trades only. Rejects fee-on-transfer tokens. TESTNET ONLY. | v2 deployed 1 Nov 2026 at [`0xe453ebae20f06d53c44946b15A35E0e790A3089e`](https://testnet.snowtrace.io/address/0xe453ebae20f06d53c44946b15A35E0e790A3089e) on Circle Fuji USDC; source verified; 16/16 local test groups |
| [`contracts/mocks/TestTokens.sol`](contracts/mocks/TestTokens.sol) | Test stablecoin `tUSDC` (6 decimals, owner mints test supply) plus two adversarial tokens used only in tests: one burns 1% per transfer, one calls back into the escrow mid-payout. | Test-only, no value; the Fuji escrow uses Circle's test USDC instead |

## Run

```bash
npm install
npm test                                   # 7 checks on an in-memory chain, no Fuji funds
COMMODEX_FUJI_KEY_FILE=/path/key node anchor.mjs whoami   # address + balance, sends nothing
COMMODEX_FUJI_KEY_FILE=/path/key node anchor.mjs deploy
COMMODEX_FUJI_KEY_FILE=/path/key node anchor.mjs anchor "<text or 0x hash>" TEST "<ref>"
node anchor.mjs check "<text or 0x hash>"
```

Escrow (testnet only):

```bash
npm run test:escrow                        # 16 test groups on an in-memory chain, no Fuji funds
npm run test:all                           # anchor + escrow
COMMODEX_FUJI_KEY_FILE=/path/key node escrow.mjs deploy   # CommodexEscrow on Circle Fuji USDC, once; operator = Commodex staging server wallet
COMMODEX_FUJI_KEY_FILE=/path/key node escrow.mjs token    # USDC balance of the key, sends nothing
COMMODEX_FUJI_KEY_FILE=/path/key node escrow.mjs demo 1   # key = buyer: approve, fund a 7-day trade, release (test USDC from https://faucet.circle.com/)
node escrow.mjs status "<trade name or 0x trade id>"
```

`ESCROW_TOKEN=mock node escrow.mjs deploy` keeps the earlier path that deploys our own `tUSDC` first.

`escrow.mjs deploy` refuses to run twice and writes to `evidence/fuji-escrow.json`, separate from the anchor evidence.

Independent re-check of every transaction below, no install and no key:

```bash
git clone https://github.com/Impact-Capital-Management/commodex-agent-contract-assurance
node commodex-agent-contract-assurance/checks/verify-fuji.mjs     # 10/10 PASS on 14 Oct 2026
```

The app code that calls this contract from the Commodex testnet UI is in
[commodex-agent-avalanche-engineering/app](https://github.com/Impact-Capital-Management/commodex-agent-avalanche-engineering/tree/main/app).

`anchor.mjs` refuses any RPC that does not answer chain id 43113. Each mined transaction is appended to
`evidence/fuji-evidence.json` with its explorer link. Measured deploy cost on 11 Oct 2026: about 272,000 gas,
far below 0.000001 AVAX.

## Evidence

Network: Avalanche Fuji C-Chain, chain id 43113. Deployer: `0xa6547c2812140c0495113d4490eb0f2805A67ecD`. Operator since 2026-10-11 15:32 UTC: the Commodex staging server wallet `0x215edFA8C9Db88A972FbEDb810b884ADe94fca7B`.
Raw record: [`evidence/fuji-evidence.json`](evidence/fuji-evidence.json).

| Date (UTC) | Step | Block | Explorer |
|---|---|---|---|
| 2026-10-11 16:00 | Commodex app anchors a Pool-to-Pool match root (`P2P_ROOT`, 12 buyers, every Merkle proof verified) | 59309318 | https://testnet.snowtrace.io/tx/0x54a4a46708d4bbdd641f9f4f14fb88c085f2af29d35295834f4d6caab4ec38e6 |
| 2026-10-11 16:00 | Commodex app anchors the head of its `tax` ledger stream (`LEDGER_HEAD`) | 59309310 | https://testnet.snowtrace.io/tx/0x3a1c5d0093de40c15deed22f9a568c0a1b2ad04f66f5ae084771583c69e45ac9 |
| 2026-10-11 15:59 | Commodex app sends its first anchor (`TEST`) from the server wallet | 59309304 | https://testnet.snowtrace.io/tx/0x41a6b23d19891b6fa92896242dbfd827c6b8707eeb36f0855ce4c57d23469e42 |
| 2026-10-11 15:32 | `setOperator`: the staging server wallet becomes the operator | 59308707 | https://testnet.snowtrace.io/tx/0xcca9d1976ab774685cef487e1475ee685f19960e5af56ba73973a731c1e9f9f7 |
| 2026-10-11 15:32 | Server wallet funded with 0.002 test AVAX for gas | 59308703 | https://testnet.snowtrace.io/tx/0xe931ef101e016bbad59cc04a1a8db6b147c55e495bbcd013e98811e6af9dc3c3 |
| 2026-10-11 14:08 | First anchor: `keccak256("commodex-m0-2026-10")` = `0x8b8d8a98…eae3fc00`, kind `TEST`, ref "M0 first hash" | 59306896 | https://testnet.snowtrace.io/tx/0x2384d975b453a523524346ce7cd00e8d039bd8c4b6e7ec2ea73e1f5970077bef |
| 2026-10-11 14:07 | Deploy CommodexAnchor | 59306874 | https://testnet.snowtrace.io/tx/0x24efb4ba147d4dab9cd9ae98a11edddd53b4ae4dc1cd861f5a8b44a66a3673a4 |
| 2026-10-11 | Source verified on the explorer (solc 0.8.24, optimizer 200, EVM paris) | — | https://testnet.snowtrace.io/address/0xe274C452dFb0D259FA413EEd3a830197a4Fd50ef/contract/43113/code |

Check it yourself: `node anchor.mjs check "commodex-m0-2026-10"` prints `anchored in block 59306896`. The deploy
transaction's input is byte-for-byte the bytecode in [`build/CommodexAnchor.json`](build/CommodexAnchor.json).

## Escrow evidence

Raw record: [`evidence/fuji-escrow.json`](evidence/fuji-escrow.json).

| Date (UTC) | Step | Block | Explorer |
|---|---|---|---|
| 2026-11-02 | Buyer releases 1 USDC to the seller: trade `RELEASED` | 60383096 | https://testnet.snowtrace.io/tx/0xa69f086729fcd392e3e5d29989aa561a7135f44e3bee290813ef4405e25da9c9 |
| 2026-11-02 | Buyer funds trade `0x96399d96…` with 1 USDC, 7-day deadline | 60383092 | https://testnet.snowtrace.io/tx/0x68fe1c6fade7af222b4aa99363c8d7eb52d578ac63242733de14c43d4359d519 |
| 2026-11-02 | Buyer approves the escrow to pull 1 USDC | 60383091 | https://testnet.snowtrace.io/tx/0x4b09b23075d24f893534be4ecd54a462f12fdaea7a27957e239ae7bb719ce55b |
| 2026-11-01 20:43 | Deploy CommodexEscrow v2 (token Circle Fuji USDC `0x5425890298aed601595a70AB815c96711a31Bc65`, operator `0x215edFA8C9Db88A972FbEDb810b884ADe94fca7B`, fee 0) | 60366934 | https://testnet.snowtrace.io/tx/0xa97409ec2d65e404c6e40cee52b9db715556ba1050282f0c2727b2c1435ca293 |
| 2026-11-01 | Source verified on the explorer (solc 0.8.24, optimizer 200, EVM paris) | — | https://testnet.snowtrace.io/address/0xe453ebae20f06d53c44946b15A35E0e790A3089e/contract/43113/code |

Read back from the chain on 1 Nov 2026: `token()` = Circle Fuji USDC, `operator()` = the Commodex server wallet,
`feeBps()` = 0, `DEFAULT_WINDOW()` = 604800 s (7 days), `OPERATOR_GRACE()` = 2592000 s (30 days), `paused()` = false.

First trade lifecycle on Fuji (2 Nov 2026): the deployer wallet acts as buyer with Circle faucet USDC, funds
trade `0x96399d96379d44e33173ac6aa2d9ceeb36d40779a8cf10bd75676bfcd5966983` and releases it. In this demonstration the seller is a stand-in, the Commodex operator
wallet; no real counterparty is involved. `node escrow.mjs status 0x96399d96379d44e33173ac6aa2d9ceeb36d40779a8cf10bd75676bfcd5966983` prints `RELEASED`.

## License

MIT — see [LICENSE](LICENSE).
