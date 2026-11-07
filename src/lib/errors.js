/** An error whose message is safe to show to the user as-is. */
export class UserFacingError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UserFacingError';
    }
}
