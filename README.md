# gh-pages: Pi's client document for grove

`oauth/pi-client.json` is the OAuth Client ID Metadata Document that Pi uses to sign in to grove's knowledge
base (`agent/mcp.json` on `main`, `oauth.clientId`). It is Pi's own document from
`https://pi.dev/oauth/client.json` without `token_endpoint_auth_methods_supported`, which Keycloak 26.8
refuses to parse, and without `client_uri`/`logo_uri`, so grove trusts only this host. Background:
`docs/v1-notes.md` on `main`.
