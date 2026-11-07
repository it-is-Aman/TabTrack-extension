import { describe, expect, it } from 'vitest';
import { UserFacingError } from '../src/lib/errors.js';
import {
    matchesQuery,
    mergeImportedSessions,
    migrateSessions,
    parseSessionsFile,
    sanitizeSession,
} from '../src/lib/sessions.js';

const tab = (url, extra = {}) => ({ url, title: url, ...extra });

describe('sanitizeSession', () => {
    it('keeps a valid session and trims the name', () => {
        const result = sanitizeSession({
            id: 'abc',
            name: '  Work  ',
            timestamp: '2026-01-01T10:00:00.000Z',
            tabs: [tab('https://a.com')],
        });
        expect(result).toEqual({
            id: 'abc',
            name: 'Work',
            timestamp: '2026-01-01T10:00:00.000Z',
            tabs: [tab('https://a.com')],
        });
    });

    it.each([null, 5, 'x', {}, { name: '', tabs: [] }, { name: 'x' }, { name: 'x', tabs: 'nope' }])(
        'rejects malformed input %j',
        (raw) => {
            expect(sanitizeSession(raw)).toBeNull();
        }
    );

    it('drops unsafe URLs and rejects sessions left with no tabs', () => {
        const raw = { name: 'x', tabs: [tab('javascript:alert(1)'), tab('chrome://settings')] };
        expect(sanitizeSession(raw)).toBeNull();
    });

    it('generates an id and timestamp when missing or invalid', () => {
        const result = sanitizeSession({ name: 'x', timestamp: 'garbage', tabs: [tab('https://a.com')] });
        expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
        expect(Number.isNaN(Date.parse(result.timestamp))).toBe(false);
    });

    it('caps very long names', () => {
        const result = sanitizeSession({ name: 'a'.repeat(500), tabs: [tab('https://a.com')] });
        expect(result.name).toHaveLength(100);
    });

    it('keeps pinned state and valid groups, dropping invalid or unused ones', () => {
        const result = sanitizeSession({
            name: 'x',
            tabs: [
                tab('https://a.com', { pinned: true }),
                tab('https://b.com', { groupId: 0 }),
                tab('https://c.com', { groupId: 7 }), // unknown group
            ],
            groups: [
                { id: 0, title: 'Docs', color: 'blue', collapsed: 1 },
                { id: 1, title: 'Unused', color: 'red' },
                { id: 2, title: 'Bad colour', color: 'rainbow' },
            ],
        });
        expect(result.tabs).toEqual([
            tab('https://a.com', { pinned: true }),
            tab('https://b.com', { groupId: 0 }),
            tab('https://c.com'),
        ]);
        expect(result.groups).toEqual([{ id: 0, title: 'Docs', color: 'blue', collapsed: true }]);
    });

    it('does not copy unknown properties', () => {
        const result = sanitizeSession({
            name: 'x',
            evil: true,
            tabs: [{ url: 'https://a.com', title: 't', onclick: 'x' }],
        });
        expect(result).not.toHaveProperty('evil');
        expect(result.tabs[0]).toEqual({ url: 'https://a.com', title: 't' });
    });
});

describe('parseSessionsFile', () => {
    it('parses a JSON array', () => {
        expect(parseSessionsFile('[{"name":"x"}]')).toEqual([{ name: 'x' }]);
    });

    it('throws a user-facing error for invalid JSON', () => {
        expect(() => parseSessionsFile('{oops')).toThrow(UserFacingError);
    });

    it('throws a user-facing error when the root is not an array', () => {
        expect(() => parseSessionsFile('{"name":"x"}')).toThrow('expected a list of sessions');
    });
});

describe('mergeImportedSessions', () => {
    const existing = {
        id: 'one',
        name: 'Existing',
        timestamp: '2026-01-02T00:00:00.000Z',
        tabs: [tab('https://a.com')],
    };

    it('adds new sessions sorted newest first', () => {
        const imported = [
            { name: 'Older', timestamp: '2025-12-01T00:00:00.000Z', tabs: [tab('https://b.com')] },
            { name: 'Newer', timestamp: '2026-02-01T00:00:00.000Z', tabs: [tab('https://c.com')] },
        ];
        const { sessions, added, skipped } = mergeImportedSessions([existing], imported);
        expect(added).toBe(2);
        expect(skipped).toBe(0);
        expect(sessions.map((s) => s.name)).toEqual(['Newer', 'Existing', 'Older']);
    });

    it('skips duplicates and invalid entries', () => {
        const imported = [{ ...existing }, { name: 'bad' }, 'junk'];
        const { sessions, added, skipped } = mergeImportedSessions([existing], imported);
        expect(added).toBe(0);
        expect(skipped).toBe(3);
        expect(sessions).toHaveLength(1);
    });

    it('re-ids sessions whose id collides with an existing one', () => {
        const imported = [{ ...existing, name: 'Different', timestamp: '2026-03-01T00:00:00.000Z' }];
        const { sessions } = mergeImportedSessions([existing], imported);
        expect(new Set(sessions.map((s) => s.id)).size).toBe(2);
    });

    it('does not mutate the current list', () => {
        const current = [existing];
        mergeImportedSessions(current, [{ name: 'New', tabs: [tab('https://z.com')] }]);
        expect(current).toHaveLength(1);
    });
});

describe('migrateSessions', () => {
    it('adds missing ids, keeps existing ones and sorts newest first', () => {
        const result = migrateSessions([
            { name: 'old', timestamp: '2025-01-01T00:00:00.000Z', tabs: [] },
            { id: 'keep', name: 'new', timestamp: '2026-01-01T00:00:00.000Z', tabs: [] },
        ]);
        expect(result.map((s) => s.name)).toEqual(['new', 'old']);
        expect(result[0].id).toBe('keep');
        expect(result[1].id).toEqual(expect.any(String));
    });

    it('handles missing data', () => {
        expect(migrateSessions(undefined)).toEqual([]);
    });
});

describe('matchesQuery', () => {
    const session = {
        name: 'Research',
        tabs: [{ url: 'https://developer.chrome.com/docs', title: 'Chrome Docs' }],
    };

    it.each(['', '  ', 'research', 'CHROME DOCS', 'developer.chrome'])('matches %j', (query) => {
        expect(matchesQuery(session, query)).toBe(true);
    });

    it('returns false when nothing matches', () => {
        expect(matchesQuery(session, 'shopping')).toBe(false);
    });
});
