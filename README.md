<p align="center">
  <img src="docs/assets/hero.svg" alt="Hashcats — Mine from the terminal. Native WebGPU. CPU-verified proofs." width="100%" />
</p>

<p align="center">
  <strong>A standalone GPU miner for <a href="https://hashcats.fun/mine">Hashcats</a> on Robinhood Chain.</strong><br />
  Node.js orchestration. Native GPU compute. No browser or wallet extension required.
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#performance">Performance</a> ·
  <a href="#automatic-minting">Automatic minting</a> ·
  <a href="docs/protocol.md">Protocol notes</a>
</p>

---

## Built to run headless

| Native compute | Verified work | Controlled submission |
| :--- | :--- | :--- |
| Dawn WebGPU runs WGSL directly through Metal, Vulkan, or D3D12. | Every GPU winner is independently hashed on the CPU. | Explicit mint and gas ceilings, simulation, and a transaction journal before broadcast. |

## Quick start

Use **Node.js 22+** and a hardware GPU driver.

```sh
git clone https://github.com/kaoscodes/hashcats-headless.git
cd hashcats-headless
npm ci
npm test
node src/cli.js devices
npm run test:gpu
node src/cli.js benchmark --seconds 30
```

Start a proof-only run for your public wallet address:

```sh
node src/cli.js mine --address 0xYOUR_WALLET_ADDRESS
```

This saves the first proof to `results/` without signing or paying. Add `--seconds 60` for a bounded run, `--json` for structured logs, or stop with **Ctrl-C**. Proofs include the nonce, original anchor block, hash input, and unsigned transaction. They expire quickly, so manual submission is usually impractical.

Read wallet difficulty, mint price, and the current anchor without starting the GPU:

```sh
node src/cli.js status --address 0xYOUR_WALLET_ADDRESS
```

## Performance

Measured on an **NVIDIA RTX PRO 6000 Blackwell Server Edition**, using Vulkan and NVIDIA driver `580.173.02`:

| Workload | Kernel | Measured hashrate | Duration |
| :--- | :--- | ---: | ---: |
| GPU benchmark | Interleaved (default) | **3.29 GH/s** | 30 seconds |
| GPU benchmark | Split | **3.41 GH/s** | 30 seconds |
| Live proof-only mining | Interleaved | **~3.18 GH/s** | 15 seconds |

Both kernels passed 3,082 independent CPU/GPU hash comparisons and five target-boundary checks each. Live RPC access and the contract's `workHash` verification also passed. The live run processed 47.74 billion hashes; it found no proof and submitted no transaction.

These are short measurements on one pod, not guaranteed sustained rates or mint frequency. Wallet difficulty, changing chain state, and submission timing affect results. Split was slightly faster in this comparison; benchmark both kernels on your hardware.

Earlier Apple M4 Pro measurements reached approximately **430–470 MH/s** in short tuning sweeps. Alternating kernel comparisons measured 320→428 MH/s and 256→329 MH/s as overall throughput changed. Two CPU workers measured approximately **0.89 MH/s**. These runs used different hardware and conditions and are not a controlled comparison with the NVIDIA results.

## Automatic minting

The miner derives your wallet address from its private key. The wallet needs enough **ETH on Robinhood Chain** for the mint and gas.

Create a `.env` file in the directory where you run the command:

```dotenv
HASHCATS_PRIVATE_KEY=0xYOUR_PRIVATE_KEY
```

Restrict access, then start mining:

```sh
chmod 600 .env
node src/cli.js mine \
  --submit \
  --max-mint-price 0.1 \
  --max-fee-gwei 10 \
  --max-gas 1000000 \
  --max-mints 1
```

This permits up to **0.1 ETH per mint, excluding gas**, and stops after one successful mint. The ceilings are examples; choose your own budget. On NVIDIA/Linux, add `--backend vulkan --kernel split` to use the kernel measured above.

The CLI loads `.env` automatically from the current working directory. Exported environment variables take precedence. A missing `.env` is fine; other file-loading errors stop the CLI. `.env` files are ignored by Git.

<details>
<summary><strong>Use a separate key file instead</strong></summary>

Store a `0x`-prefixed private key in a restricted file, then run:

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

`--key-file` takes precedence over `HASHCATS_PRIVATE_KEY`. Never pass a private key as the wallet address.

</details>

### From proof to mint

1. Independently verify the GPU winner on the CPU.
2. Recheck previous work, wallet target, anchor age, and mint price.
3. Simulate with `eth_call`, estimate gas and fees, and enforce spending ceilings.
4. Write the exact signed transaction and hash before broadcasting.
5. Wait for a successful receipt and stop when `--max-mints` is reached.

