# Security Policy

## Supported versions

Only the latest Stable release receives security fixes. Preview builds are supported on a best-effort basis.

## Reporting a vulnerability

Please use the repository's private GitHub Security Advisory reporting flow. Do not open a public issue for an unpatched vulnerability and do not include API keys, private prompts, local files, or exported logs in a public report.

Include the affected version and platform, impact, minimal reproduction steps, and whether the issue requires the experimental command feature. The maintainer will acknowledge the report, assess severity, and coordinate disclosure after a fix is available.

## Security boundaries

- Stable release builds disable the experimental AI shell command feature.
- File tools require a user-selected workspace and reject traversal and link escapes.
- API credentials prefer the operating-system keychain.
- Updater artifacts must be signed and are verified before installation.

