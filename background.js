'use strict';

/**
 * Storage schema versions:
 *   1 - sessions stored oldest-first, no ids
 *   2 - every session has a unique `id`; sessions stored newest-first
 */
const SCHEMA_VERSION = 2;

// Runs on first install and on every extension update.
chrome.runtime.onInstalled.addListener(async () => {
    try {
        await migrateStorage();
    } catch (error) {
        console.error('TabTrack storage migration failed:', error);
    }
});

async function migrateStorage() {
    const { sessions, schemaVersion = 1 } = await chrome.storage.local.get([
        'sessions',
        'schemaVersion',
    ]);

    if (schemaVersion >= SCHEMA_VERSION && Array.isArray(sessions)) return;

    const migrated = (Array.isArray(sessions) ? sessions : [])
        .map((session) => ({
            ...session,
            id: session.id || crypto.randomUUID(),
        }))
        .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

    await chrome.storage.local.set({ sessions: migrated, schemaVersion: SCHEMA_VERSION });
}
