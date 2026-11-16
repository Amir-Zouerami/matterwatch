export const PIPELINE_STYLE: Record<string, { emoji: string; color: string; label: string }> = {
    success: { emoji: '✅', color: '#2da44e', label: 'passed' },
    failed: { emoji: '❌', color: '#dd2b0e', label: 'failed' },
    running: { emoji: '🔄', color: '#1f75cb', label: 'running' },
    pending: { emoji: '⏳', color: '#9ca3af', label: 'pending' },
    created: { emoji: '🆕', color: '#9ca3af', label: 'created' },
    canceled: { emoji: '⏹️', color: '#6b7280', label: 'canceled' },
    canceling: { emoji: '⏹️', color: '#6b7280', label: 'canceling' },
    skipped: { emoji: '⏭️', color: '#6b7280', label: 'skipped' },
    manual: { emoji: '✋', color: '#d97706', label: 'waiting for manual action' },
    scheduled: { emoji: '⏰', color: '#9ca3af', label: 'scheduled' },
    preparing: { emoji: '🧰', color: '#9ca3af', label: 'preparing' },
    waiting_for_resource: { emoji: '⏳', color: '#9ca3af', label: 'waiting for resource' },
    success_with_warnings: { emoji: '⚠️', color: '#d97706', label: 'passed with warnings' },
};

export function pipelineStyle(status: string): { emoji: string; color: string; label: string } {
    return PIPELINE_STYLE[status] ?? { emoji: '❔', color: '#9ca3af', label: status };
}

export const MR_STYLE: Record<string, { emoji: string; color: string; label: string }> = {
    opened: { emoji: '🟢', color: '#1f75cb', label: 'open' },
    merged: { emoji: '🟣', color: '#8b5cf6', label: 'merged' },
    closed: { emoji: '🔴', color: '#dd2b0e', label: 'closed' },
    locked: { emoji: '🔒', color: '#6b7280', label: 'locked' },
    draft: { emoji: '📝', color: '#9ca3af', label: 'draft' },
};

export function mrStyle(state: string, draft?: boolean): { emoji: string; color: string; label: string } {
    if (draft && state === 'opened') return MR_STYLE['draft']!;
    return MR_STYLE[state] ?? { emoji: '🔀', color: '#9ca3af', label: state };
}

export const JOB_EMOJI: Record<string, string> = {
    success: '✅',
    failed: '❌',
    running: '🔄',
    pending: '⏳',
    canceled: '⏹️',
    skipped: '⏭️',
    manual: '✋',
    created: '⚪',
};
