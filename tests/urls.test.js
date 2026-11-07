import { describe, expect, it } from 'vitest';
import { isRestorableUrl } from '../src/lib/urls.js';

describe('isRestorableUrl', () => {
    it.each(['https://example.com', 'http://localhost:3000/path?q=1'])('accepts %s', (url) => {
        expect(isRestorableUrl(url)).toBe(true);
    });

    it.each([
        'chrome://settings',
        'chrome-extension://abc/popup.html',
        'about:blank',
        'file:///etc/passwd',
        'javascript:alert(1)',
        'not a url',
        '',
        null,
        undefined,
        42,
    ])('rejects %s', (url) => {
        expect(isRestorableUrl(url)).toBe(false);
    });
});
