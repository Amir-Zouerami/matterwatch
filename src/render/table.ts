import { defang, mdCell } from '../util/text.ts';

/**
 * Two-column key/value table. Markdown tables need a header row; an empty one renders as a collapsed
 * blank line in Mattermost, so the first real row doubles as the header.
 */
export function kvTable(rows: [string, string | null | undefined][]): string {
    const lines = rows
        .filter(([, v]) => v !== null && v !== undefined && v !== '')
        .map(([k, v]) => `| **${k}** | ${mdCell(String(v))} |`);
    if (lines.length === 0) return '';
    return [lines[0]!, '|:--|:--|', ...lines.slice(1)].join('\n');
}

export function table(headers: string[], rows: string[][]): string {
    if (rows.length === 0) return '';
    return [
        `| ${headers.join(' | ')} |`,
        `|${headers.map(() => ':--').join('|')}|`,
        ...rows.map((r) => `| ${r.map(mdCell).join(' | ')} |`),
    ].join('\n');
}

export const code = (s: string): string => '`' + s.replace(/`/g, "'") + '`';
export const link = (text: string, url: string): string => `[${defang(text).replace(/[[\]]/g, '')}](${url})`;
