# HASH CATS — Windows CLI Miner (Build It Yourself)

This guide lets anyone build the official HASH CATS NVIDIA CUDA CLI miner from source on their own Windows PC.

**No precompiled EXE is required.**  
**No private key or seed phrase is required for mining.**

## Network

- Network: BNB Smart Chain mainnet
- Chain ID: 56
- HASH CATS contract: `0x971a63cc74d28210a09aa0914483c6116473e6b3`
- Reward: `237,500 HASHCATS` per successful mining block
- Winner fee: `0.000341 BNB + normal BSC gas`
- Official miner: https://www.minehashcats.xyz/
- Official X: https://x.com/hashcats_bsc

## How it works

The miner searches the exact proof required by the deployed HASH CATS contract:

```text
keccak256(abi.encodePacked(currentChallenge, minerAddress, uint256(nonce))) <= target
```

The public wallet address is part of the Proof-of-Work. Mining itself does not require a private key.

When a valid proof is found, mining pauses and a localhost claim page opens. The user explicitly connects the matching wallet and clicks **CLAIM REWARD**. The claim page re-checks the live challenge, verifies the proof, simulates the transaction, and only then requests the wallet transaction.

## Requirements

Install these first:

1. Windows 10/11 64-bit
2. NVIDIA GPU + current NVIDIA driver
3. Node.js 20 or newer
4. Microsoft Visual Studio 2022 Build Tools
   - select **Desktop development with C++**
5. Current NVIDIA CUDA Toolkit supported by your GPU

After installing CUDA, open a new Command Prompt and verify:

```bat
node --version
npm --version
nvcc --version
```

All three commands must work.

---

# 1. Create the project folders

Open **PowerShell**:

```powershell
mkdir hashcats-miner
cd hashcats-miner
mkdir cuda
mkdir web
mkdir bin
```

Your folder will eventually look like this:

```text
hashcats-miner/
├─ package.json
├─ miner.js
├─ setup.bat
├─ start.bat
├─ cuda/
│  └─ hashcats_cuda.cu
├─ web/
│  └─ claim.html
└─ bin/
   └─ hashcats_cuda.exe   ← created by nvcc
```

---

# 2. Create each source file

Create each file below with Notepad or VS Code and paste the matching source exactly.


## `package.json`

```json
{
  "name": "hash-cats-cli-miner",
  "version": "1.0.0",
  "private": true,
  "description": "HASH CATS native NVIDIA CUDA miner for BNB Smart Chain",
  "type": "module",
  "engines": { "node": ">=20" },
  "dependencies": {
    "ethers": "6.13.5"
  }
}
```


## `miner.js`

