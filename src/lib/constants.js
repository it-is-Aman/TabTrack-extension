/** URL schemes Chrome allows an extension to reopen. */
export const RESTORABLE_PROTOCOLS = new Set(['http:', 'https:']);

export const MAX_NAME_LENGTH = 100;

/** Colours accepted by chrome.tabGroups.update(). */
export const TAB_GROUP_COLORS = new Set([
    'grey', 'blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange',
]);

export const DEFAULT_SETTINGS = Object.freeze({ lazyRestore: true });

/**
 * Storage schema versions:
 *   1 - sessions stored oldest-first, no ids
 *   2 - every session has a unique `id`; sessions stored newest-first.
 *       Tabs may carry `pinned` and `groupId`; sessions may carry `groups`.
 */
export const SCHEMA_VERSION = 2;

/** Keys used in chrome.storage.local. */
export const STORAGE_KEYS = Object.freeze({
    sessions: 'sessions',
    schemaVersion: 'schemaVersion',
    settings: 'settings',
    autosave: 'autosave',
    recovery: 'recovery',
});
