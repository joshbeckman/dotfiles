# Changelog

Notable user-facing changes to pana, newest first. Dates record changes in the
repository, not deployment to a particular machine. This log starts on
2026-10-29; earlier history remains in Git. Pana does not yet publish versioned
releases.

## Unreleased

## 2026-10-29

### Added

- Filter the web sessions list by state.

### Changed

- Render machine identifiers in monospace and disambiguate similar font glyphs.
- Keep session provenance on pull requests and other prose writes, rather than
  requiring attribution on project commits. Native Git hooks remain in control;
  there is no mandatory `pana git commit` command.
- Allow explicitly requested fast-forward checkout updates with unrelated local
  changes, while checking for overlapping paths and preserving local work.

### Fixed

- Join notice recipients to existing threads so delivered notices appear in
  their inbox and archived-thread views ([#114](https://github.com/joshbeckman/dotfiles/pull/114)).
- Encode Unicode attachment filenames safely in HTTP headers
  ([#110](https://github.com/joshbeckman/dotfiles/pull/110)).
