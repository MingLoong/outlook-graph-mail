import prisma from '../../lib/prisma.js';
import { logger } from '../../lib/logger.js';
import {
    type CachedMessage,
    type EmailMessage,
    type ImapFetchMeta,
    isCacheFresh,
    normalizeMailboxName,
} from './mail.types.js';

export interface FreshCacheResult {
    messages: CachedMessage[];
    cachedAt: Date;
}

export interface SyncStateResult {
    uidValidity: number;
    lastUid: number;
}

type MailCacheRow = {
    messageId: string;
    fromAddr: string;
    subject: string;
    textBody: string;
    htmlBody: string;
    mailDate: Date;
    cachedAt: Date;
};

function mapRowToMessage(row: MailCacheRow): CachedMessage {
    return {
        id: row.messageId,
        from: row.fromAddr,
        subject: row.subject,
        text: row.textBody,
        html: row.htmlBody,
        date: row.mailDate.toISOString(),
        cachedAt: row.cachedAt.toISOString(),
    };
}

export const mailCacheService = {
    /** TTL 内的缓存命中则返回邮件列表，否则 null（miss/禁用） */
    async getFreshCache(
        accountId: number,
        mailbox: string,
        ttlSeconds: number
    ): Promise<FreshCacheResult | null> {
        if (ttlSeconds <= 0) {
            return null;
        }
        const folder = normalizeMailboxName(mailbox);
        const rows = await prisma.mailCache.findMany({
            where: { accountId, mailbox: folder },
            orderBy: { mailDate: 'desc' },
            take: 200,
        });
        if (rows.length === 0) {
            return null;
        }
        if (!isCacheFresh(rows[0].cachedAt, ttlSeconds)) {
            return null;
        }
        return {
            cachedAt: rows[0].cachedAt,
            messages: rows.map(mapRowToMessage),
        };
    },

    /** 读取缓存行（不校验 TTL，用于与增量抓取结果合并展示） */
    async getRecentMessages(accountId: number, mailbox: string, limit: number): Promise<CachedMessage[]> {
        const folder = normalizeMailboxName(mailbox);
        const rows = await prisma.mailCache.findMany({
            where: { accountId, mailbox: folder },
            orderBy: { mailDate: 'desc' },
            take: Math.min(Math.max(limit, 1), 200),
        });
        return rows.map(mapRowToMessage);
    },

    /** 读取 IMAP 增量同步状态（无记录返回 null） */
    async getSyncState(accountId: number, mailbox: string): Promise<SyncStateResult | null> {
        const folder = normalizeMailboxName(mailbox);
        const state = await prisma.mailSyncState.findUnique({
            where: { accountId_mailbox: { accountId, mailbox: folder } },
        });
        if (!state) {
            return null;
        }
        return { uidValidity: state.uidValidity, lastUid: state.lastUid };
    },

    /**
     * 抓取成功后写入缓存并更新同步状态。
     * - meta.full：整文件夹替换（首次全量 / UIDVALIDITY 变化）
     * - 带 uidValidity 且非 full：增量补入新邮件
     * - 无 meta（如 Graph）：整文件夹替换
     * 失败仅记录日志，不影响邮件返回。
     */
    async saveFetchResult(
        accountId: number,
        mailbox: string,
        messages: EmailMessage[],
        meta?: ImapFetchMeta
    ): Promise<void> {
        const folder = normalizeMailboxName(mailbox);
        try {
            const hasImapMeta = typeof meta?.uidValidity === 'number';
            const fullReplace = !hasImapMeta || meta?.full === true;

            if (fullReplace) {
                await prisma.mailCache.deleteMany({ where: { accountId, mailbox: folder } });
            } else if (hasImapMeta) {
                // 增量模式：UIDVALIDITY 变化则整个文件夹作废
                const state = await prisma.mailSyncState.findUnique({
                    where: { accountId_mailbox: { accountId, mailbox: folder } },
                });
                if (state && state.uidValidity !== meta?.uidValidity) {
                    await prisma.mailCache.deleteMany({ where: { accountId, mailbox: folder } });
                }
            }

            if (messages.length > 0) {
                await prisma.mailCache.createMany({
                    data: messages.map((m) => ({
                        accountId,
                        mailbox: folder,
                        messageId: m.id,
                        fromAddr: m.from,
                        subject: m.subject,
                        textBody: m.text,
                        htmlBody: m.html,
                        mailDate: m.date ? new Date(m.date) : new Date(),
                    })),
                    skipDuplicates: true,
                });
            }

            if (hasImapMeta && typeof meta?.uidValidity === 'number') {
                const maxUid = meta.uids && meta.uids.length > 0 ? Math.max(...meta.uids) : undefined;
                await prisma.mailSyncState.upsert({
                    where: { accountId_mailbox: { accountId, mailbox: folder } },
                    create: {
                        accountId,
                        mailbox: folder,
                        uidValidity: meta.uidValidity,
                        lastUid: maxUid ?? 0,
                    },
                    update: {
                        uidValidity: meta.uidValidity,
                        // 全量时 maxUid 即最新 UID；增量无新邮件时保留原值
                        ...(maxUid !== undefined ? { lastUid: maxUid } : {}),
                        lastSyncAt: new Date(),
                    },
                });
            }

            logger.debug(
                { accountId, mailbox: folder, count: messages.length, fullReplace },
                'Mail cache saved'
            );
        } catch (err) {
            logger.error({ err, accountId, mailbox: folder }, 'Failed to save mail cache');
        }
    },

    /** 清空某账号某文件夹的缓存与同步状态（清空邮箱 / 手动清理时调用） */
    async clearFolder(accountId: number, mailbox: string): Promise<void> {
        const folder = normalizeMailboxName(mailbox);
        try {
            await prisma.mailCache.deleteMany({ where: { accountId, mailbox: folder } });
            await prisma.mailSyncState.deleteMany({ where: { accountId, mailbox: folder } });
        } catch (err) {
            logger.error({ err, accountId, mailbox: folder }, 'Failed to clear mail cache folder');
        }
    },

    /** 清空某账号全部缓存与同步状态（删除账号等场景） */
    async clearAccountCache(accountId: number): Promise<void> {
        try {
            await prisma.mailCache.deleteMany({ where: { accountId } });
            await prisma.mailSyncState.deleteMany({ where: { accountId } });
        } catch (err) {
            logger.error({ err, accountId }, 'Failed to clear account mail cache');
        }
    },

    /** 按保留天数清理过期缓存（定时任务调用） */
    async cleanupExpired(retentionDays: number): Promise<number> {
        const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
        const result = await prisma.mailCache.deleteMany({
            where: { cachedAt: { lt: cutoff } },
        });
        if (result.count > 0) {
            logger.info({ deleted: result.count, retentionDays }, 'Mail cache retention cleanup completed');
        }
        return result.count;
    },
};

