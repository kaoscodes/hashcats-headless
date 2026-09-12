# Hashcats miner protocol study

Inspected on September 12, 2026. This study uses the deployed browser bundles, the rendered project documentation, and read-only calls to the live collection. The explorer source API returned HTTP 403 and Sourcify did not have a full match at the queried path. Contract behavior below is supported by the public ABI, browser code, and live calls; a complete Solidity source audit was not possible.

## Evidence

- [Mining UI](https://hashcats.fun/mine)
- [Project documentation](https://hashcats.fun/docs)
- [Application bundle](https://hashcats.fun/assets/index-BESYYCQ4.js)
- [GPU worker](https://hashcats.fun/assets/gpu.worker-BNBpr-u3.js)
- [CPU worker](https://hashcats.fun/assets/cpu.worker-CzK-dBIZ.js)
- [Collection explorer](https://robinhoodchain.blockscout.com/address/0xCA75DF55Cc9C476DB27a7375D1fc8E794cf80721)

The inspected bundles had the following SHA-256 digests. The collection ABI was extracted from the application; the required functions are declared in `src/chain.js`. Downloaded third-party bundles and temporary research artifacts are not included in this repository.

| Bundle | SHA-256 |
| --- | --- |
| index.js | `97beff268571b5235f9802fcffbace05ed9adcb19240a4c9c7b2495dcde2eb91` |
| cpu.worker.js | `b84685324ce2491f447f84f232e7f9583a51fcd202e55ab8875d5d82636a14ca` |
| gpu.worker.js | `c26f56405edf6b7612d96f0f0b3df226c1d094c3e240da48fbafcc8812cab50a` |

## Network and contract

| Item | Value |
| --- | --- |
| Chain | Robinhood Chain |
| Chain ID | 4663 |
| Collection | `0xCA75DF55Cc9C476DB27a7375D1fc8E794cf80721` |
| Primary RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Fallback RPC | `https://robinhood.drpc.org` |
| Mint entry point | `mine(uint256 nonce, uint256 anchorBlock) payable` |
| Hash oracle | `workHash(address miner, uint256 nonce, uint256 prev, bytes32 anchor)` |

This is proof of work for an NFT mint. There is no Stratum server, pool login, share-difficulty protocol, or HTTP proof-submission endpoint in the inspected mining path. The browser reads chain state through RPC and submits an Ethereum transaction through the connected wallet. The ETH entry price is separate from transaction gas.

## Exact hash

```text
work = keccak256(abi.encodePacked(miner, nonce, prevWork, anchor))
valid = uint256(work) < targetFor(miner)
```

| Offset | Bytes | Value |
| --- | ---: | --- |
| 0 | 20 | Miner address |
| 20 | 32 | Nonce, unsigned big-endian uint256 |
| 52 | 32 | Previous work, unsigned big-endian uint256 |
| 84 | 32 | Recent L2 block hash |
| Total | 116 | Packed input |

This is Ethereum Keccak-256, not standardized SHA3-256 and not normal 32-byte-padded ABI encoding for the address. The 116-byte message fits one 136-byte Keccak rate block. Padding is byte `0x01` at offset 116 and byte `0x80` at offset 135. Keccak lanes absorb bytes little-endian; the resulting digest is compared as a big-endian 256-bit integer.

The target comparison is strictly less than across all 256 bits. Counting leading zero bits alone is insufficient for arbitrary targets, including equality. The contract's `workHash` agrees with the local CPU implementation. The deployed GPU worker's CPU verifier agrees on 100 randomized messages, including full-width nonces. The new GPU shader agrees with the CPU implementation over 3,082 samples and five target boundaries.

## Work lifecycle

The application reads `currentAnchor()`, `prevWork()`, and `targetFor(address)`. It also reads the price, global target, and other UI statistics. The wallet target matters because personal mining history can affect difficulty. Reimplementing the displayed difficulty formulas is unnecessary and would risk diverging from contract rules.

`currentAnchor()` returns both the anchor's L2 block number and its hash. Use these together. The project's docs describe `ArbSys.arbBlockHash` as the source and a window of 250 L2 blocks, about 25 seconds at the documented block cadence. The live `ANCHOR_WINDOW()` call returned 250. The block-number argument to `mine` is the original anchor block, not the current block at submission.

A successful mint replaces `prevWork`, invalidating all work tied to the previous cat. Anchor expiration can also invalidate a solution even if nobody mints. Target changes can invalidate a previously qualifying hash. The new miner reads all job fields at the same RPC block and refreshes the anchor every successful poll. It keeps the old job alongside any candidate so simulation uses that candidate's original input.

The browser improves refresh latency using live block notifications and collection logs, with HTTP polling as a fallback. This implementation uses pinned HTTP snapshots every 500 ms plus request time, and pauses after three seconds without fresh state. It can waste work during this detection interval. A WebSocket fast path could reduce that interval, but the fresh preflight and contract simulation remain necessary because there is always a race before transaction inclusion.

## Deployed CPU worker

The CPU worker contains embedded WebAssembly binaries, including a SIMD paired path and a scalar fallback, plus a JavaScript implementation. It pads the same one-block input, chooses a stream, walks a counter, and adapts batch size toward short execution slices. A MessageChannel schedules further batches without blocking the UI thread.

The JavaScript hash uses bit-interleaved 32-bit words to represent Keccak's 64-bit lanes. Stream and counter conversion produce a uint64 nonce within the contract's uint256 nonce field. This nonce layout is a search strategy, not a contract requirement. Progress reports include hash count, best depth, and a depth histogram.

The replacement CPU engine uses independent noble-hashes Keccak in Node worker threads. It partitions each batch without overlap. It is slower than the site's specialized WASM path and is provided as a portable fallback, not as a claim of CPU performance parity.

## Deployed GPU worker

The worker requests a hardware WebGPU adapter and rejects software renderers. Its embedded WGSL represents Keccak lanes with interleaved even and odd bits. Each invocation walks several counters, with workgroup and batch sizing constrained by device limits. The shader aggregates the depth histogram in workgroup memory to reduce global atomic contention and records rare candidate counters. The CPU recomputes candidate hashes and checks the full target before reporting a solution.

Those histograms and near-miss images support the browser UI. The headless implementation omits them from normal mining. Its independent WGSL generator uses 25 scalar `vec2<u32>` lanes, Keccak's standard rotation offsets, and LFSR-generated round constants. It supports both low/high halves via `--kernel split` and even/odd bit interleaving via `--kernel interleaved`. Interleaving is now the default because it reduced rotation instructions and improved measured throughput on this M4 Pro. The round state has no dynamically indexed arrays. Only a winning offset is transferred back during normal operation.

Each invocation tries 16 nonces by default. A single `atomicMin` selects the earliest qualifying offset in a batch. This is enough because every qualifying candidate is competing for the same next mint. A debug mode returns full hashes for differential tests. GPU startup runs its own short comparison, and every reported winner is checked again on the CPU.

The search uses a random 224-bit prefix and a sequential big-endian low 32-bit counter. A new job or counter exhaustion starts a fresh prefix. Independent devices therefore have negligible overlap without needing a coordination server. Batches explicitly prohibit counter wrap.

## Submission

The browser's mint path reads `mintPrice`, simulates `mine(nonce, anchorBlock)` with the connected account and exact ETH value, then estimates gas and asks the wallet to send it.

The headless path performs equivalent preparation and adds price, gas-limit, fee-per-gas, and successful-mint-count ceilings. It derives the mining address from the local signing key, checks any supplied address against it, and builds an EIP-1559 call to the collection. Tests deserialize the signed transaction and verify the destination, calldata, value, chain ID, and recovered signer.

Before broadcast, the exact signed bytes and hash are saved locally. An ambiguous broadcast failure stops the process; it does not silently sign a replacement transaction. Successful receipt status is required. A proof can still expire or lose a race between simulation and inclusion, causing a paid revert. Automatic replacement transactions, persistent nonce coordination across processes, and external-wallet signing are outside this implementation.

## Measurements and validation limits

On the available Apple M4 Pro, the initial 5-second GPU benchmark measured approximately 348 MH/s. Before optimization, an 8-second live run computed 2,661,285,888 hashes with state refresh enabled, roughly 333 MH/s including RPC and event-loop overhead. Two CPU workers measured approximately 0.89 MH/s. A subsequent 10-second benchmark of the original configuration measured 350.8 MH/s.

The benchmark uses a zero target so no winning nonce causes early exit or repeated CPU verification. The hash input and target are runtime storage-buffer data, and the hash loop is the same one used for live mining. Short measurements are affected by temperature, power mode, and other GPU use.

Native Dawn supports the Metal, Vulkan, and D3D12 backends used here. See the [Dawn Node documentation](https://github.com/dawn-gpu/node-webgpu). Metal compute, independent hash comparisons, live contract hash calls, live job refresh, duration limits, CPU workers, offline signing, and SIGINT shutdown were tested. No private wallet was supplied and no paid transaction was broadcast. NVIDIA throughput, driver compatibility, and an actual successful mint remain hardware/account-dependent validation steps.

## Optimization follow-up

A serial sweep tested workgroups of 64, 128 and 256, per-invocation counts of 4, 16 and 64, and batches of 1,048,576 and 8,388,608 hashes. Larger batches reduce CPU submission and buffer-map overhead; interleaved lane bits simplify the GPU rotations. The selected defaults are interleaved lanes, workgroup 64, 16 hashes per invocation, and an 8,388,608-hash batch. At approximately 450 MH/s this is about 19 ms of work per batch, still below the 500 ms polling interval.

Alternating four-second runs compared the original configuration, batch tuning alone, and the new kernel with tuned batches. Shorter exploratory sweeps informed the configuration choices. Both kernels pass the complete GPU comparison suite, including low-32-bit nonce rollover boundaries and strict target equality. Gains measured on Metal do not establish NVIDIA throughput; both implementations remain selectable for that reason.

Alternating results were 320.5 MH/s original versus 428.4 MH/s optimized in the first direction, and 256.4 versus 329.4 MH/s in the reverse direction. Absolute rates fell during the sweep; the measurements do not isolate temperature, power management, and unrelated machine activity. The relative improvement was approximately 28–34%. A subsequent live check reached 445.6 MH/s while hashing and then paused on stale RPC state. That active rate should not be read as whole-run effective throughput.