If broadcasting or receipt tracking fails, the miner stops. Check the recorded transaction hash on Robinhood Chain before restarting: a timeout does not prove failure. `results/signed-transaction-*.json` contains broadcastable signed bytes; treat these files as sensitive until the proof expires. Proof-only files have not been simulated and may already be stale.

Actual paid mint execution remains untested. A valid proof can expire or lose a race before execution. Receipt tracking requests one confirmation.

## Choose your hardware

| Platform | Backend | Verification status |
| :--- | :--- | :--- |
| Apple Silicon | `metal` | Tested on Apple M4 Pro |
| NVIDIA / Linux | `vulkan` | Tested on RTX PRO 6000 Blackwell |
| NVIDIA / Windows | `d3d12` | Implemented; not hardware-tested here |
| CPU | `--engine cpu` | Worker-thread fallback for diagnostics and portability |

```sh
# Apple Silicon
node src/cli.js benchmark --backend metal

# NVIDIA / Linux
node src/cli.js selftest --backend vulkan
node src/cli.js benchmark --backend vulkan --kernel split --seconds 30

# NVIDIA / Windows
node src/cli.js selftest --backend d3d12

# CPU fallback
node src/cli.js benchmark --engine cpu --threads 4
node src/cli.js mine --engine cpu --threads 4 --address 0xYOUR_WALLET_ADDRESS
```

### Running in a GPU pod

The container must expose the GPU, its driver libraries, and a working Vulkan ICD. Software adapters are rejected. Dawn's prebuilt binary must also support the host OS and architecture; see the [Dawn Node documentation](https://github.com/dawn-gpu/node-webgpu).

On the tested Ubuntu pod, the NVIDIA libraries were present but Vulkan initialization failed because `libEGL.so.1` was missing. Installing `libegl1` resolved it:

```sh
apt-get update
apt-get install -y libegl1
node src/cli.js devices --backend vulkan
npm run test:gpu
```

<details>
<summary><strong>Adapter selection and multiple GPUs</strong></summary>

`--adapter NAME` selects a Dawn adapter by name. An unmatched name prints the available names:

```sh
node src/cli.js devices --adapter list
```

`devices` reports the selected adapter, not an inventory of every card. Run separate processes with different adapter names for multiple cards. Random 224-bit nonce prefixes prevent practical overlap.

Use one submitting process per wallet to avoid transaction-nonce contention. This version does not coordinate signers between processes.

</details>

## Tune your miner

| Setting | Default | Option |
| :--- | :--- | :--- |
| Keccak kernel | Interleaved even/odd lane bits | `--kernel interleaved\|split` |
| Workgroup size | 64 | `--workgroup 64\|128\|256` |
| Hashes per invocation | 16 | `--per-thread N` |
| Hashes per GPU batch | 8,388,608 | `--batch-size N` |
| Chain polling interval | 500 ms + RPC latency | `--poll-ms N` |
| Maximum snapshot age | 3 seconds | `--max-age-ms N` |

Larger batches reduce dispatch overhead but delay new-work handling and shutdown. Keep batches comfortably inside the anchor window. The miner pauses when the last successful chain snapshot exceeds the age limit.

```sh
npm run tune
TUNE_KERNEL=split TUNE_SECONDS=5 npm run tune
```

The tuning script emits JSON lines. Defaults were tuned on Apple Silicon; measure alternatives on your own hardware. Mining runs at full compute utilization until a proof, duration limit, or signal stops it; submission mode can continue until its mint limit is reached.

## Network

| Setting | Default |
| :--- | :--- |
| Network | Robinhood Chain · chain ID **4663** |
| Primary RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Fallback RPC | `https://robinhood.drpc.org` |
| Collection | `0xCA75DF55Cc9C476DB27a7375D1fc8E794cf80721` |

Add `--rpc URL` to use your own endpoint. The miner checks the RPC chain ID before mining. Network defaults and the contract ABI live in [`src/chain.js`](src/chain.js).

## Verification

```sh
npm test                # Software tests
npm run test:gpu        # Both GPU kernels against independent CPU hashes
node src/cli.js --help  # Full CLI reference
```

Software tests cover packing, full target comparison, nonce allocation, CPU partitions, chain snapshots, proof files, signing, spending limits, and submission failure behavior. GPU initialization also verifies 16 hashes every time it starts.

For byte layouts, deployed-contract research, and implementation decisions, read the [protocol study](docs/protocol.md).
