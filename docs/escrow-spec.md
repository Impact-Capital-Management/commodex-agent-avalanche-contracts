# CommodexEscrow — specification (v2, 1 November 2026)

**Status:** deployed on Avalanche Fuji testnet, source verified on the explorer. Testnet only.
**Assumption:** every party settles in one stablecoin (USDC). FX, multi-currency and price conversion are out of scope for this contract; they stay in the Commodex application.

| | |
|---|---|
| Network | Avalanche Fuji C-Chain, chain id `43113` |
| Contract | [`0xe453ebae20f06d53c44946b15A35E0e790A3089e`](https://testnet.snowtrace.io/address/0xe453ebae20f06d53c44946b15A35E0e790A3089e) |
| Deploy transaction | [`0xa97409ec…1435ca293`](https://testnet.snowtrace.io/tx/0xa97409ec2d65e404c6e40cee52b9db715556ba1050282f0c2727b2c1435ca293), block 60366934, 1 Nov 2026 |
| Token | Circle test USDC on Fuji, [`0x5425890298aed601595a70AB815c96711a31Bc65`](https://testnet.snowtrace.io/address/0x5425890298aed601595a70AB815c96711a31Bc65), 6 decimals (address from https://developers.circle.com/stablecoins/usdc-contract-addresses ) |
| Operator | Commodex staging server wallet `0x215edFA8C9Db88A972FbEDb810b884ADe94fca7B` |
| Owner and fee recipient | Deployer `0xa6547c2812140c0495113d4490eb0f2805A67ecD` |
| Compiler | solc 0.8.24, optimizer on (200 runs), EVM `paris`, no dependencies, no proxy |

## 1. Purpose

Hold a buyer's USDC for one trade. Pay the seller when the buyer confirms delivery. Let Commodex, as operator, supervise: it can complete a trade the buyer leaves open, refund on the seller's behalf, and decide disputes. The contract proves the escrow lifecycle on Fuji. It is not a production payment system.

## 2. Roles

| Role | Who | Can do |
|---|---|---|
| Buyer | The trade's buyer address | Create and fund an escrow; **release** to the seller; open a dispute |
| Seller | The trade's seller address | Refund the buyer; open a dispute |
| Operator | Commodex (server wallet) | **Force release** after the deadline; refund on the seller's behalf; **resolve** disputes |
| Owner | Deployer wallet | Pause / unpause new escrows; set operator; set fee (≤ 3%) and fee recipient; two-step ownership transfer |
| Anyone | — | Backstop refund to the buyer, only 30 days after the deadline on an undisputed trade |

## 3. Lifecycle

```text
                 createAndFund (buyer)
   NONE ───────────────────────────────▶ FUNDED
                                          │
       release (buyer, any time) ─────────┼──────────────▶ RELEASED (seller paid, fee deducted)
       forceRelease (operator, ≥ deadline)┤
                                          │
       refund (seller or operator) ───────┼──────────────▶ REFUNDED (buyer paid in full)
       expire (anyone, ≥ deadline + 30 d) ┤
                                          │
       dispute (buyer or seller) ─────────▼
                                       DISPUTED
                                          │ resolve (operator only)
                                          ├── toSeller = true  ──▶ RELEASED
                                          └── toSeller = false ──▶ REFUNDED
```

RELEASED and REFUNDED are final. A trade id can never be reused.

## 4. Decisions (owner, 1 November 2026)

1. **Release:** the buyer releases, under the operator's supervision. The operator cannot release early.
2. **Forced release:** if the buyer has not released by the deadline, the operator may force the release to the seller (`forceRelease`). The buyer who disagrees must open a dispute before that.
3. **Deadline:** 7 days by default (`DEFAULT_WINDOW`). The application sets it; the contract accepts 1 hour to 30 days.
4. **Fee:** 0% on testnet. The contract caps any fee at 3% (`MAX_FEE_BPS = 300`).
5. **Disputes:** the operator resolves them first and only. A disputed trade never expires and cannot be force-released.
6. **Token:** Circle's test USDC on Fuji. Our own test token (`tUSDC`) stays in the repo for the adversarial local tests.

**Backstop (added for liveness):** if the operator does nothing for 30 days after the deadline on an undisputed trade, anyone may return the funds to the buyer (`OPERATOR_GRACE`). If the operator key is lost, the owner can also appoint a new operator.

## 5. Safety properties

- **No stuck funds in open trades:** pause blocks new escrows only.
- **Re-entrancy guard** on every function that moves funds; state changes before transfers.
- **Exact funding:** a balance check on deposit rejects fee-on-transfer tokens.
- **Bounds:** amount between 1 unit and 1,000,000 USDC; seller ≠ buyer; no zero addresses or zero trade id.
- **No upgrade path:** a change means a new deployment and a new address.
- **No personal data on-chain:** the trade id is a hash from the Commodex ledger.

## 6. Events (read by the Commodex ledger)

`EscrowFunded`, `EscrowReleased`, `EscrowReleasedBy` (BUYER / OPERATOR_FORCED / OPERATOR_RESOLVED), `EscrowRefunded` (REFUND / EXPIRED / RESOLVED), `EscrowDisputed`, `EscrowResolved`, plus owner events for operator, fee, pause and ownership.

## 7. Known limits

- Circle USDC can block addresses. A blocked seller or buyer makes the payout revert; the operator then resolves the other way or waits for the block to lift.
- One token per deployment. Another stablecoin or another EVM chain means another deployment of the same source.
- No partial release, no milestones, no interest.

## 8. Tests

`npm run test:escrow` runs 16 test groups on a local chain, no Fuji funds: happy path, fee, buyer-only release, forced release timing and access, backstop timing, dispute flows, dispute without expiry, 7-day window, input limits, pause, admin access, two-step ownership, re-entrant token, fee-on-transfer token, final states. 16/16 passed on 1 Nov 2026; the anchor suite still passes 7/7.

## 9. History

- v1 (29 Oct 2026, commit `8d8be70`, never deployed): buyer or operator could release at any time; a disputed trade expired to the buyer at the deadline; own test token.
- v2 (1 Nov 2026, this document): owner decisions above; deployed on Fuji.
