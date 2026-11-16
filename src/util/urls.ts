export type GitlabRef =
    | { kind: 'mr'; projectPath: string; iid: number; url: string }
    | { kind: 'pipeline'; projectPath: string; id: number; url: string }
    | { kind: 'job'; projectPath: string; id: number; url: string };

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Find every GitLab MR / pipeline / job URL for the given instance inside free text. */
export function extractGitlabRefs(text: string, gitlabUrl: string): GitlabRef[] {
    const host = escapeRe(gitlabUrl.replace(/\/+$/, ''));
    const re = new RegExp(
        `${host}/((?:[A-Za-z0-9_.-]+/)+[A-Za-z0-9_.-]+)/-/(merge_requests|pipelines|jobs)/(\\d+)(?![\\d])[^\\s)>\\]]*`,
        'g',
    );
    const seen = new Set<string>();
    const out: GitlabRef[] = [];
    for (const m of text.matchAll(re)) {
        const projectPath = m[1]!;
        const id = Number(m[3]);
        const key = `${m[2]}:${projectPath}:${id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const url = m[0].replace(/[.,;!?]+$/, '');
        if (m[2] === 'merge_requests') out.push({ kind: 'mr', projectPath, iid: id, url });
        else if (m[2] === 'pipelines') out.push({ kind: 'pipeline', projectPath, id, url });
        else out.push({ kind: 'job', projectPath, id, url });
    }
    return out;
}

/** Parse a single URL (or `group/project!123` shorthand) into a ref. */
export function parseRefInput(input: string, gitlabUrl: string): GitlabRef | null {
    const refs = extractGitlabRefs(input, gitlabUrl);
    if (refs[0]) return refs[0];
    const short = /^((?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.-]+)!(\d+)$/.exec(input.trim());
    if (short) {
        const projectPath = short[1]!;
        const iid = Number(short[2]);
        return { kind: 'mr', projectPath, iid, url: `${gitlabUrl}/${projectPath}/-/merge_requests/${iid}` };
    }
    return null;
}
