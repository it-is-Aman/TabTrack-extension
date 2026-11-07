/**
 * Pure session logic: validation, import merging, migration and search.
 * Nothing here touches chrome.* APIs, so it is fully unit-testable.
 */
import { MAX_NAME_LENGTH, TAB_GROUP_COLORS } from './constants.js';
import { UserFacingError } from './errors.js';
import { isRestorableUrl } from './urls.js';

export function byNewestFirst(a, b) {
    return Date.parse(b.timestamp) - Date.parse(a.timestamp);
}

function sanitizeGroups(rawGroups) {
    if (!Array.isArray(rawGroups)) return [];
    return rawGroups
        .filter((group) => group && Number.isInteger(group.id) && TAB_GROUP_COLORS.has(group.color))
        .map((group) => ({
            id: group.id,
            title: typeof group.title === 'string' ? group.title : '',
            color: group.color,
            collapsed: Boolean(group.collapsed),
        }));
}

/**
 * Validates one untrusted session (e.g. from an imported file) and returns a
 * clean copy, or null if the entry is unusable. Only http(s) tabs are kept,
 * and only groups that still contain a tab survive.
 */
export function sanitizeSession(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.name !== 'string' || !raw.name.trim()) return null;
    if (!Array.isArray(raw.tabs)) return null;

    const groups = sanitizeGroups(raw.groups);
    const groupIds = new Set(groups.map((group) => group.id));

    const tabs = raw.tabs
        .filter((tab) => tab && isRestorableUrl(tab.url))
        .map((tab) => {
            const clean = {
                url: tab.url,
                title: typeof tab.title === 'string' ? tab.title : tab.url,
            };
            if (tab.pinned === true) clean.pinned = true;
            if (groupIds.has(tab.groupId)) clean.groupId = tab.groupId;
            return clean;
        });
    if (tabs.length === 0) return null;

    const timestamp = Number.isNaN(Date.parse(raw.timestamp))
        ? new Date().toISOString()
        : new Date(raw.timestamp).toISOString();

    const session = {
        id: typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID(),
        name: raw.name.trim().slice(0, MAX_NAME_LENGTH),
        timestamp,
        tabs,
    };
    const usedGroups = groups.filter((group) => tabs.some((tab) => tab.groupId === group.id));
    if (usedGroups.length > 0) session.groups = usedGroups;
    return session;
}

/** Two sessions with the same name and save time are treated as duplicates. */
export function sessionKey(session) {
    return `${session.name}|${session.timestamp}`;
}

/** Parses the text of an export file. Throws UserFacingError if invalid. */
export function parseSessionsFile(text) {
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        throw new UserFacingError('Invalid file: not valid JSON.');
    }
    if (!Array.isArray(parsed)) {
        throw new UserFacingError('Invalid file: expected a list of sessions.');
    }
    return parsed;
}

/**
 * Merges untrusted imported sessions into the current list. Invalid entries
 * and duplicates are skipped; id collisions get a fresh id.
 *
 * @returns {{ sessions: object[], added: number, skipped: number }}
 */
export function mergeImportedSessions(current, imported) {
    const sessions = [...current];
    const knownIds = new Set(sessions.map((s) => s.id));
    const knownKeys = new Set(sessions.map(sessionKey));

    let added = 0;
    let skipped = 0;
    for (const raw of imported) {
        const session = sanitizeSession(raw);
        if (!session || knownKeys.has(sessionKey(session))) {
            skipped++;
            continue;
        }
        if (knownIds.has(session.id)) session.id = crypto.randomUUID();

        knownIds.add(session.id);
        knownKeys.add(sessionKey(session));
        sessions.push(session);
        added++;
    }

    sessions.sort(byNewestFirst);
    return { sessions, added, skipped };
}

/** Upgrades schema v1 data: adds ids and orders sessions newest-first. */
export function migrateSessions(sessions) {
    return (Array.isArray(sessions) ? sessions : [])
        .map((session) => ({ ...session, id: session.id || crypto.randomUUID() }))
        .sort(byNewestFirst);
}

/** Case-insensitive match against session name, tab titles and URLs. */
export function matchesQuery(session, query) {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    const haystack = [session.name, ...session.tabs.flatMap((tab) => [tab.title, tab.url])];
    return haystack.some((text) => String(text).toLowerCase().includes(needle));
}
