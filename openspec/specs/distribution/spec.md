# distribution

How anytts is packaged, released and watched against the upstream endpoint.

### Requirement: anytts is a public, dependency-free ESM package with three entries
Published to npm as `anytts`, MIT-licensed, ESM-only, no runtime dependencies, entries
`anytts`, `anytts/text` and `anytts/server`, Node ≥ 22.

#### Scenario: Installs and imports in Node
- **WHEN** a scratch Node 22 project installs the published version and imports all three entries
- **THEN** every import resolves with type declarations and no runtime dependency is installed

#### Scenario: Bundles for the browser
- **WHEN** a browser bundle (e.g. Vite) imports `anytts`
- **THEN** it builds without Node built-in polyfills

#### Scenario: Browser bundle does not pull in the server
- **WHEN** a browser bundle imports `anytts`
- **THEN** no `anytts/server` code is included

#### Scenario: Text entry does not pull in the engine
- **WHEN** a bundle imports only `anytts/text`
- **THEN** no engine, transport or token code is included

### Requirement: Releases are published from tags
A pushed version tag runs tests and publishes that version to npm.

#### Scenario: Tag publishes
- **WHEN** tag `vX.Y.Z` is pushed and the suite is green
- **THEN** `anytts@X.Y.Z` appears on npm

### Requirement: A live contract test watches Microsoft's endpoint
The live contract test performs one short synthesis directly, one through a locally started Relay
handler, and fetches the voice list against the real endpoint; it is excluded from PR CI and runs
nightly.

#### Scenario: Nightly detects a token change
- **WHEN** Microsoft starts rejecting the current token
- **THEN** the nightly workflow fails on the live contract test
