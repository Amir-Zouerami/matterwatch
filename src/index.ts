import { serve } from '@hono/node-server';
import { loadConfig, missingRequired } from './config.ts';
import { openDb } from './db/index.ts';
import { Features } from './features/service.ts';
import { GitlabClient } from './gitlab/client.ts';
import { MattermostClient } from './mattermost/client.ts';
import { MattermostSocket } from './mattermost/socket.ts';
import { AuditStore, CardsStore, OnceStore, ProjectsStore, SettingsStore, WatchesStore } from './domain/stores.ts';
import { UsersStore } from './domain/users.ts';
import type { App } from './app.ts';
import { createHttpApp } from './http/app.ts';
import { drainInbound } from './services/ingest.ts';
import { purgeOldRows, runDueScheduled } from './services/scheduler.ts';
import { handleMessagePosted, pollWatches } from './services/watch.ts';
import { catchUp, noteSeen } from './services/catchup.ts';
import { runDigest } from './services/digest.ts';
import { log, errMsg, setLogLevel } from './logger.ts';

const cfg = loadConfig();
setLogLevel(cfg.LOG_LEVEL);

const missing = missingRequired(cfg);
if (missing.length) {
    log.error(`missing required settings: ${missing.join(', ')} (see .env.example)`);
    process.exit(1);
}

const db = openDb(cfg.DB_PATH);
const mm = new MattermostClient(cfg.MM_URL, cfg.MM_TOKEN);
const gl = new GitlabClient(cfg.GITLAB_URL, cfg.GITLAB_TOKEN);
async function connectBot() {
    for (let attempt = 1; ; attempt++) {
        try {
            return await mm.me();
        } catch (e) {
            if (attempt >= 12) throw e;
            log.warn('waiting for Mattermost', { attempt, err: errMsg(e) });
            await new Promise((r) => setTimeout(r, 5000));
        }
    }
}
const bot = await connectBot();
let slashToken = cfg.MM_SLASH_TOKEN;

const app: App = {
    cfg,
    db,
    features: new Features(db),
    gl,
    mm,
    users: new UsersStore(db, mm),
    cards: new CardsStore(db),
    watches: new WatchesStore(db, cfg.WATCH_TTL_HOURS),
    settings: new SettingsStore(db),
    projects: new ProjectsStore(db),
    audit: new AuditStore(db),
    once: new OnceStore(db),
    bot,
    slashToken: () => slashToken,
};

// Re-checked hourly: if someone removes the bot from a channel it quietly rejoins instead of going deaf.
async function ensureChannels(): Promise<void> {
    for (const channelId of [cfg.MM_UPDATES_CHANNEL_ID, ...cfg.MM_WATCH_CHANNEL_IDS]) {
        try {
            if (!(await mm.isChannelMember(channelId, bot.id))) {
                await mm.addSelfToChannel(channelId);
                log.info('joined channel', { channelId });
            }
        } catch (e) {
            log.warn('could not join channel (add the bot manually or give it admin rights)', { channelId, err: errMsg(e) });
        }
    }
}

// ── one-time setup: join channels, register /gl ──
async function setup(): Promise<void> {
    let teamId: string | null = null;
    try {
        teamId = (await mm.getTeamByName(cfg.MM_TEAM_NAME)).id;
        await mm.addSelfToTeam(teamId).catch(() => undefined); // already a member is fine
    } catch (e) {
        log.warn('team lookup failed', { team: cfg.MM_TEAM_NAME, err: errMsg(e) });
    }
    await ensureChannels();
    if (!teamId) return;
    try {
        const res = await mm.ensureCommand(teamId, cfg.MM_SLASH_TRIGGER, `${cfg.SERVICE_URL}/mm/slash`);
        slashToken = res.token;
        log.info('slash command registered', { trigger: cfg.MM_SLASH_TRIGGER });
    } catch (e) {
        log.warn('slash command setup failed (needs manage_slash_commands permission)', { err: errMsg(e) });
    }
}
if (cfg.ENABLE_SETUP) await setup().catch((e) => log.error('setup failed', { err: errMsg(e) }));

// ── websocket: link detection ──
const socket = new MattermostSocket(cfg.MM_URL, cfg.MM_TOKEN, {
    onPosted: async (post) => {
        await handleMessagePosted(app, post);
        noteSeen(app, post);
    },
    onAuthenticated: async () => {
        await catchUp(app);
    },
});
if (cfg.ENABLE_SOCKET) socket.start();

// ── workers ──
let kicking = false;
let kickAgain = false;
const kick = (): void => {
    if (kicking) {
        kickAgain = true; // events that arrive while draining are picked up straight away, not on the next timer tick
        return;
    }
    kicking = true;
    setImmediate(async () => {
        do {
            kickAgain = false;
            await drainInbound(app).catch((e) => log.error('drain failed', { err: errMsg(e) }));
        } while (kickAgain);
        kicking = false;
    });
};

const timers: NodeJS.Timeout[] = [];
const every = (ms: number, name: string, fn: () => Promise<unknown>): void => {
    let running = false;
    const t = setInterval(() => {
        if (running) return;
        running = true;
        fn()
            .catch((e) => log.error(`${name} failed`, { err: errMsg(e) }))
            .finally(() => (running = false));
    }, ms);
    t.unref();
    timers.push(t);
};

every(5_000, 'inbound-drain', () => drainInbound(app));
every(5_000, 'outbox', () => runDueScheduled(app));
if (cfg.ENABLE_SETUP) every(3_600_000, 'channel-membership', ensureChannels);
if (cfg.ENABLE_SCHEDULER) {
    every(60_000, 'digest', () => runDigest(app));
    every(6 * 3_600_000, 'purge', async () => purgeOldRows(app));
}
if (cfg.ENABLE_POLLER) every(cfg.POLL_INTERVAL_SECONDS * 1000, 'poller', () => pollWatches(app));

// ── http ──
const http = createHttpApp(app, { kick, socketConnected: () => socket.connected });
const server = serve({ fetch: http.fetch, port: cfg.PORT }, (info) => log.info('listening', { port: info.port, bot: bot.username }));

kick();

let stopping = false;
async function shutdown(signal: string): Promise<void> {
    if (stopping) return;
    stopping = true;
    log.info('shutting down', { signal });
    socket.stop();
    timers.forEach(clearInterval);
    server.close();
    // let in-flight work settle briefly, then checkpoint the WAL so the file is self-contained
    await new Promise((r) => setTimeout(r, 1500));
    try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        db.close();
    } catch {
        /* already closed */
    }
    process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (e) => log.error('unhandledRejection', { err: errMsg(e) }));
