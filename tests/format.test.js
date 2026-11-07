import { expect, it } from 'vitest';
import { pluralize } from '../src/lib/format.js';

it.each([
    [0, '0 tabs'],
    [1, '1 tab'],
    [2, '2 tabs'],
])('pluralize(%i, "tab") → %s', (count, expected) => {
    expect(pluralize(count, 'tab')).toBe(expected);
});
