# HASHCATS Miner — WebGPU compatibility build

This build keeps the HASHCATS Arc production frontend but changes GPU detection so it does not require a high-performance-only adapter.

Adapter order:
1. high-performance preference
2. browser default adapter
3. low-power preference

If any WebGPU adapter is available, GPU mode is enabled. CPU remains fallback only.

Production contract: `0x5f53a69f8f87b7a321c8cd69957a7e622314b732`
Backend: `https://hashcats-server.vercel.app`
