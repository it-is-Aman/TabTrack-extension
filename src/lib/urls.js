import { RESTORABLE_PROTOCOLS } from './constants.js';

/** True for URLs an extension can reopen (http/https only). */
export function isRestorableUrl(url) {
    if (typeof url !== 'string') return false;
    try {
        return RESTORABLE_PROTOCOLS.has(new URL(url).protocol);
    } catch {
        return false;
    }
}
