/** Thin promise-based wrapper around chrome.storage.local. */
import { DEFAULT_SETTINGS, STORAGE_KEYS } from './constants.js';

export async function getSessions() {
    const { [STORAGE_KEYS.sessions]: sessions } = await chrome.storage.local.get(STORAGE_KEYS.sessions);
    return Array.isArray(sessions) ? sessions : [];
}

export async function setSessions(sessions) {
    await chrome.storage.local.set({ [STORAGE_KEYS.sessions]: sessions });
}

/** Adds a session at the top of the list (newest first). */
export async function addSession(session) {
    const sessions = await getSessions();
    sessions.unshift(session);
    await setSessions(sessions);
}

export async function findSession(id) {
    return (await getSessions()).find((session) => session.id === id);
}

/** Applies `changes` to the session with the given id and persists it. */
export async function updateSession(id, changes) {
    const sessions = await getSessions();
    const session = sessions.find((s) => s.id === id);
    if (!session) throw new Error(`Session ${id} not found`);
    Object.assign(session, changes);
    await setSessions(sessions);
}

export async function deleteSession(id) {
    const sessions = await getSessions();
    await setSessions(sessions.filter((session) => session.id !== id));
}

export async function getSettings() {
    const { [STORAGE_KEYS.settings]: settings } = await chrome.storage.local.get(STORAGE_KEYS.settings);
    return { ...DEFAULT_SETTINGS, ...settings };
}

export async function saveSettings(changes) {
    const settings = await getSettings();
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: { ...settings, ...changes } });
}
