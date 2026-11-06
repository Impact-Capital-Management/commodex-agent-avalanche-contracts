# CommodexEscrow v3: handover for the senior developer

Date: 6 November 2026. Testnet only (Avalanche Fuji, chain id 43113).

## Why

On 6 Nov 2026, KupiaSec (an unsolicited security firm) reported an issue in the deployed `CommodexEscrow` v2
(`0xe453ebae20f06d53c44946b15A35E0e790A3089e`). We checked it and it is real.

- `createAndFund(tradeId, seller, amount, deadline)` did not tie `tradeId` to the buyer, seller or amount.
- Anyone who saw a buyer's transaction in the mempool, or could predict the ledger's trade hash, could fund the
  same `tradeId` first with their own seller and 1 unit of USDC. The real buyer then reverts with `TradeExists`.
- The attacker refunds themselves, and the id stays REFUNDED forever: any trade can be blocked for the cost of gas.
- If the ledger trusts `EscrowFunded` by `tradeId` alone, a 1-unit deposit could pass for a funded trade.
- Second point: `feeBps` was read at payout, so an owner fee change also hit trades that were already open.

## What changed in v3 (already done, in this folder)

- `contracts/CommodexEscrow.sol`:
  - `createAndFund(tradeId, seller, amount, deadline, operatorSig)` needs an EIP-712 signature by the **current
    operator** over `Fund(bytes32 tradeId, address buyer, address seller, uint256 amount, uint64 deadline)`,
    where `buyer = msg.sender`.
  - Domain: name `CommodexEscrow`, version `3`, chainId, verifyingContract = the escrow.
  - Refused: high-s signatures, wrong length, other chain or other contract, and signatures from a replaced operator.
  - New public views: `fundDigest(...)` and `domainSeparator()`.
  - New error: `BadAuthorization`.
  - The fee is fixed at funding: the `Escrow` struct gains `uint16 feeBps` **before** `status`.
- `test/escrow.test.mjs`: 18/18 groups pass, including the attack and the fee lock-in. The anchor tests pass 7/7.
- `escrow.mjs`:
  - `deploy` now deploys v3 and moves the v2 record to `previous` in `evidence/fuji-escrow.json`.
  - `demo` signs with the operator key (`COMMODEX_OPERATOR_KEY_FILE`).
- `docs/escrow-spec.md`: §3.1 (authorization), §9 (history and migration).
- Not committed, not pushed, not deployed yet.

Check it:

```bash
npm install --no-package-lock
npm run test:all          # expect 7/7 and 18/18
```

## Steps for the senior developer

### A. Review and publish the code
1. Review the diff in `contracts/CommodexEscrow.sol` and `test/escrow.test.mjs`.
2. Run `npm run test:all`.
3. Commit and push to `Impact-Capital-Management/commodex-agent-avalanche-contracts`.

### B. Deploy v3 on Fuji
1. Use the owner wallet `0xa6547c2812140c0495113d4490eb0f2805A67ecD`. It needs some test AVAX from the Fuji faucet.
2. Deploy on the Commodex server (`src-tokenomy`, folder `/opt/src/commodex-escrow-v3-fix`). The host has no
   Node.js, so `deploy-v3.sh` runs it in the `node:22-alpine` Docker image. The operator defaults to the staging
   server wallet `0x215edFA8C9Db88A972FbEDb810b884ADe94fca7B`:
   ```bash
   cd /opt/src/commodex-escrow-v3-fix
   ./deploy-v3.sh /root/owner.key whoami   # must show 0xa6547c…7ecD and some AVAX; sends nothing
   ./deploy-v3.sh /root/owner.key deploy
   shred -u /root/owner.key                # remove the key from the server afterwards
   ```
3. Verify the source on Snowtrace with the same settings as v2: solc 0.8.24, optimizer on (200 runs), EVM `paris`,
   no constructor changes (token, operator, feeRecipient).
4. Put the new address and block in `docs/escrow-spec.md` and `README.md`.
5. Commit `evidence/fuji-escrow.json`.

### C. Retire v2
1. Call `pause()` on v2 from the owner wallet. This blocks new trades only.
2. Settle any v2 trades that are still open: release, refund or resolve.

### D. Update the Commodex app (staging only)
Code: `src/modules/commodex/domain/escrow.ts` and `src/modules/commodex/api/escrow.ts` in the app. The public copy
is in `commodex-agent-avalanche-engineering/app`.

1. **Address and ABI, changed together:**
   - Set `FUJI_ESCROW_CONTRACT` and `FUJI_ESCROW_DEPLOY_BLOCK` (or `CDX_ESCROW_CONTRACT`) to the v3 values.
   - `escrows(bytes32)` now returns `(buyer, seller, amount, deadline, createdAt, feeBps, status)`. **`status` moves
     from index 5 to index 6.** Fix `readTrade()`, otherwise every status shows wrong.
   - Add `createAndFund(bytes32,address,uint256,uint64,bytes)`, `fundDigest(bytes32,address,address,uint256,uint64)`
     and `domainSeparator()` to the ABI.
2. **Funding authorization endpoint (new):**
   - For a trade the ledger has agreed, sign `Fund(tradeId, buyer, seller, amount, deadline)` with the operator
     server wallet (the same key as the anchor, `CDX_ANCHOR_KEY_FILE`).
   - Use `wallet.signTypedData(domain, types, message)` from ethers v6. The domain is
     `{ name: 'CommodexEscrow', version: '3', chainId: 43113, verifyingContract: <v3 address> }`.
   - Sign only terms read from the ledger record, never terms the caller sends. Make sure `buyer` is the buyer's
     connected wallet.
   - Before returning the signature, compare `TypedDataEncoder.hash(...)` with `fundDigest(...)` on-chain.
   - Record each issued authorization in the ledger stream `escrow`, for example as `escrow.authorized`.
   - The buyer's wallet then calls `createAndFund(..., signature)`.
3. **Ledger ingestion:** when reading `EscrowFunded`, compare buyer, seller, amount and deadline with the ledger
   record, not only `tradeId`.
4. **Operator panel:** show the per-trade `feeBps` from `escrows(id)`, not the global `feeBps()`.
5. **Tests:** update `escrow.test.ts` (status index, new ABI entries) and add one test that checks the app's
   digest against the contract's.

### E. Check end to end on staging
1. Make a 1 USDC trade: authorize, fund, release. Circle test USDC comes from https://faucet.circle.com/.
   Or use the script:
   ```bash
   COMMODEX_FUJI_KEY_FILE=buyer.key COMMODEX_OPERATOR_KEY_FILE=operator.key node escrow.mjs demo 1 <seller>
   ```
   Note that the operator key is the staging server wallet, so run it where that key lives.
2. Try to fund the same `tradeId` from another wallet without a signature. It must revert with `BadAuthorization`.
3. Check that the operator panel shows the trade with the right status.

### F. Security notes
- The operator key now also approves every new escrow, on top of force-release, refund and dispute resolution.
  Keep it on the server only. Keep the owner key offline and separate, so the operator can be replaced with
  `setOperator`.
- The contract has no external audit. Get one before any mainnet use. The KupiaSec offer is optional; any firm works.
- Production stays without an escrow console in this phase. Do not point production at a testnet contract.
