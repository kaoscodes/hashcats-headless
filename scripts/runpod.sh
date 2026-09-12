#!/usr/bin/env bash
# RunPod Ubuntu/PyTorch bootstrap. Prompts use /dev/tty so curl | bash works.
set +x
set -Eeuo pipefail
umask 077

REPO_URL=https://github.com/kaoscodes/hashcats-headless.git
NODE_VERSION=22.23.2
INSTALL_DIR=${HASHCATS_DIR:-/workspace/hashcats-headless}
SESSION=${HASHCATS_SESSION:-hashcats}
TEMP_DIR=
SECRET_TEMP=

say() { printf '\n%s\n' "$*"; }
die() { printf '\nError: %s\n' "$*" >&2; exit 1; }
cleanup() {
  unset PRIVATE_KEY
  [[ -z "$SECRET_TEMP" ]] || rm -f -- "$SECRET_TEMP"
  [[ -z "$TEMP_DIR" ]] || rm -rf -- "$TEMP_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'printf "\nSetup stopped. Resolve the error above and rerun the installer.\n" >&2' ERR

prompt() {
  local label=$1 default=${2:-}
  printf '%s' "$label" >&4
  [[ -z "$default" ]] || printf ' [%s]' "$default" >&4
  printf ': ' >&4
  IFS= read -r REPLY <&3 || die 'Input closed.'
  REPLY=${REPLY:-$default}
}

valid_count() { [[ $1 =~ ^[1-9][0-9]{0,4}$ ]] && (( 10#$1 <= 10000 )); }
valid_price() { [[ $1 =~ ^(0|[1-9][0-9]{0,5})(\.[0-9]{1,18})?$ ]]; }

session_exists() { tmux has-session -t "=$SESSION" 2>/dev/null; }
show_session() {
  say "A tmux session named '$SESSION' already exists. It has been left untouched."
  printf 'Reconnect: tmux attach -t %q\n' "$SESSION"
  printf 'Inspect its output before restarting, especially after a submission error.\n'
}

install_node() {
  if command -v node >/dev/null && command -v npm >/dev/null &&
    node -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 22 ? 0 : 1)'; then
    return
  fi
  say "Installing Node.js $NODE_VERSION…"
  TEMP_DIR=$(mktemp -d)
  local archive="node-v$NODE_VERSION-linux-x64.tar.xz"
  local base="https://nodejs.org/dist/v$NODE_VERSION"
  curl --fail --silent --show-error --location --retry 3 "$base/$archive" -o "$TEMP_DIR/$archive"
  curl --fail --silent --show-error --location --retry 3 "$base/SHASUMS256.txt" -o "$TEMP_DIR/SHASUMS256.txt"
  (cd "$TEMP_DIR" && awk -v f="$archive" '$2 == f { print; found=1 } END { if (!found) exit 1 }' SHASUMS256.txt | sha256sum --check --status)
  mkdir -p /opt/hashcats-node
  tar -xJf "$TEMP_DIR/$archive" -C /opt/hashcats-node --strip-components=1
  export PATH="/opt/hashcats-node/bin:$PATH"
  rm -rf -- "$TEMP_DIR"
  TEMP_DIR=
}

configure_key() {
  local key_file=$1
  if [[ -f "$key_file" ]]; then
    prompt 'Reuse the saved private key? (yes/no)' yes
    case "$REPLY" in
      yes|y|Y) chmod 600 "$key_file"; return ;;
      no|n|N) ;;
      *) die 'Expected yes or no. Rerun to configure the wallet.' ;;
    esac
  fi
  while true; do
    printf 'Private key (0x-prefixed; hidden): ' >&4
    IFS= read -r -s PRIVATE_KEY <&3 || die 'Input closed.'
    printf '\n' >&4
    # Validate the scalar too, without putting the key in argv or diagnostics.
    if [[ "$PRIVATE_KEY" =~ ^0x[0-9a-fA-F]{64}$ ]] &&
      printf '%s' "$PRIVATE_KEY" | node --input-type=module -e '
        import { readFileSync } from "node:fs";
        import { privateKeyToAccount } from "viem/accounts";
        try { privateKeyToAccount(readFileSync(0,"utf8")); }
        catch { process.exit(1); }
      ' 2>/dev/null; then
      break
    fi
    unset PRIVATE_KEY
    printf 'Enter a valid Ethereum private key: 0x followed by 64 hexadecimal characters.\n' >&4
  done
  SECRET_TEMP=$(mktemp "$STATE_DIR/.key.XXXXXX")
  printf '%s\n' "$PRIVATE_KEY" > "$SECRET_TEMP"
  unset PRIVATE_KEY
  chmod 600 "$SECRET_TEMP"
  mv -f -- "$SECRET_TEMP" "$key_file"
  SECRET_TEMP=
}

