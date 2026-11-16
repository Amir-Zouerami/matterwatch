// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007|\r(?!\n)/g;

export function stripAnsi(s: string): string {
    return s.replace(ANSI, '');
}

/** GitLab section markers: `section_start:1700000000:name[collapsed=true]\r\e[0K` */
export function stripSectionMarkers(s: string): string {
    return s.replace(/section_(?:start|end):\d+:[^\r\n]*/g, '');
}

export function tailLines(text: string, n: number): string {
    const lines = text.replace(/\s+$/, '').split('\n');
    return lines.slice(-n).join('\n');
}

const SECRET_PATTERNS: RegExp[] = [
    /glpat-[A-Za-z0-9_-]{16,}/g,
    /glptt-[A-Za-z0-9_-]{16,}/g,
    /gldt-[A-Za-z0-9_-]{16,}/g,
    /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
    /\bAKIA[0-9A-Z]{16}\b/g,
    /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    /(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi,
    /(\/\/[^\s:@/]+:)[^\s@/]+(@)/g, // user:pass@host in URLs
];

const KV_SECRET = /\b([A-Za-z0-9_.-]*(?:password|passwd|secret|token|api[_-]?key|private[_-]?key|credential|auth)[A-Za-z0-9_.-]*)(\s*[:=]\s*)(["']?)([^\s"']{3,})\3/gi;

export function maskSecrets(text: string, literals: string[] = []): string {
    let out = text;
    for (const lit of literals) {
        if (lit.length >= 6) out = out.split(lit).join('••••');
    }
    for (const re of SECRET_PATTERNS) {
        out = out.replace(re, (m, a?: string, b?: string) => {
            if (m.startsWith('//') && a && b) return `${a}••••${b}`;
            if (/^(Bearer|Basic)\s/i.test(m)) return m.replace(/\s+.+$/, ' ••••');
            return '••••';
        });
    }
    return out.replace(KV_SECRET, (_m, k: string, sep: string, q: string) => `${k}${sep}${q}••••${q}`);
}

export interface ParsedTitle {
    type: string | null;
    scope: string | null;
    breaking: boolean;
    subject: string;
}

const CC = /^(\w+)(?:\(([^)]+)\))?(!)?:\s+(.+)$/s;

export function parseConventionalTitle(title: string): ParsedTitle {
    const m = CC.exec(title.trim());
    if (!m) return { type: null, scope: null, breaking: false, subject: title.trim() };
    return { type: m[1]!.toLowerCase(), scope: m[2] ?? null, breaking: m[3] === '!', subject: m[4]!.trim() };
}

const TYPE_EMOJI: Record<string, string> = {
    feat: '✨',
    fix: '🐛',
    docs: '📝',
    style: '🎨',
    refactor: '♻️',
    perf: '⚡',
    test: '🧪',
    build: '📦',
    ci: '🤖',
    chore: '🔧',
    revert: '⏪',
    release: '🚀',
    hotfix: '🔥',
};

export function typeEmoji(type: string | null): string {
    return (type && TYPE_EMOJI[type]) || '🔀';
}

/** Remove trailer noise such as Co-Authored-By / Signed-off-by / Reviewed-by lines. */
export function cleanMessageBody(msg: string): string {
    return msg
        .split('\n')
        .filter((l) => !/^(co-authored-by|signed-off-by|reviewed-by|change-id):/i.test(l.trim()))
        .filter((l) => !/^🤖 Generated with/i.test(l.trim()))
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function firstLine(s: string): string {
    return (s.split('\n')[0] ?? '').trim();
}

export function truncate(s: string, max: number): string {
    return s.length <= max ? s : s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
}

/** Escape characters that would break a markdown table cell or trigger mentions. */
export function mdCell(s: string): string {
    return s.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

export function shortSha(sha: string): string {
    return sha.slice(0, 8);
}

export function pluralize(n: number, one: string, many = one + 's'): string {
    return `${n} ${n === 1 ? one : many}`;
}

/**
 * Neutralise @mentions in text we did not write (titles, comments, display names) so a GitLab user can't make the
 * bot ping @channel / @here / arbitrary people. Our own intentional mentions never go through this.
 */
export function defang(s: string): string {
    return s.replace(/@(?=[\w.-])/g, '@\u200b');
}
