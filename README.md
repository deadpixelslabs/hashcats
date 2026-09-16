# HASHCATS Miner — GPU Fixed Final

Production Arc miner frontend.

Key fix: the WGSL storage binding previously used the identifier `target`, which reproduced the shader compile issue from the earlier miner prototype. It is now `targetBuf`, matching the proven fix pattern used by the working WebGPU miner.

Deploy by replacing the existing GitHub frontend files with this folder and committing. Vercel should redeploy automatically. Then hard-refresh the site once.