# Expand runtime variables when the generated runner executes, not during setup.
# shellcheck disable=SC2016
write_runner() {
  local runner=$1 node_bin=$2 key_file=$3 max_mints=$4 max_price=$5
  {
    printf '#!/usr/bin/env bash\nset -uo pipefail\numask 077\n'
    printf 'cd %q || exit 1\n' "$INSTALL_DIR"
    printf 'log=%q/miner-$(date -u +%%Y%%m%%dT%%H%%M%%SZ)-$$.log\n' "$STATE_DIR"
    printf 'printf "Mining log: %%s\\n" "$log"\n'
    printf '%q src/cli.js mine --backend vulkan --kernel split --submit --key-file %q --max-mint-price %q --max-fee-gwei 10 --max-gas 1000000 --max-mints %q 2>&1 | tee "$log"\n' \
      "$node_bin" "$key_file" "$max_price" "$max_mints"
    printf 'status=${PIPESTATUS[0]}\n'
    printf 'printf "\\nMiner exited with status %%s. No automatic restart.\\n" "$status"\n'
    printf 'printf "Check the log and any transaction journal before starting again.\\n"\n'
    printf 'exit "$status"\n'
  } > "$runner"
  chmod 700 "$runner"
}

main() {
  if [[ ${1:-} == --help ]]; then
    cat <<'HELP'
Hashcats RunPod wizard (Ubuntu/PyTorch, NVIDIA x86_64)

  bash scripts/runpod.sh

Installs dependencies, clones/updates the public repo, tests the GPU, prompts
for a private key and mint limits, then starts a detached tmux session.

Optional environment variables:
  HASHCATS_DIR       Checkout directory (default /workspace/hashcats-headless)
  HASHCATS_SESSION   tmux session name (default hashcats)

Keys and logs live in the checkout's ignored .runpod/ directory. The wizard
never prints the key, installs kernel drivers, or restarts a failed miner.
HELP
    return
  fi
  [[ $# == 0 ]] || die 'Unknown argument. Use --help.'
  [[ $EUID == 0 ]] || die 'Run this from the root terminal in your RunPod pod.'
  [[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || die 'This installer requires Linux x86_64.'
  command -v apt-get >/dev/null || die 'This installer requires an Ubuntu/Debian-based image.'
  [[ "$INSTALL_DIR" == /* && "$INSTALL_DIR" != / ]] || die 'HASHCATS_DIR must be an absolute checkout path, not /.'
  [[ "$SESSION" =~ ^[a-zA-Z0-9_-]+$ ]] || die 'HASHCATS_SESSION may contain only letters, digits, underscores, and hyphens.'
  exec 3</dev/tty 4>/dev/tty || die 'Open a RunPod terminal or SSH with a TTY (ssh -t) to answer the wizard.'
  say 'Hashcats / RunPod setup'
  if command -v tmux >/dev/null && session_exists; then show_session; return; fi
  command -v nvidia-smi >/dev/null || die 'No NVIDIA runtime detected. Use a GPU pod with NVIDIA drivers exposed.'
  nvidia-smi --query-gpu=name,driver_version --format=csv,noheader

  say 'Installing system dependencies…'
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl git xz-utils tmux libegl1 libvulkan1 util-linux
  # Serialize setup, including any writes to saved credentials and runner files.
  exec 9>/tmp/hashcats-runpod-setup.lock
  flock -n 9 || die 'Another Hashcats installer is already running.'
  if session_exists; then show_session; return; fi
  install_node

  say "Preparing $INSTALL_DIR…"
  if [[ -d "$INSTALL_DIR/.git" ]]; then
    local origin
    origin=$(git -C "$INSTALL_DIR" remote get-url origin)
    [[ "$origin" == "$REPO_URL" || "$origin" == "${REPO_URL%.git}" || "$origin" == git@github.com:kaoscodes/hashcats-headless.git ]] || die 'Existing directory has a different Git origin; choose another HASHCATS_DIR.'
    [[ -z $(git -C "$INSTALL_DIR" status --porcelain) ]] || die 'Checkout contains local changes. Commit them or choose another HASHCATS_DIR.'
    [[ $(git -C "$INSTALL_DIR" branch --show-current) == main ]] || die 'Existing checkout must be on main; choose another HASHCATS_DIR.'
    git -C "$INSTALL_DIR" pull --ff-only origin main
  elif [[ -e "$INSTALL_DIR" ]]; then
    die 'Install directory already exists without a Git checkout; choose another HASHCATS_DIR.'
  else
    git clone --branch main "$REPO_URL" "$INSTALL_DIR"
  fi
  cd "$INSTALL_DIR"
  npm ci
  say 'Checking software and both GPU kernels…'
  npm test
  node src/cli.js devices --backend vulkan
  node src/cli.js selftest --backend vulkan || die 'GPU verification failed. Check GPU access and Vulkan driver libraries; no miner was started.'

  STATE_DIR="$INSTALL_DIR/.runpod"
  mkdir -p "$STATE_DIR"
  chmod 700 "$STATE_DIR"
  local key_file="$STATE_DIR/miner.key"
  say 'Configure automatic minting'
  printf 'The wallet must hold ETH on Robinhood Chain (chain ID 4663).\n'
  configure_key "$key_file"
  local address
  address=$(node --input-type=module -e '
    import { readFileSync } from "node:fs";
    import { privateKeyToAccount } from "viem/accounts";
    try { console.log(privateKeyToAccount(readFileSync(process.argv[1],"utf8").trim()).address); }
    catch { console.error("Saved private key is invalid."); process.exit(1); }
  ' "$key_file")
  printf 'Wallet: %s\n' "$address"
  local max_mints max_price
  while true; do
    prompt 'Maximum successful mints (1–10000)' 1
    if valid_count "$REPLY"; then max_mints=$REPLY; break; fi
    printf 'Enter a whole number from 1 to 10000.\n' >&4
  done
  while true; do
    prompt 'Maximum price PER CAT in ETH, excluding gas' 0.1
    if valid_price "$REPLY"; then max_price=$REPLY; break; fi
    printf 'Enter a nonnegative decimal ETH amount with up to 18 decimal places.\n' >&4
  done
  say 'Checking live RPC and wallet difficulty…'
  node src/cli.js status --address "$address"
  say 'Ready to start'
  printf 'Wallet: %s\nMint limit: %s\nPrice ceiling: %s ETH per cat, plus gas\n' "$address" "$max_mints" "$max_price"
  printf 'Gas ceilings: 1,000,000 gas / 10 gwei per gas\nGPU: Vulkan / split kernel\nSession: %s\n' "$SESSION"
  printf 'Key file: %s (mode 600)\n' "$key_file"
  prompt 'Start mining and submit paid mints with these limits? (yes/no)' no
  case "$REPLY" in yes|y|Y) ;; *) say 'Key saved. No miner started. Rerun this wizard when ready.'; return ;; esac
  local runner="$STATE_DIR/start-miner.sh"
  write_runner "$runner" "$(command -v node)" "$key_file" "$max_mints" "$max_price"
  # Keep the pane after exit, preserving output without blindly resubmitting.
  # Close wizard FDs in the tmux client so a new tmux server cannot inherit its lock.
  local quoted_runner
  printf -v quoted_runner '%q' "$runner"
  tmux new-session -d -s "$SESSION" -c "$INSTALL_DIR" \
    "tmux set-option -p remain-on-exit on; exec bash $quoted_runner" 3<&- 4>&- 9>&-
  say 'Miner launched in tmux.'
  printf 'Watch / rejoin: tmux attach -t %q\n' "$SESSION"
  printf 'Detach: Ctrl+B, then D. Stop mining: Ctrl+C inside the session.\n'
  printf 'Logs: %s/miner-*.log\n' "$STATE_DIR"
  printf 'tmux survives terminal disconnects, but not a pod stop or restart.\n'
}

if [[ ${BASH_SOURCE[0]} == "$0" ]]; then main "$@"; fi
