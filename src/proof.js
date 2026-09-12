import { randomBytes } from 'node:crypto';
import { keccak_256 } from '@noble/hashes/sha3.js';
import { getAddress, hexToBytes, bytesToHex, toHex, encodeFunctionData, parseAbi } from 'viem';

export const MAX256 = (1n << 256n) - 1n;
export const MINE_ABI = parseAbi(['function mine(uint256 nonce, uint256 anchorBlock) payable returns (uint256 tokenId)']);
export function uint256(value) {
  const n = BigInt(value);
  if (n < 0n || n > MAX256) throw new Error('Value must fit uint256');
  return n;
}
export function inputBytes(job, nonce) {
  const bytes = new Uint8Array(116);
  bytes.set(hexToBytes(getAddress(job.miner)), 0);
  bytes.set(hexToBytes(toHex(uint256(nonce), { size: 32 })), 20);
  bytes.set(hexToBytes(toHex(uint256(job.prev), { size: 32 })), 52);
  if (!/^0x[0-9a-fA-F]{64}$/.test(job.anchor)) throw new Error('Anchor must be bytes32');
  bytes.set(hexToBytes(job.anchor), 84);
  return bytes;
}
export function workHash(job, nonce) { return bytesToHex(keccak_256(inputBytes(job, nonce))); }
export function validProof(job, nonce) { return BigInt(workHash(job, nonce)) < uint256(job.target); }
export function randomPrefix() { return BigInt(bytesToHex(randomBytes(28))) << 32n; }
export function nonceAt(prefix, offset) {
  if ((uint256(prefix) & 0xffffffffn) !== 0n) throw new Error('Nonce prefix must have its low 32 bits clear');
  if (!Number.isInteger(offset) || offset < 0 || offset > 0xffffffff) throw new Error('Nonce counter out of range');
  return prefix | BigInt(offset);
}
export function transaction(job, nonce, contract, chainId) {
  return { chainId, from: getAddress(job.miner), to: getAddress(contract), value: toHex(uint256(job.price)),
    data: encodeFunctionData({ abi: MINE_ABI, functionName: 'mine', args: [uint256(nonce), BigInt(job.anchorBlock)] }) };
}
export const json = value => JSON.stringify(value, (_, v) => typeof v === 'bigint' ? v.toString() : v);
