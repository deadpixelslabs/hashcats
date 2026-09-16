/* HASHCATS CPU miner worker — exact Solidity proof:
   keccak256(abi.encodePacked(bytes32 challenge, address miner, uint256 nonce)) <= target
   Nonces use a 64-bit search window inside uint256 (upper 192 bits are zero).
*/
"use strict";

const ROT = new Uint8Array([0,1,62,28,27,36,44,6,55,20,3,10,43,25,39,41,45,15,21,8,18,2,61,56,14]);
const RCL = new Uint32Array([
  0x00000001,0x00008082,0x0000808a,0x80008000,0x0000808b,0x80000001,
  0x80008081,0x00008009,0x0000008a,0x00000088,0x80008009,0x8000000a,
  0x8000808b,0x0000008b,0x00008089,0x00008003,0x00008002,0x00000080,
  0x0000800a,0x8000000a,0x80008081,0x00008080,0x80000001,0x80008008
]);
const RCH = new Uint32Array([
  0x00000000,0x00000000,0x80000000,0x80000000,0x00000000,0x00000000,
  0x80000000,0x80000000,0x00000000,0x00000000,0x00000000,0x00000000,
  0x00000000,0x80000000,0x80000000,0x80000000,0x80000000,0x80000000,
  0x00000000,0x80000000,0x80000000,0x80000000,0x00000000,0x80000000
]);

const cL = new Uint32Array(5), cH = new Uint32Array(5);
const dL = new Uint32Array(5), dH = new Uint32Array(5);
const b = new Uint32Array(50);
let running = false;
let session = 0;

function keccakF(a) {
  for (let rnd = 0; rnd < 24; rnd++) {
    // Theta
    for (let x = 0; x < 5; x++) {
      let lo = 0, hi = 0;
      for (let y = 0; y < 5; y++) {
        const i = 2 * (x + 5 * y);
        lo ^= a[i]; hi ^= a[i + 1];
      }
      cL[x] = lo >>> 0; cH[x] = hi >>> 0;
    }
    for (let x = 0; x < 5; x++) {
      const xp = (x + 1) % 5;
      const lo = cL[xp], hi = cH[xp];
      const rl = ((lo << 1) | (hi >>> 31)) >>> 0;
      const rh = ((hi << 1) | (lo >>> 31)) >>> 0;
      dL[x] = (cL[(x + 4) % 5] ^ rl) >>> 0;
      dH[x] = (cH[(x + 4) % 5] ^ rh) >>> 0;
    }
    for (let x = 0; x < 5; x++) {
      const dl = dL[x], dh = dH[x];
      for (let y = 0; y < 5; y++) {
        const i = 2 * (x + 5 * y);
        a[i] = (a[i] ^ dl) >>> 0;
        a[i + 1] = (a[i + 1] ^ dh) >>> 0;
      }
    }

    // Rho + Pi
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) {
      const src = x + 5 * y;
      const i = 2 * src;
      const r = ROT[src];
      const lo = a[i], hi = a[i + 1];
      let rl, rh;
      if (r === 0) { rl = lo; rh = hi; }
      else if (r < 32) {
        rl = ((lo << r) | (hi >>> (32 - r))) >>> 0;
        rh = ((hi << r) | (lo >>> (32 - r))) >>> 0;
      } else if (r === 32) { rl = hi; rh = lo; }
      else {
        const q = r - 32;
        rl = ((hi << q) | (lo >>> (32 - q))) >>> 0;
        rh = ((lo << q) | (hi >>> (32 - q))) >>> 0;
      }
      const di = 2 * (y + 5 * ((2 * x + 3 * y) % 5));
      b[di] = rl; b[di + 1] = rh;
    }

    // Chi
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) {
      const i = 2 * (x + 5 * y);
      const i1 = 2 * (((x + 1) % 5) + 5 * y);
      const i2 = 2 * (((x + 2) % 5) + 5 * y);
      a[i] = (b[i] ^ ((~b[i1]) & b[i2])) >>> 0;
      a[i + 1] = (b[i + 1] ^ ((~b[i1 + 1]) & b[i2 + 1])) >>> 0;
    }

    // Iota
    a[0] = (a[0] ^ RCL[rnd]) >>> 0;
    a[1] = (a[1] ^ RCH[rnd]) >>> 0;
  }
}

