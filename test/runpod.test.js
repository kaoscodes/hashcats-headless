import test, { describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const installer = resolve('scripts/runpod.sh');
const root = resolve('.');
const dummyKey = '0x' + '1'.repeat(64);
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
function shell(code, env = {}) {
  return spawnSync('bash', ['-c', `source ${quote(installer)}\n${code}`], {
    cwd: root, env:{...process.env, ...env}, encoding:'utf8', timeout:20000,
  });
}
function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'hashcats-wizard-'));
  try { fn(dir); } finally { rmSync(dir, {recursive:true, force:true}); }
}

describe('RunPod installer', {skip: process.platform === 'win32'}, () => {

test('RunPod budget validation rejects shell input, invalid precision, and out-of-range counts', () => {
  const r = shell(`
    valid_count 1 && valid_count 10000
    for value in 0 -1 10001 1.5 01 '1;exit' ''; do
      if valid_count "$value"; then exit 10; fi
    done
    valid_price 0 && valid_price 0.1 && valid_price 0.000000000000000001
    for value in -1 1e9 0.0000000000000000001 '0.1;exit' '$(echo nope)' ''; do
      if valid_price "$value"; then exit 11; fi
    done
  `);
  assert.equal(r.status, 0, r.stderr);
});

test('RunPod hidden key input rejects invalid scalars and writes only a restricted key file', () => fixture(dir => {
  const input = join(dir, 'input');
  writeFileSync(input, '0x'+'0'.repeat(64)+'\n'+dummyKey+'\n', {mode:0o600});
  const r = shell(`
    STATE_DIR=${quote(dir)}
    exec 3<${quote(input)} 4>${quote(join(dir, "prompts"))}
    configure_key "$STATE_DIR/miner.key"
    [[ ! -v PRIVATE_KEY ]]
  `);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(readFileSync(join(dir, 'miner.key'),'utf8'),dummyKey+'\n');
  assert.equal(statSync(join(dir,'miner.key')).mode & 0o777, 0o600);
  assert.ok(!r.stdout.includes(dummyKey) && !r.stderr.includes(dummyKey));
  assert.ok(!readFileSync(join(dir,'prompts'),'utf8').includes(dummyKey));
}));

test('RunPod runner safely quotes paths, applies limits, logs output, and preserves miner failure without restarting', () => fixture(dir => {
  const checkout = join(dir,"checkout with 'quotes' $dollars");
  const state = join(checkout,'.runpod');
  mkdirSync(state,{recursive:true});
  const fakeNode = join(dir,'fake node');
  writeFileSync(fakeNode, '#!/bin/bash\nprintf "%s\\n" "$@"\necho mock-miner-failure\nexit 23\n',{mode:0o700});
  const runner = join(state,'start-miner.sh');
  const r = shell(`
    INSTALL_DIR=${quote(checkout)}
    STATE_DIR=${quote(state)}
    write_runner ${quote(runner)} ${quote(fakeNode)} ${quote(join(state,'miner.key'))} 7 0.125
  `);
  assert.equal(r.status,0,r.stderr);
  assert.equal(statSync(runner).mode & 0o777,0o700);
  const started=spawnSync('bash',[runner],{encoding:'utf8',timeout:10000});
  assert.equal(started.status,23,started.stderr);
  assert.match(started.stdout,/--max-mints\n7/);
  assert.match(started.stdout,/--max-mint-price\n0\.125/);
  assert.match(started.stdout,/No automatic restart/);
  assert.equal(started.stdout.split('mock-miner-failure').length-1,1);
  const log=started.stdout.match(/^Mining log: (.+)$/m)[1];
  assert.match(readFileSync(log,'utf8'),/mock-miner-failure/);
  assert.equal(statSync(log).mode & 0o777,0o600);
}));

for (const scenario of ['start', 'decline', 'gpu-failure', 'existing-session']) {
  test(`RunPod wizard orchestration: ${scenario} (mock system services, no mining)`, {skip: process.getuid?.() !== 0}, () => fixture(dir => {
    const input = join(dir,'input');
    const trace = join(dir,'trace');
    writeFileSync(trace,'');
    writeFileSync(input,`${dummyKey}\n2\n0.09\n${scenario === 'decline' ? 'no' : 'yes'}\n`,{mode:0o600});
    const r = shell(`
      INSTALL_DIR=${quote(join(dir,'checkout'))}
      SESSION=wizard-test
      # Supply prompt descriptors without requiring a terminal in CI.
      # Override only main's descriptor-opening line; all other code is unchanged.
      eval "$(declare -f main | sed 's@exec 3< /dev/tty 4> /dev/tty@exec 3< ${input} 4> ${join(dir,'prompts')}@')"
      record() { printf '%s\\n' "$*" >> ${quote(trace)}; }
      uname() { [[ "$1" == -s ]] && echo Linux || echo x86_64; }
      nvidia-smi() { record gpu-detected; }
      apt-get() { record apt; }
      flock() { :; }
      install_node() { record node-installed; }
      git() {
        record git
        [[ "$1" == clone ]] || return 1
        mkdir -p "$INSTALL_DIR/.git"
      }
      npm() { record "npm $*"; }
      node() {
        if [[ "$1" == --input-type=module ]]; then
          (cd ${quote(root)} && ${quote(process.execPath)} "$@")
        else
          record "node $*"
          if [[ "$2" == selftest && ${quote(scenario)} == gpu-failure ]]; then return 1; fi
        fi
      }
      tmux() {
        if [[ "$1" == has-session ]]; then [[ ${quote(scenario)} == existing-session ]]; return; fi
        record "tmux $*"
      }
      main
    `);
    const events=readFileSync(trace,'utf8');
    if (scenario === 'gpu-failure') {
      assert.notEqual(r.status,0);
      assert.match(r.stderr,/GPU verification failed/);
    } else {
      assert.equal(r.status,0,r.stderr);
    }
    if (scenario === 'start') {
      assert.match(events,/node src\/cli.js status --address 0x/);
      assert.match(events,/tmux new-session/);
      assert.match(readFileSync(join(dir,'checkout/.runpod/start-miner.sh'),'utf8'),/--max-mints 2/);
    } else {
      assert.ok(!events.includes('tmux new-session'));
    }
    if (scenario === 'existing-session') assert.ok(!events.includes('npm'));
    assert.ok(!r.stdout.includes(dummyKey) && !r.stderr.includes(dummyKey) && !events.includes(dummyKey));
  }));
}

});
