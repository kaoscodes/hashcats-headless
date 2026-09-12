import { createPublicClient, createWalletClient, defineChain, http, fallback, parseAbi, getAddress, toHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { workHash, transaction } from './proof.js';
export const CONTRACT = '0xCA75DF55Cc9C476DB27a7375D1fc8E794cf80721';
export const RPC_URLS = ['https://rpc.mainnet.chain.robinhood.com', 'https://robinhood.drpc.org'];
export const CHAIN_ID = 4663;
export const ABI = parseAbi([
  'function currentAnchor() view returns (uint256 anchorBlock, bytes32 anchor)',
  'function prevWork() view returns (uint256)',
  'function targetFor(address miner) view returns (uint256)',
  'function currentTarget() view returns (uint256)',
  'function mintPrice() view returns (uint256)',
  'function ANCHOR_WINDOW() view returns (uint256)',
  'function totalMinted() view returns (uint256)',
  'function workHash(address miner, uint256 nonce, uint256 prev, bytes32 anchor) pure returns (uint256)',
  'function mine(uint256 nonce, uint256 anchorBlock) payable returns (uint256 tokenId)',
]);
export class Chain {
  constructor({ rpc, contract = CONTRACT } = {}) {
    this.contract = getAddress(contract);
    const urls = rpc ? [rpc] : RPC_URLS;
    this.chain = defineChain({ id: CHAIN_ID, name: 'Robinhood Chain', nativeCurrency: { name:'Ether',symbol:'ETH',decimals:18 }, rpcUrls: { default: { http: urls } } });
    this.transport = fallback(urls.map(url => http(url,{timeout:10000,retryCount:1})), { retryCount:0 });
    this.client = createPublicClient({chain:this.chain,transport:this.transport});
  }
  read(name,args=[],blockNumber) { return this.client.readContract({address:this.contract,abi:ABI,functionName:name,args,blockNumber}); }
  async check() {
    const id = await this.client.getChainId();
    if (id !== CHAIN_ID) throw new Error(`Wrong chain: expected ${CHAIN_ID}, received ${id}`);
    const code = await this.client.getCode({address:this.contract});
    if (!code || code === '0x') throw new Error('No collection contract at configured address');
  }
  async snapshot(miner) {
    miner = getAddress(miner);
    // Pin all eth_calls to one RPC block. currentAnchor supplies the L2 block
    // number; eth_blockNumber on Arbitrum-like chains is not a substitute.
    const blockNumber = await this.client.getBlockNumber({cacheTime:0});
    const [anchor,prev,target,price,window] = await Promise.all([
      this.read('currentAnchor',[],blockNumber), this.read('prevWork',[],blockNumber),
      this.read('targetFor',[miner],blockNumber), this.read('mintPrice',[],blockNumber),
      this.read('ANCHOR_WINDOW',[],blockNumber),
    ]);
    return {miner,prev,target,price,anchorBlock:anchor[0],anchor:anchor[1],window,blockNumber,receivedAt:Date.now()};
  }
  async verifyHash(job,nonce) {
    const expected = await this.read('workHash',[job.miner,nonce,job.prev,job.anchor]);
    if (expected !== BigInt(workHash(job,nonce))) throw new Error('Local hash disagrees with contract workHash');
    return toHex(expected,{size:32});
  }
  async prepare(job,nonce,{maxPrice,maxGas,maxFeePerGas}={}) {
    const fresh = await this.snapshot(job.miner);
    if (fresh.prev !== job.prev) throw new Error('Stale proof: another cat was minted');
    if (fresh.anchorBlock < job.anchorBlock || fresh.anchorBlock-job.anchorBlock >= fresh.window)
      throw new Error('Stale proof: anchor outside the live window');
    if (BigInt(workHash(job,nonce)) >= fresh.target) throw new Error('Proof no longer beats the wallet target');
    if (maxPrice !== undefined && fresh.price > maxPrice) throw new Error('Mint price exceeds --max-mint-price');
    const tx = transaction({...job,price:fresh.price},nonce,this.contract,CHAIN_ID);
    // Simulation is authoritative for anchor edge cases and contract rules.
    const {request} = await this.client.simulateContract({address:this.contract,abi:ABI,functionName:'mine',
      args:[nonce,job.anchorBlock],account:job.miner,value:fresh.price});
    const estimate = await this.client.estimateContractGas(request);
    const gas = (estimate * 120n + 99n) / 100n;
    if (maxGas !== undefined && gas > maxGas) throw new Error('Gas estimate exceeds --max-gas');
    const fees = await this.client.estimateFeesPerGas();
    if (maxFeePerGas !== undefined && fees.maxFeePerGas > maxFeePerGas) throw new Error('Network fee exceeds --max-fee-gwei');
    return {tx:{...tx,gas:toHex(gas),maxFeePerGas:toHex(fees.maxFeePerGas),maxPriorityFeePerGas:toHex(fees.maxPriorityFeePerGas)},
      request:{to:this.contract,data:tx.data,value:fresh.price,gas,...fees},price:fresh.price};
  }
  signer(key) { return privateKeyToAccount(key); }
  async sign(prepared,account) {
    const wallet = createWalletClient({account,chain:this.chain,transport:this.transport});
    const request = await wallet.prepareTransactionRequest({...prepared.request,account});
    return wallet.signTransaction(request);
  }
}
