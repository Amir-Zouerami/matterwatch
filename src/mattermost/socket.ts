import { log, errMsg } from '../logger.ts';
import type { MmPost } from './types.ts';

export interface SocketHandlers {
    onPosted(post: MmPost, info: { senderName?: string; channelType?: string }): void | Promise<void>;
    onAuthenticated?(): void | Promise<void>;
    onReaction?(reaction: { user_id: string; post_id: string; emoji_name: string }, added: boolean): void | Promise<void>;
}

/** Mattermost WebSocket listener with auth challenge and exponential reconnect. */
export class MattermostSocket {
    private ws: WebSocket | null = null;
    private stopped = false;
    private attempt = 0;
    private seq = 1;
    private ping: NodeJS.Timeout | null = null;
    private lastMessageAt = Date.now();
    connected = false;

    private readonly baseUrl: string;
    private readonly token: string;
    private readonly handlers: SocketHandlers;
    constructor(baseUrl: string, token: string, handlers: SocketHandlers) {
        this.baseUrl = baseUrl;
        this.token = token;
        this.handlers = handlers;}

    start(): void {
        this.stopped = false;
        this.connect();
    }

    stop(): void {
        this.stopped = true;
        if (this.ping) clearInterval(this.ping);
        this.ws?.close();
    }

    private connect(): void {
        if (this.stopped) return;
        const url = this.baseUrl.replace(/^http/, 'ws') + '/api/v4/websocket';
        const ws = new WebSocket(url);
        this.ws = ws;
        this.seq = 1; // the auth reply is matched on seq_reply === 1, so restart numbering per connection

        ws.addEventListener('open', () => {
            ws.send(JSON.stringify({ seq: this.seq++, action: 'authentication_challenge', data: { token: this.token } }));
        });

        ws.addEventListener('message', (ev) => {
            this.lastMessageAt = Date.now();
            let msg: { event?: string; status?: string; data?: Record<string, unknown>; seq_reply?: number };
            try {
                msg = JSON.parse(String(ev.data));
            } catch {
                return;
            }
            if (msg.status === 'OK' && msg.seq_reply === 1) {
                this.connected = true;
                this.attempt = 0;
                log.info('mattermost websocket authenticated');
                Promise.resolve(this.handlers.onAuthenticated?.()).catch((e) => log.error('onAuthenticated failed', { err: errMsg(e) }));
                return;
            }
            if ((msg.event === 'posted' || msg.event === 'post_edited') && msg.data) {
                try {
                    const post = JSON.parse(String(msg.data['post'])) as MmPost;
                    const info: { senderName?: string; channelType?: string } = {};
                    if (typeof msg.data['sender_name'] === 'string') info.senderName = msg.data['sender_name'];
                    if (typeof msg.data['channel_type'] === 'string') info.channelType = msg.data['channel_type'];
                    Promise.resolve(this.handlers.onPosted(post, info)).catch((e) =>
                        log.error('onPosted failed', { err: errMsg(e) }),
                    );
                } catch (e) {
                    log.warn('bad posted event', { err: errMsg(e) });
                }
            } else if ((msg.event === 'reaction_added' || msg.event === 'reaction_removed') && msg.data && this.handlers.onReaction) {
                try {
                    const r = JSON.parse(String(msg.data['reaction']));
                    Promise.resolve(this.handlers.onReaction(r, msg.event === 'reaction_added')).catch(() => undefined);
                } catch {
                    /* ignore */
                }
            }
        });

        ws.addEventListener('close', () => this.scheduleReconnect());
        ws.addEventListener('error', (e) => log.warn('mattermost websocket error', { err: errMsg((e as ErrorEvent).error ?? e) }));

        if (this.ping) clearInterval(this.ping);
        this.ping = setInterval(() => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (Date.now() - this.lastMessageAt > 120_000) {
                log.warn('mattermost websocket stale, reconnecting');
                ws.close();
                return;
            }
            ws.send(JSON.stringify({ seq: this.seq++, action: 'ping' }));
        }, 30_000);
        this.ping.unref();
    }

    private scheduleReconnect(): void {
        this.connected = false;
        if (this.stopped) return;
        this.attempt++;
        const delay = Math.min(30_000, 1000 * 2 ** Math.min(this.attempt, 5));
        log.warn('mattermost websocket closed; reconnecting', { delayMs: delay });
        setTimeout(() => this.connect(), delay).unref();
    }
}
