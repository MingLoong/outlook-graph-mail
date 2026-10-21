/** 一封邮件的标准化表示 */
export interface EmailMessage {
    id: string;
    from: string;
    subject: string;
    text: string;
    html: string;
    date: string;
}

/** 缓存命中的邮件附带缓存写入时间 */
export interface CachedMessage extends EmailMessage {
    cachedAt?: string;
}

/** 一次 IMAP 抓取的同步元数据（用于增量缓存写入） */
export interface ImapFetchMeta {
    /** 当前文件夹的 UIDVALIDITY */
    uidValidity?: number;
    /** 本次抓取涉及的全部 UID（全量或增量） */
    uids?: number[];
    /** 全量替换文件夹缓存（而非增量补入） */
    full?: boolean;
    /** 本次只抓取了邮件头（正文按需单独获取），缓存不覆盖带正文的行 */
    headersOnly?: boolean;
}

export function normalizeMailboxName(mailbox: string): string {
    return (mailbox || 'INBOX').toLowerCase() === 'inbox' ? 'INBOX' : mailbox;
}

/** 判断缓存是否仍在 TTL 内（ttlSeconds<=0 表示禁用缓存） */
export function isCacheFresh(
    cachedAt: Date | string | null | undefined,
    ttlSeconds: number,
    now: number = Date.now()
): boolean {
    if (!cachedAt || ttlSeconds <= 0) {
        return false;
    }
    const ts = typeof cachedAt === 'string' ? Date.parse(cachedAt) : cachedAt.getTime();
    if (Number.isNaN(ts)) {
        return false;
    }
    return now - ts <= ttlSeconds * 1000;
}
