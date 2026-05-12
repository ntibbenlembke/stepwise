# Changelog

All notable changes to Stepwise will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Gallery banner and VS Code Marketplace branding
- Extension keywords for improved discoverability
- GitHub Actions CI pipeline with typecheck, Jest, and pytest
- LSP request handler tests
- Informational log when the repository has no step definitions

### Changed
- License updated to Apache 2.0
- Version string injected at build time rather than hard-coded
- `re.compile` patterns in completion item labels are now prettified for readability

### Fixed
- Missing `extensionPath` logging when the Python server starts

## [0.3.0] - 2026-05-11

### Changed
- Replaced extension icon with a vibrant, cucumber-themed design
- Added a dedicated cucumber icon for `.feature` files in the file explorer

## [0.2.0] - 2026-04-28

### Added
- Extension icon

### Fixed
- Stateful `g`-flag regex in step matching caused intermittent false negatives on repeated calls; replaced with non-global equivalent ([#1](https://github.com/ntibbenlembke/stepwise/issues/1))

## [0.1.0] - 2026-04-27

### Added
- LSP diagnostics: unresolved Gherkin steps are underlined with a warning
- Go-to-definition: jump from a step in a `.feature` file to its Python step definition
- Completion: step suggestions based on registered pytest-bdd definitions
- Gherkin document formatter with configurable indentation (registered as VS Code formatter for `.feature` files)
- Scenario Outline placeholder matching
- Keyword highlighting for `Given`, `When`, `Then`, `And`, `But`
- Regex caching in step matcher for improved performance
- User configuration via `stepwise.*` VS Code settings

### Fixed
- Formatter not recognized in marketplace installs: bundled server dependencies with esbuild so the extension is fully self-contained ([#2](https://github.com/ntibbenlembke/stepwise/issues/2))

[Unreleased]: https://github.com/ntibbenlembke/stepwise/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/ntibbenlembke/stepwise/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/ntibbenlembke/stepwise/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/ntibbenlembke/stepwise/releases/tag/v0.1.0
