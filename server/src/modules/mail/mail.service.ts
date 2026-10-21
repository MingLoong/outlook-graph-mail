import { emailService } from '../email/email.service.js';
import { poolService } from './pool.service.js';
import { AppError } from '../../plugins/error.js';
import { logger } from '../../lib/logger.js';
import { setCache, getCache } from '../../lib/redis.js';
import { proxyFetch } from '../../lib/proxy.js';
import { getImapFolderCandidates, getProviderConfig } from './providers.js';
import { mailCacheService } from './mail-cache.service.js';
import prisma from '../../lib/prisma.js';
import type { MailRequestInput } from './mail.schema.js';
import type { EmailMessage, ImapFetchMeta } from './mail.types.js';
import Imap from 'node-imap';
import { simpleParser, type ParsedMail, type Source } from 'mailparser';

type MailFetchStrategy = 'GRAPH_FIRST' | 'IMAP_FIRST' | 'GRAPH_ONLY' | 'IMAP_ONLY';

interface Credentials {
    id: number;
    email: string;
    provider?: string | null;
    clientId?: string | null;
    refreshToken?: string | null;
    password?: string | null;
    imapHost?: string | null;
    imapPort?: number | null;
    autoAssigned: boolean;
    fetchStrategy?: MailFetchStrategy;
}

interface OAuthTokenResponse {
    access_token?: string;
    expires_in?: number;
    scope?: string;
}

interface GraphMessage {
    id?: string;
    from?: {
        emailAddress?: {
            address?: string;
        };
    };
    subject?: string;
    bodyPreview?: string;
    body?: {
        content?: string;
    };
    createdDateTime?: string;
}

interface GraphMessagesResponse {
    value?: GraphMessage[];
}

function getErrorMessage(error: unknown): string {
    if (!error || typeof error !== 'object') {
        return 'Unknown error';
    }
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' && message.trim() ? message : 'Unknown error';
}

function isOutlookProvider(credentials: Credentials): boolean {
    return (credentials.provider || 'outlook').toLowerCase() === 'outlook';
}

/**
 * 将第三方 IMAP 的原始报错转成带排查提示的应用错误
 */
function normalizeImapError(err: unknown, provider: string, host: string, port: number): AppError {
    const raw = getErrorMessage(err);
    const providerKey = (provider || '').toLowerCase();
    const lowered = raw.toLowerCase();

    // 连接/读取超时：常见于海外服务器无法访问的 IMAP 主机
    if (lowered.includes('timed out') || lowered.includes('timeout')) {
        return new AppError(
            'IMAP_TIMEOUT',
            `IMAP 连接超时（${host}:${port}）：该服务器可能无法从当前服务器网络访问，可在请求中携带 socks5/http 代理参数重试`,
            504
        );
    }

    const isAuthError =
        lowered.includes('authentication') ||
        lowered.includes('login fail') ||
        lowered.includes('invalid credentials') ||
        lowered.includes('auth') ||
        lowered.includes('password');

    if (!isAuthError) {
        return new AppError('IMAP_ERROR', `IMAP 收取失败（${host}）：${raw}`, 502);
    }

    let hint = '请检查密码/授权码是否正确，并确认邮箱已开启 IMAP 服务';
    if (providerKey === 'gmail') {
        hint = 'Gmail 通常需要「应用专用密码」（非登录密码），并需在 Gmail 设置中开启 IMAP';
    } else if (providerKey === 'qq' || providerKey === '163' || providerKey === '126') {
        hint = '请在邮箱设置中开启 IMAP 服务，并使用生成的授权码（非登录密码）';
    } else if (providerKey === 'yahoo') {
        hint = '请使用 Yahoo 账户安全设置中生成的应用密码';
    } else if (providerKey === 'aliyun') {
        hint = '请使用阿里邮箱登录密码或授权码，并确认已开启 IMAP 服务';
    }

    return new AppError('IMAP_AUTH_FAILED', `IMAP 认证失败（${host}）：${hint}`, 502);
}