```javascript
import { ethers } from 'ethers';
import { spawn } from 'child_process';
import readline from 'readline';
import { createServer } from 'http';
import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';

const __dirname=path.dirname(fileURLToPath(import.meta.url));
const CONTRACT='0x971a63cc74d28210a09aa0914483c6116473e6b3';
const RPC_DEFAULT='https://bsc-dataseed.binance.org/';
const FEE='0.000341';
const ABI=[
 'function miningActivated() view returns(bool)',
 'function currentChallenge() view returns(bytes32)',
 'function target() view returns(uint256)',
 'function currentDifficulty() view returns(uint256)',
 'function miningBlocksMined() view returns(uint256)',
 'function miningPoolRemaining() view returns(uint256)',
 'function remainingWinsFor(address) view returns(uint256)'
];
const args=process.argv.slice(2);
function arg(name,def=null){const i=args.indexOf(name);return i>=0&&i+1<args.length?args[i+1]:def}
const has=x=>args.includes(x);
if(has('--help')){console.log(`HASH CATS CLI Miner\n\nUsage:\n  start.bat --wallet 0xYourWallet\n\nOptions:\n  --wallet 0x...     Miner/reward wallet\n  --rpc URL          BSC JSON-RPC\n  --device N         NVIDIA CUDA device index (default 0)\n  --batch N          Initial nonce batch (default 8388608)\n  --port N           Local claim page port (default 8787)\n  --no-browser       Do not auto-open local claim page\n`);process.exit(0)}

let wallet=arg('--wallet');const rpc=arg('--rpc',RPC_DEFAULT);const device=Number(arg('--device','0'));let batch=Number(arg('--batch','8388608'));const port=Number(arg('--port','8787'));const noBrowser=has('--no-browser');
const MIN_BATCH=262144,MAX_BATCH=1073741824,TARGET_MS=180;
const provider=new ethers.JsonRpcProvider(rpc,56,{staticNetwork:true});
const contract=new ethers.Contract(CONTRACT,ABI,provider);
let worker=null,pendingResolvers=[],closed=false,pendingProof=null,mining=true;
const token=crypto.randomBytes(24).toString('hex');
const claimHtml=readFileSync(path.join(__dirname,'web','claim.html'));

function rate(v){if(v>=1e9)return(v/1e9).toFixed(2)+' GH/s';if(v>=1e6)return(v/1e6).toFixed(2)+' MH/s';if(v>=1e3)return(v/1e3).toFixed(2)+' KH/s';return v.toFixed(0)+' H/s'}
function nfmt(v){return new Intl.NumberFormat('en-US').format(v)}
function short(x){return x?x.slice(0,10)+'…'+x.slice(-8):'—'}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function random64(){return BigInt('0x'+crypto.randomBytes(8).toString('hex'))}
function clamp(v,a,b){return Math.max(a,Math.min(b,v))}
function banner(){console.log('\n\x1b[92m██╗  ██╗ █████╗ ███████╗██╗  ██╗     ██████╗ █████╗ ████████╗███████╗\x1b[0m');console.log('\x1b[92mHASH CATS — NVIDIA CUDA CLI MINER\x1b[0m');console.log('Mine it. Don\'t mint it.\n')}

async function promptWallet(){if(wallet)return;const rl=readline.createInterface({input:process.stdin,output:process.stdout});wallet=await new Promise(r=>rl.question('Miner wallet (0x...): ',v=>r(v.trim())));rl.close()}
function workerPath(){return path.join(__dirname,'bin','hashcats_cuda.exe')}
function send(cmd){return new Promise((resolve,reject)=>{if(!worker||closed)return reject(new Error('CUDA worker not running'));pendingResolvers.push({resolve,reject});worker.stdin.write(cmd+'\n')})}
async function startWorker(){if(!existsSync(workerPath()))throw new Error('bin\\hashcats_cuda.exe not found. Run setup.bat first.');worker=spawn(workerPath(),['--device',String(device)],{stdio:['pipe','pipe','pipe']});const rl=readline.createInterface({input:worker.stdout});rl.on('line',line=>{let obj;try{obj=JSON.parse(line)}catch{return console.error('CUDA worker:',line)}const p=pendingResolvers.shift();if(p){if(obj.ok===false)p.reject(new Error(obj.error||'CUDA error'));else p.resolve(obj)}});worker.stderr.on('data',d=>process.stderr.write(d));worker.on('exit',code=>{closed=true;for(const p of pendingResolvers)p.reject(new Error('CUDA worker exited '+code));pendingResolvers=[]});return await send('INFO')}
async function state(){const [activated,challenge,target,difficulty,mined,pool,wins,bn]=await Promise.all([contract.miningActivated(),contract.currentChallenge(),contract.getFunction('target').staticCall(),contract.currentDifficulty(),contract.miningBlocksMined(),contract.miningPoolRemaining(),contract.remainingWinsFor(wallet),provider.getBlockNumber()]);return{activated,challenge,target,difficulty,mined,pool,wins,bn}}
async function selfTest(challenge){const nonce=123456789n;const expected=ethers.solidityPackedKeccak256(['bytes32','address','uint256'],[challenge,wallet,nonce]);const got=await send(`HASH ${challenge} ${wallet} ${nonce}`);if(got.hash.toLowerCase()!==expected.toLowerCase())throw new Error(`CUDA Keccak self-test FAILED\nExpected ${expected}\nGPU      ${got.hash}`);console.log('\x1b[92mCUDA Keccak self-test: PASS\x1b[0m')}
function soundAlert(){process.stdout.write('\x07');if(process.platform==='win32'){const ps='[console]::beep(1200,250); Start-Sleep -Milliseconds 120; [console]::beep(1500,350); Start-Sleep -Milliseconds 120; [console]::beep(1800,500)';spawn('powershell.exe',['-NoProfile','-Command',ps],{detached:true,stdio:'ignore'}).unref()}}
function openBrowser(url){if(noBrowser)return;if(process.platform==='win32')spawn('cmd.exe',['/c','start','',url],{detached:true,stdio:'ignore'}).unref();else if(process.platform==='darwin')spawn('open',[url],{detached:true,stdio:'ignore'}).unref();else spawn('xdg-open',[url],{detached:true,stdio:'ignore'}).unref()}

const server=createServer(async(req,res)=>{try{const u=new URL(req.url,'http://127.0.0.1');if(u.searchParams.get('token')!==token){res.writeHead(403);return res.end('Forbidden')}if(req.method==='GET'&&u.pathname==='/'){res.writeHead(200,{'content-type':'text/html; charset=utf-8','cache-control':'no-store'});return res.end(claimHtml)}if(req.method==='GET'&&u.pathname==='/api/proof'){res.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});return res.end(JSON.stringify({proof:pendingProof}))}if(req.method==='POST'&&u.pathname==='/api/claimed'){let body='';for await(const c of req)body+=c;let tx='';try{tx=JSON.parse(body||'{}').tx||''}catch{}console.log(`\n\x1b[92m✓ CLAIM CONFIRMED ${tx||''}\x1b[0m`);pendingProof=null;mining=true;res.writeHead(200,{'content-type':'application/json'});return res.end('{"ok":true}')}if(req.method==='POST'&&u.pathname==='/api/dismiss'){console.log('\nProof dismissed. Mining resumed.');pendingProof=null;mining=true;res.writeHead(200,{'content-type':'application/json'});return res.end('{"ok":true}')}res.writeHead(404);res.end('Not found')}catch(e){res.writeHead(500);res.end(e.message)}});

async function waitOnProof(){while(pendingProof){await sleep(900);try{const live=await contract.currentChallenge();if(live.toLowerCase()!==pendingProof.challenge.toLowerCase()){pendingProof.stale=true;console.log('\n\x1b[93mProof became stale — another block changed the challenge. Resuming mining.\x1b[0m');await sleep(1200);pendingProof=null;mining=true;break}}catch{}}}

async function main(){banner();await promptWallet();try{wallet=ethers.getAddress(wallet)}catch{throw new Error('Invalid wallet address.')}console.log('Wallet       :',wallet);console.log('Contract     :',CONTRACT);console.log('Network      : BNB Chain (56)');console.log('Claim mode   : local browser + wallet confirmation');console.log('Private key  : NOT requested / NOT stored\n');server.listen(port,'127.0.0.1',()=>console.log(`Local claim  : http://127.0.0.1:${port}/ (localhost only)`));const info=await startWorker();console.log(`GPU          : #${info.device} ${info.name}`);console.log(`CUDA CC      : ${info.cc}`);console.log(`VRAM         : ${(Number(info.vram)/1024**3).toFixed(1)} GB\n`);let s=await state();if(!s.activated)throw new Error('Mining is not activated on-chain yet.');if(s.wins===0n)throw new Error('This wallet already reached the 50-win limit.');await selfTest(s.challenge);console.log('Difficulty   :',nfmt(s.difficulty.toString()));console.log('Blocks mined :',`${s.mined}/40,000`);console.log('Wins left    :',s.wins.toString());console.log('\n\x1b[96mMINING STARTED\x1b[0m — Ctrl+C to stop.\n');let nonce=random64(),challenge=s.challenge,target=s.target,total=0n,lastState=Date.now(),lastPrint=0;while(true){if(!mining||pendingProof){await waitOnProof();s=await state();challenge=s.challenge;target=s.target;nonce=random64();lastState=Date.now();continue}if(Date.now()-lastState>850){try{const ns=await state();lastState=Date.now();if(ns.wins===0n)throw new Error('Wallet reached 50 wins.');if(ns.challenge.toLowerCase()!==challenge.toLowerCase()){challenge=ns.challenge;target=ns.target;nonce=random64();console.log('\nNew challenge:',short(challenge));}else target=ns.target;s=ns}catch(e){console.log('\nRPC refresh:',e.message);await sleep(500)}}const start=nonce;const r=await send(`MINE ${challenge} ${wallet} 0x${target.toString(16).padStart(64,'0')} ${start} ${Math.floor(batch)}`);total+=BigInt(r.tested);nonce=BigInt.asUintN(64,nonce+BigInt(r.tested));const hps=r.tested/(Math.max(r.ms,0.001)/1000);const factor=clamp(TARGET_MS/Math.max(r.ms,1),0.5,4);batch=Math.floor(clamp(batch*factor,MIN_BATCH,MAX_BATCH)/256)*256;if(Date.now()-lastPrint>500){process.stdout.write(`\rHashrate ${rate(hps).padEnd(13)} | Tested ${nfmt(total.toString()).padStart(18)} | Batch ${nfmt(r.tested).padStart(13)} | ${r.ms.toFixed(1).padStart(7)} ms   `);lastPrint=Date.now()}if(r.found){const found=BigInt(r.nonce);const proof=ethers.solidityPackedKeccak256(['bytes32','address','uint256'],[challenge,wallet,found]);if(BigInt(proof)>target){console.log('\n\x1b[91mCUDA candidate failed CPU verification. Ignored.\x1b[0m');continue}const live=await contract.currentChallenge();if(live.toLowerCase()!==challenge.toLowerCase()){console.log('\n\x1b[93mValid proof was stale before claim. Continuing.\x1b[0m');challenge=live;nonce=random64();continue}mining=false;pendingProof={wallet,nonce:found.toString(),proof,challenge,target:'0x'+target.toString(16).padStart(64,'0'),reward:'237500',fee:FEE,stale:false};console.log('\n\n\x1b[92m████ BLOCK FOUND ████\x1b[0m');console.log('Nonce :',found.toString());console.log('Proof :',proof);console.log('Reward: 237,500 HASHCATS');console.log('Fee   : 0.000341 BNB + gas');console.log('\nMining paused while proof is live.');soundAlert();const url=`http://127.0.0.1:${port}/?token=${token}`;console.log('Claim :',url);openBrowser(url)}}}

process.on('SIGINT',()=>{console.log('\n\nStopping HASH CATS miner…');try{worker?.stdin.write('QUIT\n')}catch{}server.close();setTimeout(()=>process.exit(0),100)});
main().catch(e=>{console.error('\n\x1b[91mERROR:\x1b[0m',e.message);try{worker?.kill()}catch{}server.close();process.exitCode=1});
```


## `cuda/hashcats_cuda.cu`

```cpp
#include <cuda_runtime.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <iostream>
#include <sstream>
#include <string>
#include <vector>
#include <iomanip>
#include <algorithm>

#define CUDA_OK(x) do { cudaError_t _e=(x); if(_e!=cudaSuccess){ std::cout << "{\"ok\":false,\"error\":\"CUDA: " << cudaGetErrorString(_e) << "\"}" << std::endl; return 1; } } while(0)

__constant__ uint64_t C_BASE[25];
__constant__ uint64_t C_TARGET[4];

struct Result {
    int found;
    unsigned long long nonce;
};

__device__ __forceinline__ uint64_t rotl64(uint64_t x, int n) {
    return (x << n) | (x >> (64 - n));
}

__device__ __forceinline__ uint32_t bswap32d(uint32_t x) {
    return ((x & 0x000000ffu) << 24) |
           ((x & 0x0000ff00u) << 8)  |
           ((x & 0x00ff0000u) >> 8)  |
           ((x & 0xff000000u) >> 24);
}

__device__ __forceinline__ uint64_t bswap64d(uint64_t x) {
    uint32_t lo = (uint32_t)x;
    uint32_t hi = (uint32_t)(x >> 32);
    return ((uint64_t)bswap32d(lo) << 32) | (uint64_t)bswap32d(hi);
}

__device__ __forceinline__ void keccakf(uint64_t st[25]) {
    const uint64_t RC[24] = {
        0x0000000000000001ULL,0x0000000000008082ULL,0x800000000000808aULL,0x8000000080008000ULL,
        0x000000000000808bULL,0x0000000080000001ULL,0x8000000080008081ULL,0x8000000000008009ULL,
        0x000000000000008aULL,0x0000000000000088ULL,0x0000000080008009ULL,0x000000008000000aULL,
        0x000000008000808bULL,0x800000000000008bULL,0x8000000000008089ULL,0x8000000000008003ULL,
        0x8000000000008002ULL,0x8000000000000080ULL,0x000000000000800aULL,0x800000008000000aULL,
        0x8000000080008081ULL,0x8000000000008080ULL,0x0000000080000001ULL,0x8000000080008008ULL
    };
    const int ROTC[24] = {1,3,6,10,15,21,28,36,45,55,2,14,27,41,56,8,25,43,62,18,39,61,20,44};
    const int PILN[24] = {10,7,11,17,18,3,5,16,8,21,24,4,15,23,19,13,12,2,20,14,22,9,6,1};

    #pragma unroll 1
    for (int round = 0; round < 24; ++round) {
        uint64_t bc[5];
        #pragma unroll
        for (int i = 0; i < 5; ++i)
            bc[i] = st[i] ^ st[i+5] ^ st[i+10] ^ st[i+15] ^ st[i+20];

        #pragma unroll
        for (int i = 0; i < 5; ++i) {
            uint64_t t = bc[(i+4)%5] ^ rotl64(bc[(i+1)%5], 1);
            st[i] ^= t; st[i+5] ^= t; st[i+10] ^= t; st[i+15] ^= t; st[i+20] ^= t;
        }

        uint64_t t = st[1];
        #pragma unroll
        for (int i = 0; i < 24; ++i) {
            int j = PILN[i];
            uint64_t tmp = st[j];
            st[j] = rotl64(t, ROTC[i]);
            t = tmp;
        }

        #pragma unroll
        for (int j = 0; j < 25; j += 5) {
            #pragma unroll
            for (int i = 0; i < 5; ++i) bc[i] = st[j+i];
            #pragma unroll
            for (int i = 0; i < 5; ++i) st[j+i] ^= (~bc[(i+1)%5]) & bc[(i+2)%5];
        }
        st[0] ^= RC[round];
    }
}

__device__ __forceinline__ void state_for_nonce(uint64_t nonce, uint64_t st[25]) {
    #pragma unroll
    for (int i = 0; i < 25; ++i) st[i] = C_BASE[i];
    uint32_t hi = (uint32_t)(nonce >> 32);
    uint32_t lo = (uint32_t)nonce;
    // Solidity uint256 is big-endian inside abi.encodePacked. We search only the low 64 bits;
    // the upper 192 nonce bits remain zero. Nonce bytes occupy input offsets 76..83.
    st[9]  = ((uint64_t)bswap32d(hi) << 32);
    st[10] = (st[10] & 0xffffffff00000000ULL) | (uint64_t)bswap32d(lo);
}

__device__ __forceinline__ bool hash_le_target(const uint64_t st[25]) {
    // Keccak digest bytes are the little-endian bytes of lanes 0..3.
    // Convert each 8-byte digest chunk to a big-endian integer chunk for uint256 comparison.
    #pragma unroll
    for (int i = 0; i < 4; ++i) {
        uint64_t h = bswap64d(st[i]);
        uint64_t t = C_TARGET[i];
        if (h < t) return true;
        if (h > t) return false;
    }
    return true;
}

__global__ void mine_kernel(unsigned long long start, unsigned long long count, Result* result) {
    unsigned long long idx = (unsigned long long)blockIdx.x * blockDim.x + threadIdx.x;
    if (idx >= count) return;
    if (result->found) return;
    uint64_t nonce = start + idx;
    uint64_t st[25];
    state_for_nonce(nonce, st);
    keccakf(st);
    if (hash_le_target(st)) {
        if (atomicCAS(&result->found, 0, 1) == 0) result->nonce = nonce;
    }
}

__global__ void hash_one_kernel(unsigned long long nonce, uint64_t* out4) {
    if (blockIdx.x || threadIdx.x) return;
    uint64_t st[25];
    state_for_nonce(nonce, st);
    keccakf(st);
    out4[0] = st[0]; out4[1] = st[1]; out4[2] = st[2]; out4[3] = st[3];
}

static uint64_t load64le(const uint8_t* p) {
    uint64_t v = 0;
    for (int i = 0; i < 8; ++i) v |= ((uint64_t)p[i]) << (8*i);
    return v;
}

static bool hex_to_bytes(std::string s, std::vector<uint8_t>& out, size_t expected) {
    if (s.rfind("0x",0)==0 || s.rfind("0X",0)==0) s=s.substr(2);
    if (s.size()!=expected*2) return false;
    out.resize(expected);
    for (size_t i=0;i<expected;++i) {
        char* end=nullptr;
        std::string b=s.substr(i*2,2);
        long v=strtol(b.c_str(),&end,16);
        if (!end || *end) return false;
        out[i]=(uint8_t)v;
    }
    return true;
}

static bool prepare_base(const std::string& challengeHex, const std::string& addressHex, uint64_t base[25]) {
    std::vector<uint8_t> ch, addr;
    if (!hex_to_bytes(challengeHex,ch,32) || !hex_to_bytes(addressHex,addr,20)) return false;
    uint8_t block[136]; memset(block,0,sizeof(block));
    memcpy(block,ch.data(),32);
    memcpy(block+32,addr.data(),20);
    // 32-byte uint256 nonce is zero in base. Low 64 bits are inserted by the GPU at bytes 76..83.
    block[84] ^= 0x01;   // Ethereum Keccak domain padding
    block[135] ^= 0x80;
    for (int i=0;i<25;++i) base[i]=0;
    for (int i=0;i<17;++i) base[i]=load64le(block+i*8);
    return true;
}

static bool prepare_target(std::string s, uint64_t target[4]) {
    if (s.rfind("0x",0)==0 || s.rfind("0X",0)==0) s=s.substr(2);
    if (s.size()>64) return false;
    s=std::string(64-s.size(),'0')+s;
    try {
        for (int i=0;i<4;++i) target[i]=std::stoull(s.substr(i*16,16),nullptr,16);
    } catch (...) { return false; }
    return true;
}

static std::string digest_hex_from_lanes(const uint64_t lanes[4]) {
    std::ostringstream o; o << "0x" << std::hex << std::setfill('0');
    for (int i=0;i<4;++i) {
        for (int b=0;b<8;++b) o << std::setw(2) << ((lanes[i] >> (8*b)) & 0xffULL);
    }
    return o.str();
}

static std::string json_escape(const char* s) {
    std::string out;
    for (;*s;++s) { if (*s=='\\' || *s=='\"') out+='\\'; if (*s=='\n') out+="\\n"; else out+=*s; }
    return out;
}

int main(int argc, char** argv) {
    int device=0;
    for (int i=1;i<argc-1;++i) if (std::string(argv[i])=="--device") device=atoi(argv[i+1]);
    cudaError_t se=cudaSetDevice(device);
    if(se!=cudaSuccess){ std::cout << "{\"ok\":false,\"error\":\"cudaSetDevice failed\"}" << std::endl; return 2; }

    Result* d_result=nullptr; uint64_t* d_hash=nullptr;
    if(cudaMalloc(&d_result,sizeof(Result))!=cudaSuccess || cudaMalloc(&d_hash,4*sizeof(uint64_t))!=cudaSuccess) {
        std::cout << "{\"ok\":false,\"error\":\"CUDA allocation failed\"}" << std::endl; return 2;
    }

    std::string line;
    while(std::getline(std::cin,line)) {
        std::istringstream iss(line); std::string cmd; iss>>cmd;
        if(cmd=="QUIT") break;
        if(cmd=="INFO") {
            cudaDeviceProp p{}; int count=0; cudaGetDeviceCount(&count); cudaGetDeviceProperties(&p,device);
            std::cout << "{\"ok\":true,\"type\":\"info\",\"device\":"<<device<<",\"deviceCount\":"<<count
                      <<",\"name\":\""<<json_escape(p.name)<<"\",\"cc\":\""<<p.major<<"."<<p.minor
                      <<"\",\"vram\":"<<(unsigned long long)p.totalGlobalMem<<"}" << std::endl;
            continue;
        }
        if(cmd=="HASH") {
            std::string ch,addr,nonceS; iss>>ch>>addr>>nonceS;
            uint64_t base[25];
            if(!prepare_base(ch,addr,base)){ std::cout<<"{\"ok\":false,\"error\":\"bad HASH input\"}"<<std::endl; continue; }
            unsigned long long nonce=0; try{nonce=std::stoull(nonceS);}catch(...){std::cout<<"{\"ok\":false,\"error\":\"bad nonce\"}"<<std::endl;continue;}
            cudaMemcpyToSymbol(C_BASE,base,sizeof(base));
            hash_one_kernel<<<1,1>>>(nonce,d_hash);
            uint64_t h[4]; cudaError_t e=cudaDeviceSynchronize();
            if(e!=cudaSuccess){std::cout<<"{\"ok\":false,\"error\":\""<<json_escape(cudaGetErrorString(e))<<"\"}"<<std::endl;continue;}
            cudaMemcpy(h,d_hash,sizeof(h),cudaMemcpyDeviceToHost);
            std::cout<<"{\"ok\":true,\"type\":\"hash\",\"hash\":\""<<digest_hex_from_lanes(h)<<"\"}"<<std::endl;
            continue;
        }
        if(cmd=="MINE") {
            std::string ch,addr,targetHex,startS,countS; iss>>ch>>addr>>targetHex>>startS>>countS;
            uint64_t base[25], target[4];
            if(!prepare_base(ch,addr,base)||!prepare_target(targetHex,target)){std::cout<<"{\"ok\":false,\"error\":\"bad MINE input\"}"<<std::endl;continue;}
            unsigned long long start=0,count=0; try{start=std::stoull(startS);count=std::stoull(countS);}catch(...){std::cout<<"{\"ok\":false,\"error\":\"bad range\"}"<<std::endl;continue;}
            cudaMemcpyToSymbol(C_BASE,base,sizeof(base)); cudaMemcpyToSymbol(C_TARGET,target,sizeof(target));
            cudaMemset(d_result,0,sizeof(Result));
            int threads=256; unsigned long long blocks64=(count+threads-1)/threads;
            if(blocks64>2147483647ULL){std::cout<<"{\"ok\":false,\"error\":\"batch too large\"}"<<std::endl;continue;}
            cudaEvent_t a,b; cudaEventCreate(&a); cudaEventCreate(&b); cudaEventRecord(a);
            mine_kernel<<<(unsigned int)blocks64,threads>>>(start,count,d_result);
            cudaEventRecord(b); cudaEventSynchronize(b); float ms=0; cudaEventElapsedTime(&ms,a,b); cudaEventDestroy(a); cudaEventDestroy(b);
            cudaError_t e=cudaGetLastError(); if(e!=cudaSuccess){std::cout<<"{\"ok\":false,\"error\":\""<<json_escape(cudaGetErrorString(e))<<"\"}"<<std::endl;continue;}
            Result r{}; cudaMemcpy(&r,d_result,sizeof(Result),cudaMemcpyDeviceToHost);
            std::cout<<std::fixed<<std::setprecision(3)<<"{\"ok\":true,\"type\":\"mine\",\"tested\":"<<count<<",\"ms\":"<<ms<<",\"found\":"<<(r.found?"true":"false");
            if(r.found) std::cout<<",\"nonce\":\""<<r.nonce<<"\"";
            std::cout<<"}"<<std::endl;
            continue;
        }
        std::cout << "{\"ok\":false,\"error\":\"unknown command\"}" << std::endl;
    }
    cudaFree(d_result); cudaFree(d_hash);
    return 0;
}
```


## `web/claim.html`

```html
<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>HASH CATS — CLI Claim</title><meta name="theme-color" content="#071019">
<script src="https://cdn.jsdelivr.net/npm/ethers@6.13.5/dist/ethers.umd.min.js"></script>
<style>
:root{--g:#55ff9b;--c:#45dfff;--bg:#05070b;--p:#0b111b;--line:#1b2a3b;--muted:#81938f;--red:#ff7b89;--yellow:#ffd36b}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:radial-gradient(circle at 20% 0,rgba(85,255,155,.09),transparent 30%),#05070b;color:#eff8f5;font-family:Inter,system-ui,Segoe UI,Arial;padding:18px}.card{width:min(620px,100%);background:linear-gradient(180deg,#0d1621,#080d13);border:1px solid rgba(255,255,255,.08);border-radius:24px;box-shadow:0 30px 100px rgba(0,0,0,.55);overflow:hidden}.head{padding:22px;border-bottom:1px solid rgba(255,255,255,.06);display:flex;gap:13px;align-items:center}.cat{width:52px;height:52px;border-radius:16px;display:grid;place-items:center;border:1px solid rgba(85,255,155,.16);background:rgba(85,255,155,.05);font-size:27px}.title{font-weight:950;font-size:22px}.sub{color:var(--muted);font-size:12px;margin-top:4px}.body{padding:22px}.grid{display:grid;grid-template-columns:1fr 1fr;gap:9px}.item{padding:12px;border:1px solid rgba(255,255,255,.06);border-radius:13px;background:rgba(255,255,255,.025)}.item small{display:block;color:#6e817c;font-size:9px;letter-spacing:.1em;text-transform:uppercase;margin-bottom:6px}.item strong{font:700 12px ui-monospace,monospace;word-break:break-all}.status{margin-top:12px;padding:12px;border-radius:12px;background:rgba(85,255,155,.05);border:1px solid rgba(85,255,155,.12);color:#a0ddb9;font-size:12px;line-height:1.55}.status.bad{background:rgba(255,123,137,.05);border-color:rgba(255,123,137,.17);color:#ff9daa}.status.warn{background:rgba(255,211,107,.05);border-color:rgba(255,211,107,.17);color:#ebcf86}.actions{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:14px}.btn{border:0;border-radius:12px;padding:12px 14px;font-weight:900;cursor:pointer}.primary{background:linear-gradient(135deg,#55ff9b,#a2ffd2);color:#07120c}.dark{background:#111c2b;color:#e8f4f0;border:1px solid rgba(255,255,255,.07)}.btn:disabled{opacity:.45;cursor:not-allowed}.foot{color:#61736f;font-size:10px;line-height:1.55;margin-top:14px}.empty{text-align:center;padding:28px 4px;color:#7f918d}@media(max-width:560px){.grid,.actions{grid-template-columns:1fr}}
</style></head><body>
<div class="card"><div class="head"><div class="cat">🐱</div><div><div class="title">HASH CATS CLI CLAIM</div><div class="sub">Local claim page · wallet is accessed only after you click Connect Wallet.</div></div></div>
<div class="body" id="body"><div class="empty">Waiting for a valid proof from the CLI miner…</div></div></div>
<script>
const q=new URLSearchParams(location.search),TOKEN=q.get('token')||'';let pending=null,signer=null,wallet=null;
const CONTRACT='0x971a63cc74d28210a09aa0914483c6116473e6b3',FEE=341000000000000n;
const ABI=['function currentChallenge() view returns(bytes32)','function target() view returns(uint256)','function mine(uint256 nonce) payable returns(bytes32)'];
const esc=s=>String(s).replace(/[&<>"']/g,m=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[m]));
async function api(path,opt={}){const sep=path.includes('?')?'&':'?';const r=await fetch(path+sep+'token='+encodeURIComponent(TOKEN),opt);if(!r.ok)throw new Error(await r.text());return r.headers.get('content-type')?.includes('json')?r.json():r.text()}
function render(){const b=document.getElementById('body');if(!pending){b.innerHTML='<div class="empty">Waiting for a valid proof from the CLI miner…</div>';return;}const stale=pending.stale; b.innerHTML=`<div class="grid"><div class="item"><small>Reward</small><strong>237,500 HASHCATS</strong></div><div class="item"><small>Winner Fee</small><strong>0.000341 BNB + gas</strong></div><div class="item"><small>Miner Wallet</small><strong>${esc(pending.wallet)}</strong></div><div class="item"><small>Nonce</small><strong>${esc(pending.nonce)}</strong></div><div class="item"><small>Proof</small><strong>${esc(pending.proof.slice(0,18)+'…'+pending.proof.slice(-12))}</strong></div><div class="item"><small>Challenge</small><strong>${esc(pending.challenge.slice(0,18)+'…'+pending.challenge.slice(-12))}</strong></div></div><div id="status" class="status ${stale?'warn':''}">${stale?'This proof is stale. Another mining block changed the challenge; no claim should be sent.':'Proof was verified by the CLI. No wallet transaction has been requested yet.'}</div><div class="actions"><button id="connect" class="btn dark" ${stale?'disabled':''}>Connect Wallet</button><button id="claim" class="btn primary" disabled>CLAIM REWARD</button></div><div class="actions"><button id="dismiss" class="btn dark">Dismiss Proof</button><button id="scan" class="btn dark" onclick="window.open('https://bscscan.com/address/'+CONTRACT,'_blank')">View Contract</button></div><div class="foot">The connected wallet must match the miner wallet above. Before sending, this page re-checks the live challenge, verifies the Keccak proof locally, and simulates mine(nonce). No token approval is requested.</div>`;document.getElementById('connect').onclick=connect;document.getElementById('claim').onclick=claim;document.getElementById('dismiss').onclick=dismiss;}
function status(t,kind=''){const e=document.getElementById('status');if(e){e.className='status '+kind;e.textContent=t}}
async function connect(){try{if(!window.ethereum)throw new Error('No EVM wallet extension detected.');await window.ethereum.request({method:'eth_requestAccounts'});try{await window.ethereum.request({method:'wallet_switchEthereumChain',params:[{chainId:'0x38'}]})}catch(e){throw new Error('Switch your wallet to BNB Smart Chain.')}const p=new ethers.BrowserProvider(window.ethereum);signer=await p.getSigner();wallet=await signer.getAddress();if(wallet.toLowerCase()!==pending.wallet.toLowerCase())throw new Error('Wrong wallet. Connect '+pending.wallet);document.getElementById('connect').textContent=wallet.slice(0,8)+'…'+wallet.slice(-6);document.getElementById('claim').disabled=false;status('Wallet matched. Click CLAIM REWARD when ready.');}catch(e){status(e.shortMessage||e.message,'bad')}}
async function claim(){const btn=document.getElementById('claim');btn.disabled=true;try{if(!signer)throw new Error('Connect wallet first.');const c=new ethers.Contract(CONTRACT,ABI,signer);const live=await c.currentChallenge();if(live.toLowerCase()!==pending.challenge.toLowerCase())throw new Error('Proof is stale: the challenge already changed.');const proof=ethers.solidityPackedKeccak256(['bytes32','address','uint256'],[pending.challenge,pending.wallet,BigInt(pending.nonce)]);if(proof.toLowerCase()!==pending.proof.toLowerCase())throw new Error('Local proof verification failed.');const target=await c.getFunction('target').staticCall();if(BigInt(proof)>target)throw new Error('Proof no longer satisfies target.');status('Proof is live. Simulating claim before opening your wallet…');await c.mine.staticCall(BigInt(pending.nonce),{value:FEE});status('Simulation passed. Confirm the single mine(nonce) transaction in your wallet.');const tx=await c.mine(BigInt(pending.nonce),{value:FEE});status('Transaction sent: '+tx.hash);const rec=await tx.wait();status('CLAIMED ✓ 237,500 HASHCATS confirmed in block '+rec.blockNumber);await api('/api/claimed',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({tx:tx.hash})});btn.textContent='CLAIMED ✓';setTimeout(()=>window.open('https://bscscan.com/tx/'+tx.hash,'_blank'),500);}catch(e){status(e.shortMessage||e.message,'bad');btn.disabled=false}}
async function dismiss(){try{await api('/api/dismiss',{method:'POST'});pending=null;render()}catch(e){status(e.message,'bad')}}
async function poll(){try{const r=await api('/api/proof');const next=r.proof||null;if(JSON.stringify(next)!==JSON.stringify(pending)){pending=next;render()}}catch(e){}setTimeout(poll,1000)}poll();
</script></body></html>
```


## `setup.bat`

```bat
@echo off
setlocal
cd /d "%~dp0"
color 0A
echo ============================================================
echo              HASH CATS CLI MINER - SETUP
echo ============================================================
echo.
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js 20+ was not found.
  echo Install Node.js LTS, then run setup.bat again.
  pause
  exit /b 1
)
where npm >nul 2>nul
if errorlevel 1 (
  echo [ERROR] npm was not found.
  pause
  exit /b 1
)
where nvcc >nul 2>nul
if errorlevel 1 (
  echo [ERROR] NVIDIA CUDA Toolkit / nvcc was not found.
  echo.
  echo Install:
  echo   1. Microsoft Visual Studio 2022 Build Tools
  echo      - Desktop development with C++
  echo   2. A current NVIDIA CUDA Toolkit supported by your GPU
  echo.
  echo Then reopen Command Prompt and run setup.bat again.
  pause
  exit /b 1
)

echo [1/2] Installing Node dependency...
call npm install
if errorlevel 1 goto :fail

echo.
echo [2/2] Building native CUDA miner for THIS NVIDIA GPU...
if not exist bin mkdir bin
nvcc -O3 -std=c++17 -arch=native cuda\hashcats_cuda.cu -o bin\hashcats_cuda.exe
if errorlevel 1 (
  echo.
  echo [ERROR] CUDA build failed.
  echo If nvcc reports a host compiler error, install Visual Studio 2022 Build Tools
  echo with "Desktop development with C++" and retry.
  goto :fail
)

echo.
echo ============================================================
echo SETUP COMPLETE
echo Run start.bat to mine HASH CATS.
echo ============================================================
pause
exit /b 0
:fail
echo.
echo Setup failed. Read the error above.
pause
exit /b 1
```


## `start.bat`

```bat
@echo off
cd /d "%~dp0"
if not exist "node_modules\ethers" (
  echo Dependencies not installed. Running setup...
  call setup.bat
  if errorlevel 1 exit /b 1
)
if not exist "bin\hashcats_cuda.exe" (
  echo CUDA miner not built. Running setup...
  call setup.bat
  if errorlevel 1 exit /b 1
)
node miner.js %*
pause
```


---

# 3. Install dependency and compile

From inside the `hashcats-miner` folder:

```bat
setup.bat
```

The setup should:

1. run `npm install`
2. compile `cuda\hashcats_cuda.cu`
3. create:

```text
bin\hashcats_cuda.exe
```

You should see:

```text
SETUP COMPLETE
```

If `nvcc` is not found, close Command Prompt, reopen it after installing CUDA, then run:

```bat
nvcc --version
```

If CUDA reports a missing Microsoft compiler, modify Visual Studio Installer and add:

```text
Desktop development with C++
```

---

# 4. Start mining

Run:

```bat
start.bat
```

Then paste your **public BNB Chain wallet address**.

Or launch directly:

```bat
start.bat --wallet 0xYOUR_WALLET
```

For a second NVIDIA GPU:

```bat
start.bat --wallet 0xYOUR_WALLET --device 1
```

The miner performs a CUDA/Ethereum-Keccak self-test before mining. Do not continue if the self-test does not say:

```text
CUDA Keccak self-test: PASS
```

---

# 5. What you should see

Example:

```text
HASH CATS — NVIDIA CUDA CLI MINER
Mine it. Don't mint it.

Wallet       : 0x...
Contract     : 0x971a63cc74d28210a09aa0914483c6116473e6b3
Network      : BNB Chain (56)
Private key  : NOT requested / NOT stored

GPU          : NVIDIA ...
Difficulty   : 11,000,000,000

MINING STARTED

Hashrate ... MH/s | Tested ... | Batch ...
```

When a valid block is found:

```text
>>> BLOCK FOUND <<<

Nonce   : ...
Proof   : 0x...
Reward  : 237,500 HASHCATS
```

Mining pauses and a local page opens on:

```text
http://127.0.0.1:8787/
```

The page requires an internal random token generated by the CLI, so the claim session is only exposed through the URL opened by the miner.

Then:

```text
Connect Wallet
↓
wallet must match mining address
↓
CLAIM REWARD
↓
proof + challenge checked again
↓
mine(nonce) simulated
↓
wallet confirmation
↓
237,500 HASHCATS
```

If another miner wins before you claim, the challenge changes and your proof becomes stale. The miner discards the stale proof and resumes mining.

---

# Security rules

- Never paste a seed phrase into a miner.
- Never paste a private key into this miner.
- Mining requires only a public wallet address.
- The localhost claim page does not auto-connect.
- No ERC-20 approval is required.
- The actual winning transaction is requested only after the user clicks **CLAIM REWARD**.
- Always verify the contract address:
  `0x971a63cc74d28210a09aa0914483c6116473e6b3`
- Do not use unofficial binaries that request a seed phrase/private key.

---

# Useful options

```text
--wallet 0x...     Public mining/reward wallet
--rpc URL          Custom BSC JSON-RPC
--device N         CUDA GPU index, default 0
--batch N          Initial batch size
--port N           Local claim server port, default 8787
--no-browser       Do not automatically open the local claim page
--help             Show options
```

Example:

```bat
start.bat --wallet 0xYOUR_WALLET --device 0 --batch 8388608
```

## Important

The CLI miner and the browser WebGPU miner compete for the **same on-chain HASH CATS blocks**. There is no separate CLI allocation or special CLI reward.

**Mine it. Don't mint it.**
