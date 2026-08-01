# Security

Mengine MCP is a development tool. It can launch configured applications, inject input, inspect and mutate a live scene, execute Python code, and replace session resources.

- Use it only with trusted workspaces and Development builds.
- Do not commit credentials or MCP session tokens.
- Keep non-loopback runtime hosts on an explicit allowlist.
- Do not include `MCPPlugin` in Master or Release application builds.

Report vulnerabilities privately to the repository owner instead of opening a public issue with exploit details.
