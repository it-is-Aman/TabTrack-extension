# Changelog

All notable changes to TabTrack are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
and the project uses [Semantic Versioning](https://semver.org/).

## [1.3.0] - 2026-11-08

### Added
- Pinned tabs and tab groups (title, colour, collapsed state) are saved and restored.
- Lazy restore: background tabs load only when you open them (can be turned off).
- Auto-save of all windows every 5 minutes and shortly after tab changes, with a
  "Previous browser session" banner for crash recovery.
- `Alt+Shift+S` keyboard shortcut to quick-save the current window.

### Changed
- Capturing and restoring now run in the background service worker.
- Codebase split into ES modules with a unit-test suite, linting and CI.

## [1.2.0] - 2026-11-08

### Added
- Tab count and saved date for every session.
- Expandable tab list; open any single tab from a session.
- Rename sessions and update a session with the current window's tabs.
- Search by session name, tab title or URL.

## [1.1.0] - 2026-11-08

### Fixed
- Restoring a large session could stop part-way because the popup closed.
- Browser-internal pages (`chrome://`, `about:`) were saved but could not be restored.
- Importing an invalid file could fail silently or add unsafe URLs.

### Changed
- New sessions appear at the top of the list.
- Delete asks for confirmation; inline status messages replace pop-up alerts.
- Removed the `downloads` permission.

## [1.0.0]

- Initial release: save, restore, delete, import and export tab sessions.
