# commodex-agent-avalanche-contracts

Avalanche escrow contracts agent for the Commodex Avalanche C-Chain setup. Commodex: https://commodex.xyz/

- Production: https://commodex.xyz
- Testnet UI: https://wedevnext.commodex.xyz
- Network: Avalanche Fuji C-Chain (EVM), chain id `43113`

## Agent

| | |
|---|---|
| Person | Emilija Jankauskaitė |
| Role | Avalanche contracts — writes and explains the Avalanche escrow contracts |
| FR scope | FR-03 |
| Squad page | https://team.impactcapital.ltd/showcase/commodex/ |

## Status — 11 October 2026

**CommodexAnchor v0 is deployed on Avalanche Fuji, source verified on the explorer, first hash anchored.**

| Contract | What it does | State |
|---|---|---|
| [`contracts/CommodexAnchor.sol`](contracts/CommodexAnchor.sol) | Stores a 32-byte hash and the block it was mined in; emits `Anchored`. No funds, no token, no personal data. Only the operator may anchor; one hash once. | Deployed 11 Oct 2026 at [`0xe274C452dFb0D259FA413EEd3a830197a4Fd50ef`](https://testnet.snowtrace.io/address/0xe274C452dFb0D259FA413EEd3a830197a4Fd50ef); 7/7 local tests |
| `CommodexEscrow.sol` | Test-USDC escrow: fund, release after assay and custody, refund after a deadline | Not written yet (Phase 3 rehearsal, reviewed first by [contract assurance](https://github.com/Impact-Capital-Management/commodex-agent-contract-assurance)) |

## Run

```bash
npm install
npm test                                   # 7 checks on an in-memory chain, no Fuji funds
COMMODEX_FUJI_KEY_FILE=/path/key node anchor.mjs whoami   # address + balance, sends nothing
COMMODEX_FUJI_KEY_FILE=/path/key node anchor.mjs deploy
COMMODEX_FUJI_KEY_FILE=/path/key node anchor.mjs anchor "<text or 0x hash>" TEST "<ref>"
node anchor.mjs check "<text or 0x hash>"
```

`anchor.mjs` refuses any RPC that does not answer chain id 43113. Each mined transaction is appended to
`evidence/fuji-evidence.json` with its explorer link. Measured deploy cost on 11 Oct 2026: about 272,000 gas,
far below 0.000001 AVAX.

## Evidence

Network: Avalanche Fuji C-Chain, chain id 43113. Operator and deployer: `0xa6547c2812140c0495113d4490eb0f2805A67ecD`.
Raw record: [`evidence/fuji-evidence.json`](evidence/fuji-evidence.json).

| Date (UTC) | Step | Block | Explorer |
|---|---|---|---|
| 2026-10-11 14:08 | First anchor: `keccak256("commodex-m0-2026-10")` = `0x8b8d8a98…eae3fc00`, kind `TEST`, ref "M0 first hash" | 59306896 | https://testnet.snowtrace.io/tx/0x2384d975b453a523524346ce7cd00e8d039bd8c4b6e7ec2ea73e1f5970077bef |
| 2026-10-11 14:07 | Deploy CommodexAnchor | 59306874 | https://testnet.snowtrace.io/tx/0x24efb4ba147d4dab9cd9ae98a11edddd53b4ae4dc1cd861f5a8b44a66a3673a4 |
| 2026-10-11 | Source verified on the explorer (solc 0.8.24, optimizer 200, EVM paris) | — | https://testnet.snowtrace.io/address/0xe274C452dFb0D259FA413EEd3a830197a4Fd50ef/contract/43113/code |

Check it yourself: `node anchor.mjs check "commodex-m0-2026-10"` prints `anchored in block 59306896`. The deploy
transaction's input is byte-for-byte the bytecode in [`build/CommodexAnchor.json`](build/CommodexAnchor.json).

## License

MIT — see [LICENSE](LICENSE).
