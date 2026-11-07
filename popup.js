'use strict';

/** URL schemes Chrome allows an extension to reopen. */
const RESTORABLE_PROTOCOLS = new Set(['http:', 'https:']);
const MAX_NAME_LENGTH = 100;
const STATUS_TIMEOUT_MS = 3000;
const DELETE_CONFIRM_TIMEOUT_MS = 3000;

const elements = {};

document.addEventListener('DOMContentLoaded', () => {
    elements.sessionName = document.getElementById('sessionName');
    elements.saveButton = document.getElementById('saveSession');
    elements.sessionsList = document.getElementById('sessionsList');
    elements.importButton = document.getElementById('importButton');
    elements.importFile = document.getElementById('importFile');
    elements.exportButton = document.getElementById('exportButton');
    elements.status = document.getElementById('status');

    setupEventListeners();
    renderSessions();
});

function setupEventListeners() {
    elements.saveButton.addEventListener('click', saveCurrentSession);
    elements.sessionName.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') saveCurrentSession();
    });
    elements.importButton.addEventListener('click', () => elements.importFile.click());
    elements.importFile.addEventListener('change', handleImport);
    elements.exportButton.addEventListener('click', exportSessions);
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

async function getSessions() {
    const { sessions } = await chrome.storage.local.get('sessions');
    return Array.isArray(sessions) ? sessions : [];
}

