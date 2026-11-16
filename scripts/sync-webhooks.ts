/**
 * Register (or update) the GitLab webhook on every project of a group.
 *
 *   GITLAB_URL=https://gitlab.example.com GITLAB_TOKEN=glpat-... GITLAB_WEBHOOK_SECRET=... \
 *   HOOK_URL=https://matterwatch.example.com/hooks/gitlab \
 *   node scripts/sync-webhooks.ts my-group [--dry-run]
 *
 * The token needs the `api` scope and Maintainer rights on the projects.
 */
import { GitlabClient } from '../src/gitlab/client.ts';

const group = process.argv[2];
const dry = process.argv.includes('--dry-run');
const { GITLAB_URL = 'https://gitlab.com', GITLAB_TOKEN, GITLAB_WEBHOOK_SECRET, HOOK_URL } = process.env;

if (!group || !GITLAB_TOKEN || !GITLAB_WEBHOOK_SECRET || !HOOK_URL) {
    console.error('Usage: node scripts/sync-webhooks.ts <group> [--dry-run]  (needs GITLAB_TOKEN, GITLAB_WEBHOOK_SECRET, HOOK_URL)');
    process.exit(1);
}

const gl = new GitlabClient(GITLAB_URL.replace(/\/+$/, ''), GITLAB_TOKEN);
const hook = {
    url: HOOK_URL,
    token: GITLAB_WEBHOOK_SECRET,
    push_events: true,
    tag_push_events: true,
    merge_requests_events: true,
    pipeline_events: true,
    note_events: true,
    issues_events: true,
    deployment_events: true,
    releases_events: true,
    job_events: false,
    wiki_page_events: false,
    enable_ssl_verification: true,
};

const projects = await gl.listGroupProjects(group);
console.log(`${projects.length} projects in ${group}${dry ? ' (dry run)' : ''}`);
for (const p of projects) {
    try {
        const existing = (await gl.listProjectHooks(p.id)).find((h) => h.url === HOOK_URL);
        if (dry) console.log(`${existing ? 'would update' : 'would create'}  ${p.path_with_namespace}`);
        else if (existing) {
            await gl.updateProjectHook(p.id, existing.id, hook);
            console.log(`updated  ${p.path_with_namespace}`);
        } else {
            await gl.addProjectHook(p.id, hook);
            console.log(`created  ${p.path_with_namespace}`);
        }
    } catch (e) {
        console.error(`FAILED   ${p.path_with_namespace}: ${(e as Error).message}`);
    }
}
