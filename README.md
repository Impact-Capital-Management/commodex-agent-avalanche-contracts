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

**Built and tested locally. Not yet deployed on Fuji.**

| Contract | What it does | State |
|---|---|---|
| [`contracts/CommodexAnchor.sol`](contracts/CommodexAnchor.sol) | Stores a 32-byte hash and the block it was mined in; emits `Anchored`. No funds, no token, no personal data. Only the operator may anchor; one hash once. | 7/7 local tests pass; deploy is the next step (gate M0 / milestone M2.2) |
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

| Step | Transaction | Explorer |
|---|---|---|
| Deploy CommodexAnchor | — not yet mined — | |
| First anchor | — not yet mined — | |

Nothing in this repository is a claim of a deployed contract until a row above carries a Fuji explorer link.

## License

MIT — see [LICENSE](LICENSE).
