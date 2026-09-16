# HASHCATS Miner — WebGPU Production

Primary engine: real WebGPU Keccak-256.
Fallback: CPU web workers.

Contract: 0x5f53a69f8f87b7a321c8cd69957a7e622314b732
Chain: Arc Mainnet (5042)
Backend: https://hashcats-server.vercel.app

GitHub update:
1. Replace the files in the existing miner repository with these files.
2. Commit to the production branch.
3. Vercel redeploys automatically if connected to GitHub.

The GPU miner searches `keccak256(abi.encodePacked(currentChallenge, miner, nonce)) <= target`.
Every GPU candidate is checked again through `previewProof()` before any mining transaction is requested.


GPU retry patch: the GPU button remains clickable when WebGPU is unavailable or initialization fails. It will retry adapter initialization and show the exact error.
