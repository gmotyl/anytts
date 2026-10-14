## ADDED Requirements

### Requirement: free-tts is a public, dependency-free ESM package with two entries
Published to npm as `free-tts`, MIT-licensed, ESM-only, no runtime dependencies, entries
`free-tts` and `free-tts/text`, Node ≥ 22.

#### Scenario: Installs and imports in Node
- **WHEN** a scratch Node 22 project runs `pnpm add free-tts@0.1.0` and imports both entries
- **THEN** both imports resolve with type declarations and no runtime dependency is installed

#### Scenario: Bundles for the browser
- **WHEN** a Vite browser bundle imports `free-tts`
- **THEN** it builds without Node built-in polyfills

#### Scenario: Text entry does not pull in the engine
- **WHEN** a bundle imports only `free-tts/text`
- **THEN** no engine, transport or token code is included

### Requirement: Releases are published from tags
A pushed version tag runs tests and publishes that version to npm.

#### Scenario: Tag publishes
- **WHEN** tag `v0.1.0` is pushed and the suite is green
- **THEN** `free-tts@0.1.0` appears on npm

### Requirement: A live contract test watches Microsoft's endpoint
`pnpm test:live` performs one short synthesis and fetches the voice list against the real endpoint;
it is excluded from PR CI and runs nightly.

#### Scenario: Nightly detects a token change
- **WHEN** Microsoft starts rejecting the current token
- **THEN** the nightly workflow fails on the live contract test
