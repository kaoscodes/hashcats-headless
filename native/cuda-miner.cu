#include <cuda_runtime.h>
#include <cudaTypedefs.h>
#include <cstdint>
#include <iostream>
#include <iomanip>
#include <sstream>
#include <stdexcept>
#include <vector>
#include <csignal>
using U64 = unsigned long long;
void check(cudaError_t e) { if(e!=cudaSuccess) throw std::runtime_error(cudaGetErrorString(e)); }
void printUuid(int device) {
  // cudaDeviceProp::uuid can identify the parent GPU for multiple MIG instances.
  // Resolve the MIG-aware v2 driver API through cudart, without a libcuda link.
  void *entry=nullptr;
  check(cudaGetDriverEntryPoint("cuDeviceGetUuid",&entry,cudaEnableDefault));
  if(!entry)throw std::runtime_error("CUDA device UUID lookup is unavailable");
  CUuuid uuid{};
  auto getUuid=reinterpret_cast<PFN_cuDeviceGetUuid_v11040>(entry);
  if(getUuid(&uuid,device)!=CUDA_SUCCESS)throw std::runtime_error("CUDA device UUID lookup failed");
  for(int k=0;k<16;k++)std::cout<<std::hex<<std::setw(2)<<std::setfill('0')<<unsigned(static_cast<unsigned char>(uuid.bytes[k]));
  std::cout<<std::dec;
}
__device__ __forceinline__ U64 rol(U64 x, int n) { return n ? (x<<n)|(x>>(64-n)) : x; }
__device__ __constant__ U64 RC[24]={0x1ULL,0x8082ULL,0x800000000000808aULL,0x8000000080008000ULL,0x808bULL,0x80000001ULL,0x8000000080008081ULL,0x8000000000008009ULL,0x8aULL,0x88ULL,0x80008009ULL,0x8000000aULL,0x8000808bULL,0x800000000000008bULL,0x8000000000008089ULL,0x8000000000008003ULL,0x8000000000008002ULL,0x8000000000000080ULL,0x800aULL,0x800000008000000aULL,0x8000000080008081ULL,0x8000000000008080ULL,0x80000001ULL,0x8000000080008008ULL};
__device__ __forceinline__ void keccak(U64 *a) {
  const int rotations[25]={0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14};
  #pragma unroll
  for(int round=0;round<24;round++) {
    U64 c[5],d[5],b[25];
    #pragma unroll
    for(int x=0;x<5;x++) c[x]=a[x]^a[x+5]^a[x+10]^a[x+15]^a[x+20];
    #pragma unroll
    for(int x=0;x<5;x++) d[x]=c[(x+4)%5]^rol(c[(x+1)%5],1);
    #pragma unroll
    for(int y=0;y<5;y++) {
      #pragma unroll
      for(int x=0;x<5;x++) b[y+5*((2*x+3*y)%5)]=rol(a[x+5*y]^d[x],rotations[x+5*y]);
    }
    #pragma unroll
    for(int y=0;y<5;y++) {
      #pragma unroll
      for(int x=0;x<5;x++) a[x+5*y]=b[x+5*y]^((~b[(x+1)%5+5*y])&b[(x+2)%5+5*y]);
    }
    a[0]^=RC[round];
  }
}
struct Job { U64 lanes[17]; unsigned char target[32]; uint32_t base,count,perThread; };
__global__ void mine(Job job, uint32_t *winner, unsigned char *hashes) {
  U64 start=(U64(blockIdx.x)*blockDim.x+threadIdx.x)*job.perThread;
  for(unsigned j=0;j<job.perThread && start+j<job.count;j++) {
    uint32_t index=uint32_t(start+j), nonce=job.base+index;
    U64 a[25];
    #pragma unroll
    for(int i=0;i<25;i++) a[i]=i<17?job.lanes[i]:0;
    // Packed nonce ends at byte 51: its low counter is bytes 48..51, big endian.
    a[6]=(a[6]&0xffffffff00000000ULL)|__byte_perm(nonce,0,0x0123);
    keccak(a);
    bool less=false;
    #pragma unroll
    for(int k=0;k<32;k++) {
      unsigned char v=(a[k/8]>>(8*(k%8)))&255;
      if(hashes) hashes[U64(index)*32+k]=v;
    }
    #pragma unroll
    for(int k=0;k<32;k++) {
      unsigned char v=(a[k/8]>>(8*(k%8)))&255;
      if(v!=job.target[k]) { less=v<job.target[k]; break; }
    }
    if(less) atomicMin(winner,index);
  }
}
unsigned byte(const std::string &s,size_t offset) {
  auto digit=[](char c)->unsigned { if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;throw std::runtime_error("Invalid hex"); };
  return digit(s.at(offset))*16+digit(s.at(offset+1));
}
int main(int argc,char **argv) {
  try {
    std::signal(SIGINT,SIG_IGN);
    if(argc>1&&std::string(argv[1])=="--list") {
      int count;check(cudaGetDeviceCount(&count));std::cout<<'[';
      for(int i=0;i<count;i++) {
        cudaDeviceProp p{};check(cudaGetDeviceProperties(&p,i));
        if(i)std::cout<<',';
        std::cout<<"{\"index\":"<<i<<",\"name\":\""<<p.name<<"\",\"uuid\":\"";
        printUuid(i);
        std::cout<<std::dec<<"\"}";
      }
      std::cout<<']'<<std::endl;return 0;
    }
    int device=argc>1?std::stoi(argv[1]):0;check(cudaSetDevice(device));
    cudaDeviceProp prop{};check(cudaGetDeviceProperties(&prop,device));
    std::cout<<"{\"device\":\""<<prop.name<<"\",\"index\":"<<device<<",\"backend\":\"cuda\",\"uuid\":\"";
    printUuid(device);
    std::cout<<std::dec<<"\"}"<<std::endl;
    uint32_t *winner;unsigned char *dump;
    check(cudaMalloc(&winner,4));check(cudaMalloc(&dump,65536*32));
    std::string input,target;uint64_t base,count,threads,perThread,doDump;
    while(std::cin>>input>>target>>base>>count>>threads>>perThread>>doDump) {
      if(input.size()!=272||target.size()!=64||base>0xffffffffULL||!count||count>0xffffffffULL||base+count>0x100000000ULL||
         (threads!=64&&threads!=128&&threads!=256)||!perThread||perThread>1024||doDump>1||(doDump&&count>65536))throw std::runtime_error("Invalid batch");
      Job job{};job.base=base;job.count=count;job.perThread=perThread;
      for(int i=0;i<136;i++)job.lanes[i/8]|=U64(byte(input,i*2))<<(8*(i%8));
      for(int i=0;i<32;i++)job.target[i]=byte(target,i*2);
      check(cudaMemset(winner,255,4));
      mine<<<(count+threads*perThread-1)/(threads*perThread),threads>>>(job,winner,doDump?dump:nullptr);
      check(cudaGetLastError());uint32_t result;check(cudaMemcpy(&result,winner,4,cudaMemcpyDeviceToHost));
      std::ostringstream out;out<<"{\"index\":"<<result;
      if(doDump) {
        std::vector<unsigned char> bytes(count*32);check(cudaMemcpy(bytes.data(),dump,bytes.size(),cudaMemcpyDeviceToHost));
        out<<",\"hashes\":[";
        for(size_t i=0;i<count;i++) {
          if(i)out<<',';out<<"\"0x";
          for(int k=0;k<32;k++)out<<std::hex<<std::setw(2)<<std::setfill('0')<<unsigned(bytes[i*32+k]);
          out<<'"';
        }
        out<<']';
      }
      std::cout<<out.str()<<'}'<<std::endl;
    }
    check(cudaFree(dump));check(cudaFree(winner));return 0;
  } catch(const std::exception &e) { std::cerr<<e.what()<<std::endl;return 1; }
}
