# CLAUDE.md

## Related project: agent-telegram-gateway

The Telegram gateway (the other end of protocol v1, `/v1/connect`) lives next to this repo:
`~/proj/agent-telegram-gateway`.

Treat the two repos as one project: a single session may read and change both, e.g. a protocol change touches
`packages/protocol` here, the connector, and the gateway there. Each repo keeps its own git history, versions and
commits.