async function setSessions(sessions) {
    await chrome.storage.local.set({ sessions });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRestorableUrl(url) {
    if (typeof url !== 'string') return false;
    try {
        return RESTORABLE_PROTOCOLS.has(new URL(url).protocol);
    } catch {
        return false;
    }
}

function byNewestFirst(a, b) {
    return Date.parse(b.timestamp) - Date.parse(a.timestamp);
}

function showStatus(message, type = 'success') {
    elements.status.textContent = message;
    elements.status.className = `status status--${type}`;
    clearTimeout(showStatus.timer);
    showStatus.timer = setTimeout(() => {
        elements.status.textContent = '';
        elements.status.className = 'status';
    }, STATUS_TIMEOUT_MS);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

async function saveCurrentSession() {
    const name = elements.sessionName.value.trim();
    if (!name) {
        showStatus('Please enter a session name.', 'error');
        elements.sessionName.focus();
        return;
    }

    try {
        const tabs = await chrome.tabs.query({ currentWindow: true });
        const restorableTabs = tabs
            .filter((tab) => isRestorableUrl(tab.url))
            .map((tab) => ({ url: tab.url, title: tab.title || tab.url }));

        if (restorableTabs.length === 0) {
            showStatus('No saveable tabs in this window.', 'error');
            return;
        }

        const session = {
            id: crypto.randomUUID(),
            name: name.slice(0, MAX_NAME_LENGTH),
            timestamp: new Date().toISOString(),
            tabs: restorableTabs,
        };

        const sessions = await getSessions();
        sessions.unshift(session); // newest first
        await setSessions(sessions);

        elements.sessionName.value = '';
        const skipped = tabs.length - restorableTabs.length;
        showStatus(
            skipped > 0
                ? `Saved ${restorableTabs.length} tabs (${skipped} browser pages skipped).`
                : `Saved ${restorableTabs.length} tabs.`
        );
        renderSessions();
    } catch (error) {
        console.error('Failed to save session:', error);
        showStatus('Could not save session.', 'error');
    }
}

async function restoreSession(session) {
    const urls = session.tabs.map((tab) => tab.url).filter(isRestorableUrl);
    if (urls.length === 0) {
        showStatus('This session has no restorable tabs.', 'error');
        return;
    }

    // Create the window with all tabs in a single call. Focusing the new
    // window closes this popup, so no work may happen after this await.
    try {
        await chrome.windows.create({ url: urls, focused: true });
    } catch (error) {
        console.error('Failed to restore session:', error);
        showStatus('Could not restore session.', 'error');
    }
}

async function deleteSession(id) {
    try {
        const sessions = await getSessions();
        await setSessions(sessions.filter((session) => session.id !== id));
        showStatus('Session deleted.');
        renderSessions();
    } catch (error) {
        console.error('Failed to delete session:', error);
        showStatus('Could not delete session.', 'error');
    }
}

async function exportSessions() {
    const sessions = await getSessions();
    if (sessions.length === 0) {
        showStatus('No sessions to export.', 'error');
        return;
    }

    const blob = new Blob([JSON.stringify(sessions, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `tabtrack_sessions_${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    // Give the browser a moment to start the download before releasing it.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/**
 * Validates one imported session and returns a clean copy, or null if the
 * entry is unusable. Only http(s) URLs are kept.
 */
function sanitizeSession(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.name !== 'string' || !raw.name.trim()) return null;
    if (!Array.isArray(raw.tabs)) return null;

    const tabs = raw.tabs
        .filter((tab) => tab && isRestorableUrl(tab.url))
        .map((tab) => ({
            url: tab.url,
            title: typeof tab.title === 'string' ? tab.title : tab.url,
        }));
    if (tabs.length === 0) return null;

    const timestamp = Number.isNaN(Date.parse(raw.timestamp))
        ? new Date().toISOString()
        : new Date(raw.timestamp).toISOString();

    return {
        id: typeof raw.id === 'string' && raw.id ? raw.id : crypto.randomUUID(),
        name: raw.name.trim().slice(0, MAX_NAME_LENGTH),
        timestamp,
        tabs,
    };
}

function sessionKey(session) {
    return `${session.name}|${session.timestamp}`;
}

async function handleImport(event) {
    const file = event.target.files[0];
    event.target.value = ''; // allow re-importing the same file
    if (!file) return;

    let parsed;
    try {
        parsed = JSON.parse(await file.text());
    } catch {
        showStatus('Invalid file: not valid JSON.', 'error');
        return;
    }

    if (!Array.isArray(parsed)) {
        showStatus('Invalid file: expected a list of sessions.', 'error');
        return;
    }

    try {
        const current = await getSessions();
        const knownIds = new Set(current.map((s) => s.id));
        const knownKeys = new Set(current.map(sessionKey));

        let added = 0;
        let skipped = 0;
        for (const raw of parsed) {
            const session = sanitizeSession(raw);
            if (!session || knownKeys.has(sessionKey(session))) {
                skipped++;
                continue;
            }
            if (knownIds.has(session.id)) session.id = crypto.randomUUID();

            knownIds.add(session.id);
            knownKeys.add(sessionKey(session));
            current.push(session);
            added++;
        }

        current.sort(byNewestFirst);
        await setSessions(current);
        renderSessions();

        if (added === 0) {
            showStatus('No new sessions found in file.', 'error');
        } else {
            showStatus(
                skipped > 0
                    ? `Imported ${added} sessions (${skipped} skipped).`
                    : `Imported ${added} sessions.`
            );
        }
    } catch (error) {
        console.error('Failed to import sessions:', error);
        showStatus('Could not import sessions.', 'error');
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

async function renderSessions() {
    const sessions = await getSessions();
    elements.sessionsList.replaceChildren();

    if (sessions.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'empty-state';
        empty.textContent = 'No saved sessions yet.';
        elements.sessionsList.appendChild(empty);
        return;
    }

    for (const session of sessions) {
        elements.sessionsList.appendChild(createSessionElement(session));
    }
}

function createSessionElement(session) {
    const item = document.createElement('div');
    item.className = 'session-item';

    const name = document.createElement('span');
    name.className = 'session-name';
    name.textContent = session.name;
    name.title = session.name;

    const actions = document.createElement('div');
    actions.className = 'session-actions';

    const restoreButton = document.createElement('button');
    restoreButton.textContent = 'Restore';
    restoreButton.addEventListener('click', () => restoreSession(session));

    const deleteButton = document.createElement('button');
    deleteButton.textContent = 'Delete';
    deleteButton.className = 'delete-btn';
    deleteButton.addEventListener('click', () => handleDeleteClick(deleteButton, session.id));

    actions.append(restoreButton, deleteButton);
    item.append(name, actions);
    return item;
}

/** Two-step delete: the first click arms the button, the second confirms. */
function handleDeleteClick(button, id) {
    if (button.dataset.armed === 'true') {
        clearTimeout(Number(button.dataset.timer));
        deleteSession(id);
        return;
    }

    button.dataset.armed = 'true';
    button.textContent = 'Confirm?';
    button.dataset.timer = String(
        setTimeout(() => {
            button.dataset.armed = 'false';
            button.textContent = 'Delete';
        }, DELETE_CONFIRM_TIMEOUT_MS)
    );
}
