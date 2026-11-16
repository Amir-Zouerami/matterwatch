import { GitlabError } from '../gitlab/client.ts';
import { MattermostError } from '../mattermost/client.ts';

/** HTTP statuses that will not fix themselves by trying again (refused, gone, invalid). 401/408/429/5xx stay retryable. */
const PERMANENT = new Set([400, 403, 404, 405, 410, 422]);

export function isPermanent(e: unknown): boolean {
    return (e instanceof MattermostError || e instanceof GitlabError) && PERMANENT.has(e.status);
}
