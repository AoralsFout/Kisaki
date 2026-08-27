# Changelog

All notable changes to Kisaki are documented in this file.

## Unreleased

### Security

- Stable builds disable the experimental AI shell command in both UI and Rust backend.
- Clarified external-service data flows and local data deletion behavior.
- Restricted the asset protocol to the application character directory and redacted common API-key/token shapes from persisted logs.

### Release engineering

- Added tests and completeness checks for updater manifests, including macOS payloads whose filenames do not contain an architecture.
- Added frontend tests, Rust tests, strict Clippy checks and dependency audits to CI.
- Defined the initial Stable/Preview platform support matrix.
- Added license-gated starter-character packaging, checksums, online release verification, RC acceptance and rollback procedures.

### User experience

- Development panels are hidden from production builds.
- Added no-charge API connectivity testing plus local-data backup, restore and reset controls.

## 0.2.3 - 2026-08-14

- Security hardening for workspace paths, SSRF controls and default-disabled command tools.
- Added signed updater artifacts and automated GitHub Release publishing.
