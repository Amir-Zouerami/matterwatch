export function formatDuration(totalSeconds: number | null | undefined): string {
    if (totalSeconds === null || totalSeconds === undefined || !Number.isFinite(totalSeconds)) return '—';
    const s = Math.max(0, Math.round(totalSeconds));
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    if (m < 60) return `${m}m ${s % 60}s`;
    const h = Math.floor(m / 60);
    return `${h}h ${m % 60}m`;
}

export function relativeTime(from: Date, now: Date = new Date()): string {
    const sec = Math.round((now.getTime() - from.getTime()) / 1000);
    if (sec < 45) return 'just now';
    if (sec < 90) return '1 min ago';
    const min = Math.round(sec / 60);
    if (min < 60) return `${min} min ago`;
    const h = Math.round(min / 60);
    if (h < 24) return `${h}h ago`;
    const d = Math.round(h / 24);
    return `${d}d ago`;
}

/** GitLab sends `2026-11-14 07:07:34 UTC` or ISO strings; normalise both. */
export function parseGitlabDate(s: string | null | undefined): Date | null {
    if (!s) return null;
    const norm = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} (UTC|[+-]\d{4})$/.test(s)
        ? s.replace(' UTC', 'Z').replace(' ', 'T').replace(/ ([+-]\d{2})(\d{2})$/, '$1:$2')
        : s;
    const d = new Date(norm.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2})Z$/, '$1T$2Z'));
    return Number.isNaN(d.getTime()) ? null : d;
}

export function formatLocal(d: Date | null, tz: string, jalali: boolean): string {
    if (!d) return '—';
    const date = new Intl.DateTimeFormat(jalali ? 'fa-IR-u-ca-persian-nu-latn' : 'en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).format(d);
    const time = new Intl.DateTimeFormat('en-GB', {
        timeZone: tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(d);
    return `${date.replace(/\//g, '-')} ${time}`;
}

/** Hour (0-23) and ISO weekday-independent day key in the given timezone. */
export function localParts(d: Date, tz: string): { hour: number; minute: number; day: string; weekday: number } {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: tz,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
        weekday: 'short',
    }).formatToParts(d);
    const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
    const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(g('weekday'));
    return {
        hour: Number(g('hour')) % 24,
        minute: Number(g('minute')),
        day: `${g('year')}-${g('month')}-${g('day')}`,
        weekday: wd,
    };
}

/** True when `hour` lies in [start, end) wrapping past midnight (e.g. 23 → 8). */
export function inQuietHours(hour: number, start: number, end: number): boolean {
    if (start === end) return false;
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

/** Next instant (UTC Date) at which the local clock in `tz` reads `hour:00`, strictly after `from`. */
export function nextLocalHour(from: Date, hour: number, tz: string): Date {
    // Scan forward in 15 minute steps for at most 26 hours; robust for any tz without offset maths.
    const step = 15 * 60 * 1000;
    let t = new Date(Math.floor(from.getTime() / step) * step + step);
    for (let i = 0; i < 26 * 4 + 1; i++) {
        const p = localParts(t, tz);
        if (p.hour === hour && p.minute === 0) return t;
        t = new Date(t.getTime() + step);
    }
    return new Date(from.getTime() + 60 * 60 * 1000);
}