export const mailService = {
    /**
     * 解析凭证
     */
    async resolveCredentials(
        input: MailRequestInput,
        apiKeyId?: number
    ): Promise<Credentials> {
        const { email, auto } = input;

        // 自动分配模式
        if (!email && auto) {
            if (!apiKeyId) {
                throw new AppError('AUTH_REQUIRED', 'Auto assignment requires API Key authentication', 400);
            }

            const account = await poolService.getUnusedEmail(apiKeyId);
            if (!account) {
                const stats = await poolService.getStats(apiKeyId);
                throw new AppError(
                    'NO_UNUSED_EMAIL',
                    `No unused emails available. Used: ${stats.used}/${stats.total}`,
                    400
                );
            }

            return { ...account, autoAssigned: true };
        }

        // 必须提供邮箱
        if (!email) {
            throw new AppError('EMAIL_REQUIRED', 'Email is required. Set auto=true to auto-assign.', 400);
        }

        // 从数据库查询
        const account = await emailService.getByEmail(email);
        if (!account) {
            throw new AppError('EMAIL_NOT_FOUND', 'Email account not found', 404);
        }

        return { ...account, autoAssigned: false };
    },

    /**
     * 更新邮箱状态
     */
    async updateEmailStatus(emailId: number, success: boolean, errorMessage?: string) {
        await emailService.updateStatus(
            emailId,
            success ? 'ACTIVE' : 'ERROR',
            errorMessage
        );
    },

    /**
     * 记录 API 调用
     */
    async logApiCall(
        action: string,
        apiKeyId: number | undefined,
        emailAccountId: number | undefined,
        requestIp: string,
        responseCode: number,
        responseTimeMs: number,
        requestId?: string
    ) {
        try {
            await prisma.apiLog.create({
                data: {
                    action,
                    apiKeyId,
                    emailAccountId,
                    requestIp,
                    responseCode,
                    responseTimeMs,
                    metadata: requestId ? { requestId } : undefined,
                },
            });
        } catch (err) {
            logger.error({ err }, 'Failed to log API call');
        }
    },

    /**
     * 获取 Microsoft Graph API Access Token
     */
    async getGraphAccessToken(
        credentials: Credentials,
        proxyConfig?: { socks5?: string; http?: string }
    ): Promise<{ accessToken: string; hasMailRead: boolean } | null> {
        if (!credentials.refreshToken || !credentials.clientId) {
            logger.warn({ email: credentials.email }, 'Missing refresh token or clientId for Graph API');
            return null;
        }

        const cacheKey = `graph_api_access_token_${credentials.email}`;

        // 尝试从缓存获取（缓存的 token 一定有 Mail.Read 权限）
        const cachedToken = await getCache(cacheKey);
        if (cachedToken) {
            logger.debug({ email: credentials.email }, 'Using cached Graph API token');
            return { accessToken: cachedToken, hasMailRead: true };
        }

        try {
            const response = await proxyFetch(
                'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: new URLSearchParams({
                        client_id: credentials.clientId,
                        grant_type: 'refresh_token',
                        refresh_token: credentials.refreshToken,
                        scope: 'https://graph.microsoft.com/.default',
                    }).toString(),
                },
                proxyConfig
            );

            if (!response.ok) {
                const errorText = await response.text();
                logger.error({ email: credentials.email, status: response.status, error: errorText }, 'Graph API token request failed');
                return null;
            }

            const data = await response.json() as OAuthTokenResponse;

            // 检查是否有邮件读取权限
            const scopeText = typeof data.scope === 'string' ? data.scope : '';
            const hasMailRead = scopeText.includes('https://graph.microsoft.com/Mail.Read');
            const accessToken = typeof data.access_token === 'string' ? data.access_token : null;

            if (!accessToken) {
                logger.warn({ email: credentials.email }, 'Graph API token missing access_token');
                return null;
            }

            if (hasMailRead) {
                // 只有有 Mail.Read 权限时才缓存
                const expireTime = ((typeof data.expires_in === 'number' ? data.expires_in : 3600) - 60);
                await setCache(cacheKey, accessToken, expireTime);
            } else {
                logger.warn({ email: credentials.email }, 'No Mail.Read scope in token, will fallback to IMAP');
            }

            return { accessToken, hasMailRead };
        } catch (err) {
            logger.error({ err, email: credentials.email }, 'Failed to get Graph API token');
            return null;
        }
    },

    /**
     * 使用 Graph API 获取邮件
     */
    async getEmailsViaGraphApi(
        accessToken: string,
        mailbox: string,
        limit: number = 100,
        proxyConfig?: { socks5?: string; http?: string },
        headersOnly: boolean = false
    ): Promise<EmailMessage[]> {
        // 转换邮箱名称
        let folder = 'inbox';
        if (mailbox?.toLowerCase() === 'junk') {
            folder = 'junkemail';
        } else if (mailbox?.toLowerCase() === 'inbox') {
            folder = 'inbox';
        }

        // 仅取邮件头时排除 body 字段，响应体显著变小
        const select = headersOnly
            ? '&$select=id,subject,from,receivedDateTime,createdDateTime,bodyPreview'
            : '';

        try {
            const response = await proxyFetch(
                `https://graph.microsoft.com/v1.0/me/mailFolders/${folder}/messages?$top=${limit}&$orderby=receivedDateTime desc${select}`,
                {
                    method: 'GET',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                    },
                },
                proxyConfig
            );

            if (!response.ok) {
                const errorText = await response.text();
                throw new Error(`Graph API error: ${response.status} - ${errorText}`);
            }

            const data = await response.json() as GraphMessagesResponse;
            const emails = Array.isArray(data.value) ? data.value : [];

            return emails.map((item: GraphMessage, index: number) => ({
                id: item.id || `graph_${Date.now()}_${index}`,
                from: item.from?.emailAddress?.address || '',
                subject: item.subject || '',
                text: item.bodyPreview || '',
                html: headersOnly ? '' : (item.body?.content || ''),
                date: item.createdDateTime || '',
            }));
        } catch (err) {
            logger.error({ err }, 'Failed to fetch emails via Graph API');
            throw err;
        }
    },

    /**
     * 获取 IMAP Access Token (不带 scope)
     */
    async getImapAccessToken(
        credentials: Credentials,
        proxyConfig?: { socks5?: string; http?: string }
    ): Promise<string | null> {
        if (!credentials.refreshToken || !credentials.clientId) {
            logger.warn({ email: credentials.email }, 'Missing refresh token or clientId for IMAP token');
            return null;
        }

        const cacheKey = `imap_api_access_token_${credentials.email}`;

        const cachedToken = await getCache(cacheKey);
        if (cachedToken) {
            logger.debug({ email: credentials.email }, 'Using cached IMAP token');
            return cachedToken;
        }

        try {
            const response = await proxyFetch(
                'https://login.microsoftonline.com/consumers/oauth2/v2.0/token',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: new URLSearchParams({
                        client_id: credentials.clientId,
                        grant_type: 'refresh_token',
                        refresh_token: credentials.refreshToken,
                        // 注意：IMAP 不需要 scope
                    }).toString(),
                },
                proxyConfig
            );

            if (!response.ok) {
                const errorText = await response.text();
                logger.error({ email: credentials.email, status: response.status, error: errorText }, 'IMAP token request failed');
                return null;
            }

            const data = await response.json() as OAuthTokenResponse;
            const accessToken = typeof data.access_token === 'string' ? data.access_token : null;
            if (!accessToken) {
                logger.warn({ email: credentials.email }, 'IMAP token missing access_token');
                return null;
            }

            const expireTime = ((typeof data.expires_in === 'number' ? data.expires_in : 3600) - 60);
            await setCache(cacheKey, accessToken, expireTime);

            return accessToken;
        } catch (err) {
            logger.error({ err, email: credentials.email }, 'Failed to get IMAP token');
            return null;
        }
    },

    /**
     * 生成 IMAP XOAUTH2 认证字符串
     */
    generateAuthString(email: string, accessToken: string): string {
        const authString = `user=${email}\x01auth=Bearer ${accessToken}\x01\x01`;
        return Buffer.from(authString).toString('base64');
    },

    /**
     * 使用 IMAP 获取邮件（Outlook OAuth XOAUTH2 模式）
     */
    async getEmailsViaImap(
        email: string,
        authString: string,
        mailbox: string = 'INBOX',
        limit: number = 100
    ): Promise<EmailMessage[]> {
        return new Promise((resolve, reject) => {
            const imapConfig: ConstructorParameters<typeof Imap>[0] = {
                user: email,
                password: '',
                xoauth2: authString,
                host: 'outlook.office365.com',
                port: 993,
                tls: true,
                connTimeout: 15000,
                socketTimeout: 30000,
                tlsOptions: {
                    rejectUnauthorized: false,
                },
            } as ConstructorParameters<typeof Imap>[0];
            const imap = new Imap(imapConfig);

            const emailList: EmailMessage[] = [];
            let messageCount = 0;
            let processedCount = 0;

            imap.once('ready', async () => {
                try {
                    await new Promise<void>((res, rej) => {
                        imap.openBox(mailbox, true, (err) => {
                            if (err) return rej(err);
                            res();
                        });
                    });

                    imap.search(['ALL'], (err: Error | null, results: number[]) => {
                        if (err) {
                            imap.end();
                            return reject(err);
                        }

                        if (!results || results.length === 0) {
                            imap.end();
                            return resolve([]);
                        }

                        // 限制返回数量
                        const limitedResults = results.slice(-limit);
                        messageCount = limitedResults.length;

                        // node-imap 不返回 UID，按 FETCH 响应顺序与请求的 UID 列表配对
                        let fetchIndex = 0;

                        const f = imap.fetch(limitedResults, { bodies: '' });

                        f.on('message', (msg) => {
                            const msgUid = limitedResults[fetchIndex];
                            fetchIndex += 1;
                            msg.on('body', (stream) => {
                                simpleParser(stream as unknown as Source)
                                    .then((mail: ParsedMail) => {
                                        const html = typeof mail.html === 'string' ? mail.html : '';
                                        emailList.push({
                                            id: msgUid ? `imap:${msgUid}` : `imap_${Date.now()}_${processedCount}`,
                                            from: mail.from?.text || '',
                                            subject: mail.subject || '',
                                            text: mail.text || '',
                                            html,
                                            date: mail.date?.toISOString() || '',
                                        });
                                    })
                                    .catch((parseErr: Error) => {
                                        logger.error({ parseErr }, 'Error parsing email');
                                    })
                                    .finally(() => {
                                        processedCount++;
                                        if (processedCount === messageCount) {
                                            imap.end();
                                        }
                                    });
                            });
                        });

                        f.once('error', (fetchErr: Error) => {
                            logger.error({ fetchErr }, 'IMAP fetch error');
                            imap.end();
                            reject(fetchErr);
                        });

                        f.once('end', () => {
                            // 如果没有消息，直接结束
                            if (messageCount === 0) {
                                imap.end();
                            }
                        });
                    });
                } catch (err) {
                    imap.end();
                    reject(err);
                }
            });

            imap.once('error', (err: Error) => {
                logger.error({ err }, 'IMAP connection error');
                reject(err);
            });

            imap.once('end', () => {
                logger.debug({ email }, 'IMAP connection ended');
                // 按日期降序排序（最新的在前面）
                emailList.sort((a: EmailMessage, b: EmailMessage) => {
                    const dateA = a.date ? new Date(a.date).getTime() : 0;
                    const dateB = b.date ? new Date(b.date).getTime() : 0;
                    return dateB - dateA;
                });
                resolve(emailList);
            });

            imap.connect();
        });
    },

    /**
     * 使用通用 IMAP（密码/授权码模式）获取邮件
     * 支持 Gmail / QQ / 163 / 126 / Yahoo / 阿里云 / 自定义 IMAP
     * sync 存在且 UIDVALIDITY 一致时走 UID 增量抓取（只拉新邮件）；
     * onMeta 回传本次抓取的同步元数据，供缓存层写入。
     */
    async getEmailsViaGenericImap(
        credentials: Credentials,
        mailbox: string = 'INBOX',
        limit: number = 100,
        sync?: { uidValidity: number; lastUid: number } | null,
        onMeta?: (meta: ImapFetchMeta) => void,
        headersOnly: boolean = false
    ): Promise<EmailMessage[]> {
        const providerKey = (credentials.provider || 'custom').toLowerCase();
        const providerConfig = getProviderConfig(providerKey);
        const host = credentials.imapHost || providerConfig?.imapHost;
        const port = credentials.imapPort || providerConfig?.imapPort || 993;
        const password = credentials.password;

        if (!password) {
            throw new AppError('IMAP_PASSWORD_MISSING', 'IMAP password/authorization code is required for this mailbox', 400);
        }
        if (!host) {
            throw new AppError('IMAP_HOST_MISSING', 'IMAP host is required for this mailbox', 400);
        }

        return new Promise((resolve, reject) => {
            const imapConfig: ConstructorParameters<typeof Imap>[0] = {
                user: credentials.email,
                password,
                host,
                port,
                tls: true,
                // 连接建立 15s、建立后空闲/读取 30s，避免不可达主机无限挂起
                // （socketTimeout 运行时支持但 @types/node-imap 尚未声明，故断言）
                connTimeout: 15000,
                socketTimeout: 30000,
                tlsOptions: {
                    rejectUnauthorized: false,
                },
            } as ConstructorParameters<typeof Imap>[0];
            const imap = new Imap(imapConfig);

            let settled = false;
            // 全局总超时：比前端 90s 略短，避免 axios 先报 "[500] timeout of 30000ms exceeded"
            const totalTimeoutMs = 75000;
            const watchdog = setTimeout(() => {
                if (settled) return;
                settled = true;
                logger.warn({ email: credentials.email, host, port, totalTimeoutMs }, 'Generic IMAP watchdog timeout');
                // 强制销毁底层 socket，避免静默挂起的连接泄漏
                const internals = imap as unknown as {
                    destroy?: () => void;
                    _sock?: { destroy?: () => void };
                };
                try {
                    internals._sock?.destroy?.();
                } catch {
                    // ignore
                }
                try {
                    internals.destroy?.();
                } catch {
                    // ignore
                }
                try {
                    imap.end();
                } catch {
                    // ignore
                }
                reject(
                    new AppError(
                        'IMAP_TIMEOUT',
                        `IMAP 总超时（${host}:${port}）超过 ${Math.round(totalTimeoutMs / 1000)} 秒，连接或读取长时间无响应。若服务器在海外，建议配置代理后再试`,
                        504
                    )
                );
            }, totalTimeoutMs);

            const finishResolve = (value: EmailMessage[]) => {
                if (settled) return;
                settled = true;
                clearTimeout(watchdog);
                resolve(value);
            };
            const finishReject = (err: unknown) => {
                if (settled) return;
                settled = true;
                clearTimeout(watchdog);
                reject(err);
            };

            const emailList: EmailMessage[] = [];
            let messageCount = 0;
            let processedCount = 0;

            imap.once('ready', async () => {
                try {
                    // 不同提供商的垃圾箱/已删除文件夹名不同，按候选列表尝试
                    const folderCandidates = getImapFolderCandidates(providerKey, mailbox);
                    let opened = false;
                    let folderUidValidity: number | undefined;
                    for (const candidate of folderCandidates) {
                        try {
                            await new Promise<void>((res, rej) => {
                                imap.openBox(candidate, true, (err, box) => {
                                    if (err) return rej(err);
                                    folderUidValidity = typeof box?.uidvalidity === 'number' ? box.uidvalidity : undefined;
                                    res();
                                });
                            });
                            opened = true;
                            break;
                        } catch {
                            // 尝试下一个候选文件夹
                        }
                    }

                    if (!opened) {
                        // 所有候选都失败，最后用原始 mailbox 名尝试
                        await new Promise<void>((res, rej) => {
                            imap.openBox(mailbox, true, (err, box) => {
                                if (err) return rej(err);
                                folderUidValidity = typeof box?.uidvalidity === 'number' ? box.uidvalidity : undefined;
                                res();
                            });
                        });
                    }

                    // 增量：同步游标有效时只搜索新 UID，否则全量
                    const syncLastUid = sync?.lastUid ?? 0;
                    const useIncremental =
                        typeof sync === 'object' &&
                        sync !== null &&
                        typeof folderUidValidity === 'number' &&
                        sync.uidValidity === folderUidValidity &&
                        syncLastUid > 0;

                    imap.search(useIncremental ? [['UID', `${syncLastUid + 1}:*`]] : ['ALL'], (err: Error | null, results: number[]) => {
                        if (err) {
                            imap.end();
                            return finishReject(err);
                        }

                        if (!results || results.length === 0) {
                            // 即使没有新邮件也推进同步游标
                            if (onMeta) {
                                onMeta({ uidValidity: folderUidValidity, uids: [], full: !useIncremental });
                            }
                            imap.end();
                            return finishResolve([]);
                        }

                        if (onMeta) {
                            onMeta({ uidValidity: folderUidValidity, uids: results, full: !useIncremental });
                        }

                        const limitedResults = results.slice(-limit);
                        messageCount = limitedResults.length;

                        // node-imap 不返回 UID，按 FETCH 响应顺序与请求的 UID 列表配对
                        let fetchIndex = 0;

                        // 仅取邮件头时只拉 HEADER，正文按需再取（首屏更快）
                        const f = imap.fetch(limitedResults, headersOnly ? { bodies: 'HEADER' } : { bodies: '' });

                        f.on('message', (msg) => {
                            const msgUid = limitedResults[fetchIndex];
                            fetchIndex += 1;
                            msg.on('body', (stream) => {
                                simpleParser(stream as unknown as Source)
                                    .then((mail: ParsedMail) => {
                                        const html = typeof mail.html === 'string' ? mail.html : '';
                                        emailList.push({
                                            id: msgUid ? `imap:${msgUid}` : `imap_${Date.now()}_${processedCount}`,
                                            from: mail.from?.text || '',
                                            subject: mail.subject || '',
                                            text: headersOnly ? '' : (mail.text || ''),
                                            html: headersOnly ? '' : html,
                                            date: mail.date?.toISOString() || '',
                                        });
                                    })
                                    .catch((parseErr: Error) => {
                                        logger.error({ parseErr }, 'Error parsing email');
                                    })
                                    .finally(() => {
                                        processedCount++;
                                        if (processedCount === messageCount) {
                                            imap.end();
                                        }
                                    });
                            });
                        });

                        f.once('error', (fetchErr: Error) => {
                            logger.error({ fetchErr }, 'Generic IMAP fetch error');
                            imap.end();
                            finishReject(fetchErr);
                        });

                        f.once('end', () => {
                            if (messageCount === 0) {
                                imap.end();
                            }
                        });
                    });
                } catch (err) {
                    imap.end();
                    finishReject(normalizeImapError(err, providerKey, host, port));
                }
            });

            imap.once('error', (err: Error) => {
                logger.error({ err, host, provider: providerKey }, 'Generic IMAP connection error');
                finishReject(normalizeImapError(err, providerKey, host, port));
            });

            imap.once('end', () => {
                logger.debug({ email: credentials.email, host }, 'Generic IMAP connection ended');
                emailList.sort((a: EmailMessage, b: EmailMessage) => {
                    const dateA = a.date ? new Date(a.date).getTime() : 0;
                    const dateB = b.date ? new Date(b.date).getTime() : 0;
                    return dateB - dateA;
                });
                finishResolve(emailList);
            });

            imap.connect();
        });
    },

    /**
     * 按需获取单封邮件正文（管理面板点「查看」时调用）
     * - messageId 形如 imap:<uid>：走 IMAP 拉取该 UID 的正文
     * - 其它（Graph 消息 ID）：走 Graph API 拉取正文
     */
    async getEmailBody(
        credentials: Credentials,
        mailbox: string,
        messageId: string,
        proxyConfig?: { socks5?: string; http?: string }
    ): Promise<EmailMessage> {
        const imapMatch = /^imap:(\d+)$/.exec(messageId);
        if (imapMatch) {
            const uid = parseInt(imapMatch[1], 10);
            if (isOutlookProvider(credentials)) {
                const imapToken = await this.getImapAccessToken(credentials, proxyConfig);
                if (!imapToken) {
                    throw new AppError('IMAP_TOKEN_FAILED', 'Failed to get IMAP access token', 502);
                }
                return this.fetchSingleMessageViaImap(
                    credentials,
                    mailbox,
                    uid,
                    { xoauth2: this.generateAuthString(credentials.email, imapToken) }
                );
            }
            return this.fetchSingleMessageViaImap(credentials, mailbox, uid, { password: credentials.password || '' });
        }

        if (!isOutlookProvider(credentials)) {
            throw new AppError(
                'MESSAGE_ID_INVALID',
                '邮件 ID 无效或已过期，请刷新列表后重试',
                400
            );
        }

        const tokenResult = await this.getGraphAccessToken(credentials, proxyConfig);
        if (!tokenResult) {
            throw new AppError('GRAPH_TOKEN_FAILED', 'Failed to get Graph API access token', 502);
        }
        return this.getMessageBodyViaGraphApi(tokenResult.accessToken, messageId, proxyConfig);
    },

    /** IMAP 拉取单封邮件正文 */
    async fetchSingleMessageViaImap(
        credentials: Credentials,
        mailbox: string,
        uid: number,
        auth: { password: string } | { xoauth2: string }
    ): Promise<EmailMessage> {
        const providerKey = (credentials.provider || 'custom').toLowerCase();
        const providerConfig = getProviderConfig(providerKey);
        const host = credentials.imapHost || providerConfig?.imapHost;
        const port = credentials.imapPort || providerConfig?.imapPort || 993;

        if (!host) {
            throw new AppError('IMAP_HOST_MISSING', 'IMAP host is required for this mailbox', 400);
        }
        if ('password' in auth && !auth.password) {
            throw new AppError('IMAP_PASSWORD_MISSING', 'IMAP password/authorization code is required for this mailbox', 400);
        }

        return new Promise((resolve, reject) => {
            const base = {
                user: credentials.email,
                host,
                port,
                tls: true,
                connTimeout: 15000,
                socketTimeout: 30000,
                tlsOptions: { rejectUnauthorized: false },
            };
            const imapConfig = (
                'xoauth2' in auth
                    ? { ...base, password: '', xoauth2: auth.xoauth2 }
                    : { ...base, password: auth.password }
            ) as ConstructorParameters<typeof Imap>[0];
            const imap = new Imap(imapConfig);

            let settled = false;
            let result: EmailMessage | null = null;
            const totalTimeoutMs = 30000;
            const watchdog = setTimeout(() => {
                if (settled) return;
                settled = true;
                const internals = imap as unknown as { _sock?: { destroy?: () => void } };
                try {
                    internals._sock?.destroy?.();
                } catch {
                    // ignore
                }
                reject(
                    new AppError(
                        'IMAP_TIMEOUT',
                        `IMAP 读取邮件正文超时（${host}:${port}）：服务器无响应，请稍后重试或配置代理`,
                        504
                    )
                );
            }, totalTimeoutMs);

            const finishResolve = (value: EmailMessage) => {
                if (settled) return;
                settled = true;
                clearTimeout(watchdog);
                resolve(value);
            };
            const finishReject = (err: unknown) => {
                if (settled) return;
                settled = true;
                clearTimeout(watchdog);
                reject(err);
            };

            imap.once('ready', () => {
                imap.openBox(mailbox, true, (err) => {
                    if (err) {
                        imap.end();
                        return finishReject(normalizeImapError(err, providerKey, host, port));
                    }
                    const f = imap.fetch(uid, { bodies: '' });
                    f.on('message', (msg) => {
                        msg.on('body', (stream) => {
                            simpleParser(stream as unknown as Source)
                                .then((mail: ParsedMail) => {
                                    result = {
                                        id: `imap:${uid}`,
                                        from: mail.from?.text || '',
                                        subject: mail.subject || '',
                                        text: mail.text || '',
                                        html: typeof mail.html === 'string' ? mail.html : '',
                                        date: mail.date?.toISOString() || '',
                                    };
                                })
                                .catch((parseErr: Error) => {
                                    logger.error({ parseErr }, 'Error parsing email body');
                                })
                                .finally(() => {
                                    imap.end();
                                });
                        });
                    });
                    f.once('error', (fetchErr: Error) => {
                        imap.end();
                        finishReject(normalizeImapError(fetchErr, providerKey, host, port));
                    });
                });
            });

            imap.once('error', (err: Error) => {
                logger.error({ err, host, provider: providerKey }, 'IMAP single message error');
                finishReject(normalizeImapError(err, providerKey, host, port));
            });

            imap.once('end', () => {
                if (result) {
                    finishResolve(result);
                } else {
                    finishReject(new AppError('MESSAGE_NOT_FOUND', `邮件不存在或已被删除（UID ${uid}）`, 404));
                }
            });

            imap.connect();
        });
    },

    /** Graph 拉取单封邮件正文 */
    async getMessageBodyViaGraphApi(
        accessToken: string,
        messageId: string,
        proxyConfig?: { socks5?: string; http?: string }
    ): Promise<EmailMessage> {
        const response = await proxyFetch(
            `https://graph.microsoft.com/v1.0/me/messages/${encodeURIComponent(messageId)}?$select=id,subject,from,receivedDateTime,createdDateTime,body,bodyPreview`,
            {
                method: 'GET',
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                    'Content-Type': 'application/json',
                },
            },
            proxyConfig
        );

        if (!response.ok) {
            const errorText = await response.text();
            throw new AppError('GRAPH_API_ERROR', `Graph API error: ${response.status} - ${errorText}`, 502);
        }

        const item = (await response.json()) as GraphMessage;
        return {
            id: item.id || messageId,
            from: item.from?.emailAddress?.address || '',
            subject: item.subject || '',
            text: item.bodyPreview || '',
            html: item.body?.content || '',
            date: item.createdDateTime || '',
        };
    },

    /**
     * 获取邮件（主入口）
     * - Outlook 账号：Graph API + IMAP XOAUTH2 回退（按分组策略）
     * - 第三方 IMAP 邮箱：密码/授权码直连（UID 增量）
     * - 缓存：TTL 内直接返回；过期则真实抓取并写回缓存；
     *   fresh=true 强制真实拉取（仍会写缓存）
     */
    async getEmails(
        credentials: Credentials,
        options: {
            mailbox: string;
            limit?: number;
            socks5?: string;
            http?: string;
            fresh?: boolean;
            cacheTtlSeconds?: number;
            /** 只取邮件头（不含正文），列表页秒开用 */
            headersOnly?: boolean;
        }
    ) {
        const proxyConfig = { socks5: options.socks5, http: options.http };
        const strategy: MailFetchStrategy = credentials.fetchStrategy || 'GRAPH_FIRST';
        const limit = options.limit || 100;
        const cacheTtl = options.cacheTtlSeconds ?? 0;
        const headersOnly = options.headersOnly === true;

        const wrapResult = (messages: EmailMessage[], method: string, cached: boolean, cachedAt?: Date) => ({
            email: credentials.email,
            mailbox: options.mailbox,
            count: messages.length,
            messages,
            method,
            cached,
            cachedAt: (cachedAt ?? new Date()).toISOString(),
        });

        // 读缓存：TTL 内直接返回（需要正文的调用方只接受带正文的缓存行）
        if (!options.fresh && cacheTtl > 0) {
            const cached = await mailCacheService.getFreshCache(
                credentials.id,
                options.mailbox,
                cacheTtl,
                { requireBody: !headersOnly }
            );
            if (cached) {
                logger.debug({ email: credentials.email, mailbox: options.mailbox }, 'Mail served from cache');
                // 邮件头模式不返回正文；并按 limit 截断
                const messages = headersOnly
                    ? cached.messages.map((m) => ({ ...m, text: '', html: '' }))
                    : cached.messages;
                return wrapResult(messages.slice(0, limit), 'cache', true, cached.cachedAt);
            }
        }

        // 写缓存：抓取成功后落库（内部吞错，不影响结果返回）
        const persist = (messages: EmailMessage[], meta?: ImapFetchMeta) =>
            mailCacheService.saveFetchResult(credentials.id, options.mailbox, messages, meta);

        // 合并去重：新抓取结果优先，与缓存行合并后按时间倒序取前 limit
        const mergeWithCache = async (fresh: EmailMessage[]): Promise<EmailMessage[]> => {
            const cachedRows = await mailCacheService.getRecentMessages(credentials.id, options.mailbox, limit);
            const merged = new Map<string, EmailMessage>();
            for (const m of [...fresh, ...cachedRows]) {
                if (!merged.has(m.id)) {
                    merged.set(m.id, headersOnly ? { ...m, text: '', html: '' } : m);
                }
            }
            return [...merged.values()]
                .sort((a, b) => new Date(b.date || 0).getTime() - new Date(a.date || 0).getTime())
                .slice(0, limit);
        };

        // 第三方 IMAP 邮箱：直接使用密码收信（UID 增量 + 追平）
        if (!isOutlookProvider(credentials)) {
            logger.info({ email: credentials.email, provider: credentials.provider }, 'Using generic IMAP for email retrieval');

            let fetchedMeta: ImapFetchMeta | undefined;
            const onMeta = (meta: ImapFetchMeta) => {
                fetchedMeta = headersOnly ? { ...meta, headersOnly: true } : meta;
            };
            const sync = await mailCacheService.getSyncState(credentials.id, options.mailbox);
            let freshMessages = await this.getEmailsViaGenericImap(
                credentials,
                options.mailbox,
                limit,
                sync,
                onMeta,
                headersOnly
            );

            // 增量抓取把 limit 占满：可能有更早的未拉邮件，全量追平一次
            if (sync && fetchedMeta?.full === false && freshMessages.length >= limit) {
                logger.info({ email: credentials.email }, 'Incremental fetch hit limit, doing full catch-up');
                fetchedMeta = undefined;
                freshMessages = await this.getEmailsViaGenericImap(
                    credentials,
                    options.mailbox,
                    limit,
                    null,
                    onMeta,
                    headersOnly
                );
            }

            await persist(freshMessages, fetchedMeta);
            const messages = await mergeWithCache(freshMessages);
            return wrapResult(messages, 'imap', false);
        }

        const fetchViaGraph = async () => {
            const tokenResult = await this.getGraphAccessToken(credentials, proxyConfig);
            if (!tokenResult) {
                throw new AppError('GRAPH_TOKEN_FAILED', 'Failed to get Graph API access token', 502);
            }
            if (!tokenResult.hasMailRead) {
                throw new AppError('GRAPH_SCOPE_MISSING', 'Graph token missing Mail.Read scope', 502);
            }

            logger.info({ email: credentials.email, strategy }, 'Using Graph API for email retrieval');
            const messages = await this.getEmailsViaGraphApi(
                tokenResult.accessToken,
                options.mailbox,
                limit,
                proxyConfig,
                headersOnly
            );

            await persist(messages, headersOnly ? { headersOnly: true } : undefined);
            return wrapResult(messages, 'graph_api', false);
        };

        const fetchViaImap = async () => {
            logger.info({ email: credentials.email, strategy }, 'Using IMAP for email retrieval');
            const imapToken = await this.getImapAccessToken(credentials, proxyConfig);
            if (!imapToken) {
                throw new AppError('IMAP_TOKEN_FAILED', 'Failed to get IMAP access token', 502);
            }

            const authString = this.generateAuthString(credentials.email, imapToken);
            const messages = await this.getEmailsViaImap(
                credentials.email,
                authString,
                options.mailbox,
                limit
            );

            await persist(messages);
            return wrapResult(messages, 'imap', false);
        };

        if (strategy === 'GRAPH_ONLY') {
            return fetchViaGraph();
        }

        if (strategy === 'IMAP_ONLY') {
            return fetchViaImap();
        }

        if (strategy === 'IMAP_FIRST') {
            try {
                return await fetchViaImap();
            } catch (imapErr) {
                logger.warn({ imapErr, email: credentials.email }, 'IMAP failed, fallback to Graph API');
                return fetchViaGraph();
            }
        }

        try {
            return await fetchViaGraph();
        } catch (graphErr) {
            logger.warn({ graphErr, email: credentials.email }, 'Graph API failed, fallback to IMAP');
            return fetchViaImap();
        }
    },

    /**
     * 清空邮箱（通过 Graph API 删除所有邮件，仅支持 Outlook 账号）
     */
    async processMailbox(
        credentials: Credentials,
        options: { mailbox: string; socks5?: string; http?: string }
    ) {
        if (!isOutlookProvider(credentials)) {
            throw new AppError(
                'MAILBOX_CLEAR_UNSUPPORTED',
                'Mailbox clear is only supported for Outlook accounts (Graph API)',
                400
            );
        }

        const strategy: MailFetchStrategy = credentials.fetchStrategy || 'GRAPH_FIRST';
        if (strategy === 'IMAP_ONLY') {
            throw new AppError(
                'MAILBOX_CLEAR_UNSUPPORTED',
                'Mailbox clear is not available for IMAP_ONLY strategy',
                400
            );
        }

        logger.info({ email: credentials.email, mailbox: options.mailbox }, 'Processing mailbox via Graph API');

        const proxyConfig = { socks5: options.socks5, http: options.http };
        const tokenResult = await this.getGraphAccessToken(credentials, proxyConfig);

        if (!tokenResult) {
            throw new AppError('GRAPH_API_FAILED', 'Failed to get access token', 500);
        }

        // 1. 获取所有邮件 ID
        let page = 0;
        let deletedCount = 0;
        let hasMore = true;

        try {
            while (hasMore && page < 10) { // 限制最大页数防止超时
                const messages = await this.getEmailsViaGraphApi(
                    tokenResult.accessToken,
                    options.mailbox,
                    500, // 每次取 500
                    proxyConfig
                );

                if (messages.length === 0) {
                    hasMore = false;
                    break;
                }

                // 2. 批量删除（Graph API 不支持批量删除，只能并发逐个删除）
                // 限制并发数为 10
                const batchSize = 10;
                for (let i = 0; i < messages.length; i += batchSize) {
                    const chunk = messages.slice(i, i + batchSize);
                    await Promise.all(chunk.map(msg =>
                        this.deleteMessageViaGraphApi(tokenResult.accessToken, msg.id, proxyConfig)
                    ));
                    deletedCount += chunk.length;
                }

                page++;
            }

            // 删除完成：清空该文件夹缓存与同步状态
            await mailCacheService.clearFolder(credentials.id, options.mailbox);

            return {
                email: credentials.email,
                mailbox: options.mailbox,
                message: `Successfully deleted ${deletedCount} messages`,
                status: 'success',
                deletedCount,
            };

        } catch (err: unknown) {
            logger.error({ err, email: credentials.email }, 'Error processing mailbox');
            // 部分删除也会使缓存失效
            await mailCacheService.clearFolder(credentials.id, options.mailbox);
            return {
                email: credentials.email,
                mailbox: options.mailbox,
                message: `Partial success or error: ${getErrorMessage(err)}`,
                status: 'error',
                deletedCount,
            };
        }
    },

    /**
     * 单个删除邮件
     */
    async deleteMessageViaGraphApi(
        accessToken: string,
        messageId: string,
        proxyConfig?: { socks5?: string; http?: string }
    ) {
        try {
            await proxyFetch(
                `https://graph.microsoft.com/v1.0/me/messages/${messageId}`,
                {
                    method: 'DELETE',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                    },
                },
                proxyConfig
            );
        } catch (_err) {
            // 忽略删除错误，继续下一个
            logger.warn({ messageId }, 'Failed to delete message');
        }
    },
};
