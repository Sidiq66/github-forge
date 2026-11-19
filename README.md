# github-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Sidiq66/github-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Sidiq66/github-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in a single Node process, standard library only — no dependencies, no git binary. One in-memory store backs four surfaces: git smart HTTP (protocol v2 ls-refs and fetch with shallow/deepen, v0 receive-pack with report-status, packfiles with delta resolution implemented on node:zlib and node:crypto), the REST v3 API (repositories, branches, commits, contents, labels, issues, comments, pull requests with squash merges), the GraphQL v4 API (the queries, mutations and introspection gh and github-mcp-server send), and an MCP endpoint (server/discover plus tools that act on the same store as REST). Timestamps and ids come from a deterministic logical clock, so identical request sequences produce identical answers. The entry registers its ephemeral port with $MAKEFUN_ENV_URL, answers /healthz, and runs until the env reports done.

## Run it

```sh
node --experimental-strip-types main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=x9j98tfg&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
