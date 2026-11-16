export interface MmUser {
    id: string;
    username: string;
    email?: string;
    first_name?: string;
    last_name?: string;
    nickname?: string;
    roles: string;
    is_bot?: boolean;
}

export interface MmPost {
    id: string;
    channel_id: string;
    user_id: string;
    message: string;
    root_id?: string;
    props?: Record<string, unknown>;
    create_at?: number;
    update_at?: number;
    delete_at?: number;
    type?: string;
}

export interface MmButton {
    id: string;
    name: string;
    type?: 'button' | 'select';
    style?: 'default' | 'primary' | 'success' | 'good' | 'warning' | 'danger';
    disabled?: boolean;
    integration: { url: string; context: Record<string, unknown> };
}

export interface MmAttachment {
    fallback: string;
    color?: string;
    pretext?: string;
    author_name?: string;
    author_icon?: string;
    author_link?: string;
    title?: string;
    title_link?: string;
    text?: string;
    fields?: { title: string; value: string; short?: boolean }[];
    footer?: string;
    footer_icon?: string;
    actions?: MmButton[];
}

export interface OutPost {
    channel_id: string;
    message: string;
    root_id?: string;
    props?: { attachments?: MmAttachment[]; [k: string]: unknown };
    file_ids?: string[];
}

/** The subset of Mattermost we use. Faked in tests. */
export interface MattermostApi {
    me(): Promise<MmUser>;
    createPost(post: OutPost): Promise<MmPost>;
    patchPost(id: string, patch: { message?: string; props?: OutPost['props'] }): Promise<MmPost>;
    getPost(id: string): Promise<MmPost>;
    /** Posts created/edited in a channel since `sinceMs` (oldest first). */
    postsSince(channelId: string, sinceMs: number): Promise<MmPost[]>;
    deletePost(id: string): Promise<void>;
    dmChannel(userId: string): Promise<string>;
    userByEmail(email: string): Promise<MmUser | null>;
    userByUsername(username: string): Promise<MmUser | null>;
    userById(id: string): Promise<MmUser | null>;
    addReaction(postId: string, emoji: string): Promise<void>;
    removeReaction(postId: string, emoji: string): Promise<void>;
    uploadFile(channelId: string, filename: string, content: string): Promise<string>;
    addSelfToTeam(teamId: string): Promise<void>;
    addSelfToChannel(channelId: string): Promise<void>;
    isChannelMember(channelId: string, userId: string): Promise<boolean>;
    getTeamByName(name: string): Promise<{ id: string }>;
    ensureCommand(teamId: string, trigger: string, url: string): Promise<{ token: string }>;
    ephemeral(userId: string, channelId: string, message: string): Promise<void>;
}
