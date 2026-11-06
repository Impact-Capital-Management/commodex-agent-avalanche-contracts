# CommodexEscrow — specification (v3, 6 November 2026)

**Status:** v3 deployed on Fuji on 6 Nov 2026 and source verified. v2 (`0xe453…089e`) is paused and retired: anyone could claim a trade id before the buyer (see §9). Testnet only.
**Assumption:** every party settles in one stablecoin (USDC). FX, multi-currency and price conversion are out of scope for this contract; they stay in the Commodex application.

| | |
|---|---|
| Network | Avalanche Fuji C-Chain, chain id `43113` |
| Contract (v3) | [`0x9B8691C642d9caB3A1299b10EF24ed5dc74b6432`](https://testnet.snowtrace.io/address/0x9B8691C642d9caB3A1299b10EF24ed5dc74b6432) |
| Deploy transaction (v3) | [`0x306726b3…243294293`](https://testnet.snowtrace.io/tx/0x306726b359bb198368839f7d991249e5c9a81e14d750208cedf3135243294293), block 60644849, 6 Nov 2026 |
| Retired v2 (paused) | [`0xe453ebae20f06d53c44946b15A35E0e790A3089e`](https://testnet.snowtrace.io/address/0xe453ebae20f06d53c44946b15A35E0e790A3089e), deployed block 60366934 (1 Nov 2026), paused block 60644883 ([`tx`](https://testnet.snowtrace.io/tx/0x9065c427333564768e524ea91cb279ad82d942c5032e4a470a31f3c6fa3f0f8d)) |
| Token | Circle test USDC on Fuji, [`0x5425890298aed601595a70AB815c96711a31Bc65`](https://testnet.snowtrace.io/address/0x5425890298aed601595a70AB815c96711a31Bc65), 6 decimals (address from https://developers.circle.com/stablecoins/usdc-contract-addresses ) |
| Operator | Commodex staging server wallet `0x215edFA8C9Db88A972FbEDb810b884ADe94fca7B` |
| Owner and fee recipient | Deployer `0xa6547c2812140c0495113d4490eb0f2805A67ecD` |
| Compiler | solc 0.8.24, optimizer on (200 runs), EVM `paris`, no dependencies, no proxy |

## 1. Purpose

Hold a buyer's USDC for one trade. Pay the seller when the buyer confirms delivery. Let Commodex, as operator, supervise: it can complete a trade the buyer leaves open, refund on the seller's behalf, and decide disputes. The contract proves the escrow lifecycle on Fuji. It is not a production payment system.

## 2. Roles

| Role | Who | Can do |
|---|---|---|
| Buyer | The trade's buyer address | Create and fund an escrow with the operator's authorization; **release** to the seller; open a dispute |
| Seller | The trade's seller address | Refund the buyer; open a dispute |
| Operator | Commodex (server wallet) | **Authorize** each escrow's terms (off-chain signature); **force release** after the deadline; refund on the seller's behalf; **resolve** disputes |
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

### 3.1 Funding authorization (v3)

`createAndFund(tradeId, seller, amount, deadline, operatorSig)` only succeeds if `operatorSig` is a 65-byte EIP-712 signature by the **current operator** over:

```text
domain  EIP712Domain(name "CommodexEscrow", version "3", chainId, verifyingContract = this escrow)
message Fund(bytes32 tradeId, address buyer, address seller, uint256 amount, uint64 deadline)
        where buyer = msg.sender
```

The Commodex ledger issues this signature with the operator server wallet when a trade is agreed, and hands it to the buyer's wallet. Consequences:

- Nobody can open an escrow under a trade id with terms the ledger did not approve, so a trade id cannot be squatted by front-running or prediction.
- Copying the buyer's pending transaction does not help an attacker: the signature names the buyer, and the contract compares it with `msg.sender`.
- Every `EscrowFunded` event carries terms the ledger signed. The ledger should still compare buyer, seller and amount with its own record.
- High-s (malleable) signatures, wrong lengths, signatures for another chain or another escrow address, and signatures from a replaced operator are refused (`BadAuthorization`).
- The signed `deadline` also works as the authorization's expiry: once it is less than 1 hour away, funding is refused (`BadDeadline`).

`fundDigest(...)` and `domainSeparator()` are public, so the app can check its own hashing against the contract.

## 4. Decisions (owner, 1 November 2026)

1. **Release:** the buyer releases, under the operator's supervision. The operator cannot release early.
2. **Forced release:** if the buyer has not released by the deadline, the operator may force the release to the seller (`forceRelease`). The buyer who disagrees must open a dispute before that.
3. **Deadline:** 7 days by default (`DEFAULT_WINDOW`). The application sets it; the contract accepts 1 hour to 30 days.
4. **Fee:** 0% on testnet. The contract caps any fee at 3% (`MAX_FEE_BPS = 300`). From v3, each trade keeps the fee rate in force when it was funded (`escrows(id).feeBps`); a later `setFee` applies to new trades only.
5. **Disputes:** the operator resolves them first and only. A disputed trade never expires and cannot be force-released.
6. **Token:** Circle's test USDC on Fuji. Our own test token (`tUSDC`) stays in the repo for the adversarial local tests.

**Backstop (added for liveness):** if the operator does nothing for 30 days after the deadline on an undisputed trade, anyone may return the funds to the buyer (`OPERATOR_GRACE`). If the operator key is lost, the owner can also appoint a new operator.

## 5. Safety properties

- **No stuck funds in open trades:** pause blocks new escrows only.
- **Re-entrancy guard** on every function that moves funds; state changes before transfers.
- **Exact funding:** a balance check on deposit rejects fee-on-transfer tokens.
- **Bounds:** amount between 1 unit and 1,000,000 USDC; seller ≠ buyer; no zero addresses or zero trade id.
- **Operator-authorized funding (v3):** see §3.1. This makes the operator key even more central: it already force-releases, refunds and resolves disputes, and now it also approves every new escrow. Keep it on the server only, and keep the owner key separate so the operator can be replaced.
- **No upgrade path:** a change means a new deployment and a new address.
- **No personal data on-chain:** the trade id is a hash from the Commodex ledger.

## 6. Events (read by the Commodex ledger)

`EscrowFunded`, `EscrowReleased`, `EscrowReleasedBy` (BUYER / OPERATOR_FORCED / OPERATOR_RESOLVED), `EscrowRefunded` (REFUND / EXPIRED / RESOLVED), `EscrowDisputed`, `EscrowResolved`, plus owner events for operator, fee, pause and ownership.

## 7. Known limits

- Circle USDC can block addresses. A blocked seller or buyer makes the payout revert; the operator then resolves the other way or waits for the block to lift.
- One token per deployment. Another stablecoin or another EVM chain means another deployment of the same source.
- No partial release, no milestones, no interest.

## 8. Tests

`npm run test:escrow` runs 18 test groups on a local chain, no Fuji funds: happy path, fee, buyer-only release, forced release timing and access, backstop timing, dispute flows, dispute without expiry, 7-day window, input limits, pause, admin access, two-step ownership, re-entrant token, fee-on-transfer token, final states, trade-id squatting (no, copied, foreign, tampered, malleable, cross-contract and old-operator signatures), fee fixed at funding. 18/18 passed on 6 Nov 2026; the anchor suite still passes 7/7.

## 9. History

- v1 (29 Oct 2026, commit `8d8be70`, never deployed): buyer or operator could release at any time; a disputed trade expired to the buyer at the deadline; own test token.
- v2 (1 Nov 2026): owner decisions above; deployed on Fuji at `0xe453…089e`. **Retired:** paused 6 Nov 2026 (block 60644883); its only trade was already released.
- v3 (6 Nov 2026, this document, deployed at `0x9B8691C642d9caB3A1299b10EF24ed5dc74b6432`, block 60644849, source verified): fixes an issue reported by KupiaSec on 6 Nov 2026. In v2, `tradeId` was not tied to buyer, seller or amount. Anyone who saw a buyer's `createAndFund` in the mempool, or could predict the ledger's trade hash, could fund the same id first with their own seller and 1 unit, then refund themselves. The id was then stuck in REFUNDED forever, and a 1-unit `EscrowFunded` event could be mistaken for the real trade. v3 requires the operator's signature over the full terms (§3.1). It also fixes the fee rate at funding, because in v2 an owner fee change applied to trades that were already open.

### Moving the app to v3

1. Deploy: `COMMODEX_FUJI_KEY_FILE=… node escrow.mjs deploy` (owner key). The v2 record moves to `previous` in `evidence/fuji-escrow.json`. Verify the source on Snowtrace.
2. In the app (`commodex-agent-avalanche-engineering/app`), change the address and deploy block together with the ABI: `escrows(bytes32)` now returns `(buyer, seller, amount, deadline, createdAt, feeBps, status)`, so `status` moves to index 6. Add `createAndFund(bytes32,address,uint256,uint64,bytes)`, `fundDigest` and `domainSeparator`.
3. Add a ledger endpoint that, for an agreed trade, signs `Fund(tradeId, buyer, seller, amount, deadline)` with the operator server wallet and returns the signature to the buyer's wallet. Sign only terms that match the ledger record, and compare the signed digest with `fundDigest(...)` on-chain.
4. When ingesting `EscrowFunded`, keep comparing buyer, seller and amount with the ledger record, not only `tradeId`.
5. Pause v2 (`pause()` as owner) so no new trades open there. Open v2 trades can still be settled.
