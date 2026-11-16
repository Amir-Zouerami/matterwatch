import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import type { Features } from './features/service.ts';
import type { GitlabApi } from './gitlab/client.ts';
import type { MattermostApi, MmUser } from './mattermost/types.ts';
import type { AuditStore, CardsStore, OnceStore, ProjectsStore, SettingsStore, WatchesStore } from './domain/stores.ts';
import type { UsersStore } from './domain/users.ts';

/** Everything a service needs. Built once in index.ts, faked in tests. */
export interface App {
    cfg: Config;
    db: Db;
    features: Features;
    gl: GitlabApi;
    mm: MattermostApi;
    users: UsersStore;
    cards: CardsStore;
    watches: WatchesStore;
    settings: SettingsStore;
    projects: ProjectsStore;
    audit: AuditStore;
    once: OnceStore;
    bot: MmUser;
    /** Filled at startup when the slash command is (re)registered. */
    slashToken: () => string;
}
