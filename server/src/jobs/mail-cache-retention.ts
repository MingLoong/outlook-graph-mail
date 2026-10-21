import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';
import { mailCacheService } from '../modules/mail/mail-cache.service.js';

let running = false;

async function runMailCacheCleanupOnce() {
    if (running) {
        return;
    }

    running = true;
    try {
        const deleted = await mailCacheService.cleanupExpired(env.MAIL_CACHE_RETENTION_DAYS);
        logger.debug({ deleted, retentionDays: env.MAIL_CACHE_RETENTION_DAYS }, 'Mail cache cleanup tick');
    } catch (err) {
        logger.error({ err }, 'Mail cache cleanup failed');
    } finally {
        running = false;
    }
}

export function startMailCacheCleanupJob(): () => void {
    const intervalMs = env.MAIL_CACHE_CLEANUP_INTERVAL_MINUTES * 60 * 1000;
    logger.info({
        retentionDays: env.MAIL_CACHE_RETENTION_DAYS,
        intervalMinutes: env.MAIL_CACHE_CLEANUP_INTERVAL_MINUTES,
    }, 'Mail cache cleanup job started');

    const timer = setInterval(() => {
        void runMailCacheCleanupOnce();
    }, intervalMs);

    if (typeof timer.unref === 'function') {
        timer.unref();
    }

    return () => {
        clearInterval(timer);
    };
}
