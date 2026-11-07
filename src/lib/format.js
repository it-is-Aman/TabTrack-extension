export function pluralize(count, word) {
    return `${count} ${word}${count === 1 ? '' : 's'}`;
}
