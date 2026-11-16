import { z } from 'zod';

const bool = (def: boolean) =>
    z
        .enum(['true', 'false', '1', '0', 'yes', 'no', ''])
        .default(def ? 'true' : 'false')
        .transform((v) => v === 'true' || v === '1' || v === 'yes');

const csv = (def: string) =>
    z
        .string()
        .default(def)
        .transform((v) =>
            v
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean),
        );

const schema = z.object({
    PORT: z.coerce.number().int().default(3000),
    LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
    TZ_NAME: z.string().default('UTC'),
    DB_PATH: z.string().default('./data/service.sqlite'),

    // URL Mattermost uses to call back into this service (buttons, slash command).
    SERVICE_URL: z.string().url().default('http://localhost:3000'),

    // GitLab
    GITLAB_URL: z.string().url().default('https://gitlab.com'),
    GITLAB_TOKEN: z.string().default(''),
    GITLAB_WEBHOOK_SECRET: z.string().default(''),

    // Mattermost
    // Use an address Matterwatch can reach directly (e.g. the Docker service name), not necessarily the public one.
    MM_URL: z.string().url().default('http://localhost:8065'),
    MM_TOKEN: z.string().default(''),
    MM_TEAM_NAME: z.string().default(''),
    MM_UPDATES_CHANNEL_ID: z.string().default(''),
    MM_WATCH_CHANNEL_IDS: csv(''),
    MM_SLASH_TRIGGER: z.string().default('gl'),
    MM_SLASH_TOKEN: z.string().default(''),
    // Secret used to sign button callbacks. Falls back to the webhook secret.
    ACTION_SIGNING_SECRET: z.string().default(''),

    ADMIN_TOKEN: z.string().default(''),
    METRICS_TOKEN: z.string().default(''),

    // Behaviour
    FAILURE_LOG_LINES: z.coerce.number().int().min(5).max(200).default(40),
    FAILURE_LOG_MAX_JOBS: z.coerce.number().int().min(1).max(10).default(3),
    WATCH_TTL_HOURS: z.coerce.number().int().min(1).default(72),
    POLL_INTERVAL_SECONDS: z.coerce.number().int().min(10).default(45),
    QUIET_HOURS_START: z.coerce.number().int().min(0).max(23).default(23),
    QUIET_HOURS_END: z.coerce.number().int().min(0).max(23).default(8),
    DIGEST_HOUR: z.coerce.number().int().min(0).max(23).default(9),
    STALE_MR_HOURS: z.coerce.number().int().min(1).default(24),
    IGNORE_USERS: csv(''),
    MASK_LITERALS: csv(''),
    ENABLE_SOCKET: bool(true),
    ENABLE_POLLER: bool(true),
    ENABLE_SCHEDULER: bool(true),
    ENABLE_SETUP: bool(true),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
    const cfg = schema.parse(Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== '')));
    return {
        ...cfg,
        GITLAB_URL: cfg.GITLAB_URL.replace(/\/+$/, ''),
        MM_URL: cfg.MM_URL.replace(/\/+$/, ''),
        SERVICE_URL: cfg.SERVICE_URL.replace(/\/+$/, ''),
        ACTION_SIGNING_SECRET: cfg.ACTION_SIGNING_SECRET || cfg.GITLAB_WEBHOOK_SECRET,
    };
}

/** Settings Matterwatch cannot work without. Returns the names that are missing. */
export function missingRequired(cfg: Config): string[] {
    const need: [string, string][] = [
        ['MM_TOKEN', cfg.MM_TOKEN],
        ['GITLAB_TOKEN', cfg.GITLAB_TOKEN],
        ['GITLAB_WEBHOOK_SECRET', cfg.GITLAB_WEBHOOK_SECRET],
        ['MM_TEAM_NAME', cfg.MM_TEAM_NAME],
        ['MM_UPDATES_CHANNEL_ID', cfg.MM_UPDATES_CHANNEL_ID],
    ];
    return need.filter(([, v]) => !v).map(([k]) => k);
}
