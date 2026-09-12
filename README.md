# Hashcats headless miner

A standalone miner for [hashcats.fun/mine](https://hashcats.fun/mine). Node.js controls native Dawn WebGPU compute. It needs no browser, canvas, wallet extension, X server, or virtual display.

The WGSL kernel runs through Metal on Apple Silicon, Vulkan on NVIDIA/Linux, or D3D12 on NVIDIA/Windows. Apple M4 Pro is tested locally. NVIDIA paths are implemented through Dawn but have not been tested on NVIDIA hardware here.

## Run

Use Node.js 22 or newer and the platform's hardware GPU driver.

```sh
npm ci
npm test
node src/cli.js devices
npm run test:gpu
node src/cli.js benchmark --seconds 10
```

Mine for your wallet address and save the first proof, without signing or paying:

```sh
node src/cli.js mine --address 0xYOUR_WALLET_ADDRESS
```

Add `--seconds 60` for a bounded run. Stop with Ctrl-C or SIGTERM. Use `--json` for JSON lines suitable for logging. Successful proofs go into `results/` with the nonce, original anchor block, hash input, and unsigned transaction. A proof expires quickly, so manual submission is usually impractical.

Read current wallet difficulty, mint price, and anchor without starting the GPU:

```sh
node src/cli.js status --address 0xYOUR_WALLET_ADDRESS
```

## Paid minting

For automatic submission, provide a file containing a `0x`-prefixed private key. Restrict that file to your user. The key's address must hold enough ETH on Robinhood Chain to cover the mint and gas. The miner derives its address from that key.

```sh
chmod 600 /path/to/miner.key
node src/cli.js mine \
  --submit \
  --key-file /path/to/miner.key \
  --max-mint-price 0.1 \
  --max-fee-gwei 10 \
  --max-gas 1000000 \
  --max-mints 1
```

`--max-mint-price` is an ETH ceiling per mint, excluding gas. It is required for submission. `--max-mints` defaults to one successful mint. The example's ceilings are examples, not predictions of the current price or fees. `HASHCATS_PRIVATE_KEY` is supported as an alternative to `--key-file`. Never pass a private key as the wallet address.

Before sending, the miner rechecks the previous work, wallet target, anchor age and price, runs `eth_call` simulation, estimates gas and fees, and applies the configured ceilings. Every GPU winner is independently hashed on the CPU.

The miner writes the exact signed transaction and its hash before broadcasting. If broadcasting or receipt tracking fails, it stops. Inspect the recorded transaction hash on Robinhood Chain before restarting. A timeout does not prove the transaction failed. `results/signed-transaction-*.json` contains signed bytes that can be broadcast; treat those files as sensitive until the proof expires. Proof-only files have not been simulated and may already be stale.

## GPU selection

```sh
# Apple Silicon
node src/cli.js benchmark --backend metal

# NVIDIA on Linux, with Vulkan drivers installed
node src/cli.js selftest --backend vulkan
node src/cli.js mine --backend vulkan --address 0xYOUR_WALLET_ADDRESS

# NVIDIA on Windows
node src/cli.js selftest --backend d3d12
```

`--adapter NAME` selects a Dawn adapter by its name. Dawn prints available names when an unmatched name is supplied, for example `node src/cli.js devices --adapter list`. `devices` reports the selected adapter, not an inventory of every card. Run separate processes with different adapter names for multiple cards. Random 224-bit nonce prefixes prevent practical overlap. Use one submitting process per wallet to avoid transaction-nonce contention; this version does not coordinate signers between processes.

Software adapters are rejected. A Linux NVIDIA machine needs a working Vulkan ICD and permission to access the GPU devices. Containers must expose the GPU and its driver libraries. Dawn's prebuilt binary must support the host OS and architecture. See [Dawn's Node package documentation](https://github.com/dawn-gpu/node-webgpu) for platform details.

The CPU fallback uses Node worker threads and is intended for portability and diagnostics:

```sh
node src/cli.js benchmark --engine cpu --threads 4
node src/cli.js mine --engine cpu --threads 4 --address 0xYOUR_WALLET_ADDRESS
```

## Tuning and operation

GPU defaults use the interleaved Keccak kernel, 64 threads per workgroup, 16 hashes per invocation, and 8,388,608 hashes per batch. The interleaved kernel stores even and odd lane bits separately, reducing the work needed for rotations. Use `--kernel split` to select the original low/high implementation. Set `--workgroup 64|128|256`, `--per-thread N`, and `--batch-size N` to benchmark alternatives. Larger batches reduce dispatch overhead but delay reacting to new work and shutdown. Keep batches short enough to finish comfortably inside the anchor window. Short sweeps reached roughly 430–470 MH/s on this Apple M4 Pro. Alternating comparisons measured 320→428 MH/s and 256→329 MH/s as overall throughput changed, about a 30% gain; this is a short measurement, not a guarantee for other machines or sustained thermal conditions. Two CPU workers measured about 0.89 MH/s.

Chain state refreshes every 500 ms plus RPC latency. The miner pauses when its last successful snapshot is older than 3 seconds. Use `--rpc URL` to supply your own Robinhood Chain endpoint. `--poll-ms` and `--max-age-ms` tune refresh and pause thresholds. Default RPCs and the contract address are pinned in `src/chain.js`, and the RPC chain ID must be 4663.

Mining runs at full compute utilization until a proof, duration limit, or signal stops it. It cannot guarantee a mint. Other miners and changing difficulty affect the outcome, and a valid proof can become stale before its transaction executes. A mined block receipt is checked for success; no confirmation beyond the first receipt is requested.

## Verification and research

- `npm test`: packing, full target comparison, nonce allocation, CPU partitions, chain snapshots, proof files, signing, spending limits, and submission failure behavior.
- `npm run test:gpu`: Both kernels are tested, each with 3,082 GPU hashes compared against an independent CPU implementation, plus five target boundaries. GPU initialization also checks 16 hashes every time.

The live contract's `workHash` was checked over RPC, and a bounded live mining run and SIGINT shutdown were tested without signing. Actual paid mint execution and NVIDIA hardware remain untested.

Run `npm run tune` to compare GPU workgroup and batch settings. It emits JSON lines and defaults to the interleaved kernel. Set `TUNE_KERNEL=split` to compare the original kernel and `TUNE_SECONDS=5` for longer samples. The defaults were tuned on Apple Silicon; benchmark both kernels on NVIDIA before choosing one.

See [the protocol study](docs/protocol.md) for the deployed miner's structure, byte layout, and replication decisions. `node src/cli.js --help` lists all options.