function hexBytes(hex) {
  hex = String(hex).replace(/^0x/, "");
  if (hex.length % 2) throw new Error("bad hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bswap32(v) {
  return (((v & 0xff) << 24) | ((v & 0xff00) << 8) | ((v >>> 8) & 0xff00) | ((v >>> 24) & 0xff)) >>> 0;
}

function buildBase(challenge, address) {
  const ch = hexBytes(challenge), ad = hexBytes(address);
  if (ch.length !== 32 || ad.length !== 20) throw new Error("invalid challenge/address length");
  const msg = new Uint8Array(52);
  msg.set(ch, 0); msg.set(ad, 32);
  const a = new Uint32Array(50);
  for (let i = 0; i < msg.length; i++) {
    const lane = (i / 8) | 0, off = i & 7;
    const wi = (lane << 1) + (off >= 4 ? 1 : 0), sh = (off & 3) << 3;
    a[wi] = (a[wi] ^ (msg[i] << sh)) >>> 0;
  }
  // Keccak-256 padding for an 84-byte message, rate = 136 bytes, suffix = 0x01.
  a[21] = (a[21] ^ 0x00000001) >>> 0; // byte 84
  a[33] = (a[33] ^ 0x80000000) >>> 0; // byte 135
  return a;
}

function targetWords(hex) {
  hex = String(hex).replace(/^0x/, "").padStart(64, "0").slice(-64);
  const out = new Uint32Array(8);
  for (let i = 0; i < 8; i++) out[i] = parseInt(hex.slice(i * 8, i * 8 + 8), 16) >>> 0;
  return out;
}

function hashLEWordsToHex(a) {
  let s = "0x";
  for (let i = 0; i < 8; i++) s += bswap32(a[i]).toString(16).padStart(8, "0");
  return s;
}

function isBelowTarget(a, target) {
  for (let i = 0; i < 8; i++) {
    const hw = bswap32(a[i]);
    const tw = target[i];
    if (hw < tw) return true;
    if (hw > tw) return false;
  }
  return true;
}

function randomU32() {
  const x = new Uint32Array(1);
  crypto.getRandomValues(x);
  return x[0] >>> 0;
}

function nonceToString(hi, lo) {
  return ((BigInt(hi >>> 0) << 32n) | BigInt(lo >>> 0)).toString();
}

function runMine(cfg, mySession) {
  const base = buildBase(cfg.challenge, cfg.miner);
  const target = targetWords(cfg.target);
  const state = new Uint32Array(50);
  const batchSize = Math.max(64, Math.min(8192, Number(cfg.batchSize) || 1024));
  let hi = (cfg.seedHi ?? randomU32()) >>> 0;
  let lo = (cfg.seedLo ?? randomU32()) >>> 0;
  let reportHashes = 0;
  let lastReport = performance.now();

  function batch() {
    if (!running || session !== mySession) return;
    for (let j = 0; j < batchSize; j++) {
      state.set(base);
      // uint256 nonce uses upper 192 bits = 0 and a 64-bit search value in the low 64 bits.
      // Message bytes 76..79 = nonce high32 (big-endian), 80..83 = nonce low32 (big-endian).
      state[19] = bswap32(hi);
      state[20] = bswap32(lo);
      keccakF(state);
      reportHashes++;

      if (isBelowTarget(state, target)) {
        running = false;
        postMessage({
          type: "FOUND",
          nonce: nonceToString(hi, lo),
          hash: hashLEWordsToHex(state),
          hashes: reportHashes
        });
        return;
      }

      lo = (lo + 1) >>> 0;
      if (lo === 0) hi = (hi + 1) >>> 0;
    }

    const now = performance.now();
    if (now - lastReport >= 500) {
      postMessage({ type: "HASHES", count: reportHashes, ms: now - lastReport });
      reportHashes = 0;
      lastReport = now;
    }
    setTimeout(batch, 0);
  }
  batch();
}

onmessage = (event) => {
  const msg = event.data || {};
  if (msg.type === "START") {
    running = false;
    session++;
    const current = session;
    running = true;
    try { runMine(msg, current); }
    catch (error) {
      running = false;
      postMessage({ type: "ERROR", message: error?.message || String(error) });
    }
  } else if (msg.type === "STOP") {
    running = false;
    session++;
  }
};
