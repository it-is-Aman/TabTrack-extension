import { vi } from 'vitest';

/** In-memory implementation of chrome.storage.local (promise API). */
function createStorageArea(initial = {}) {
    let data = structuredClone(initial);
    const pick = (keys) => {
        if (keys == null) return structuredClone(data);
        const list = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(
            list.filter((key) => key in data).map((key) => [key, structuredClone(data[key])])
        );
    };
    return {
        get: vi.fn(async (keys) => pick(keys)),
        set: vi.fn(async (items) => {
            data = { ...data, ...structuredClone(items) };
        }),
        remove: vi.fn(async (keys) => {
            for (const key of [keys].flat()) delete data[key];
        }),
        _dump: () => structuredClone(data),
    };
}

function createEvent() {
    const listeners = new Set();
    return {
        addListener: vi.fn((fn) => listeners.add(fn)),
        removeListener: vi.fn((fn) => listeners.delete(fn)),
        _emit: (...args) => listeners.forEach((fn) => fn(...args)),
    };
}

/** Installs a fresh `globalThis.chrome` mock and returns it. */
export function installChromeMock({ storage = {} } = {}) {
    const chrome = {
        storage: { local: createStorageArea(storage) },
        tabs: {
            query: vi.fn(async () => []),
            get: vi.fn(async (id) => ({ id, url: 'https://example.com/', active: false })),
            update: vi.fn(async () => ({})),
            group: vi.fn(async () => 100),
            discard: vi.fn(async () => ({})),
            create: vi.fn(async () => ({})),
            onUpdated: createEvent(),
        },
        tabGroups: {
            TAB_GROUP_ID_NONE: -1,
            get: vi.fn(),
            update: vi.fn(async () => ({})),
        },
        windows: {
            create: vi.fn(async ({ url }) => ({
                id: 1,
                tabs: url.map((_, i) => ({ id: 10 + i })),
            })),
        },
    };
    globalThis.chrome = chrome;
    return chrome;
}
