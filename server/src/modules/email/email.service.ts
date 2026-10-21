import prisma from '../../lib/prisma.js';
import { encrypt, decrypt } from '../../lib/crypto.js';
import { AppError } from '../../plugins/error.js';
import { inferProviderFromEmail, getProviderConfig } from '../mail/providers.js';
import { mailCacheService } from '../mail/mail-cache.service.js';
import type { Prisma } from '@prisma/client';
import type { CreateEmailInput, UpdateEmailInput, ListEmailInput, ImportEmailInput } from './email.schema.js';

export const emailService = {
    /**
     * 获取邮箱列表
     */
    async list(input: ListEmailInput) {
        const { page, pageSize, status, provider, keyword, groupId, groupName } = input;
        const skip = (page - 1) * pageSize;

        const where: Prisma.EmailAccountWhereInput = {};
        if (status) where.status = status;
        if (provider) where.provider = provider;
        if (keyword) {
            where.email = { contains: keyword };
        }
        if (groupId) {
            where.groupId = groupId;
        } else if (groupName) {
            where.group = { name: groupName };
        }

        const [list, total] = await Promise.all([
            prisma.emailAccount.findMany({
                where,
                select: {
                    id: true,
                    email: true,
                    provider: true,
                    clientId: true,
                    imapHost: true,
                    imapPort: true,
                    proxyId: true,
                    status: true,
                    groupId: true,
                    group: { select: { id: true, name: true, fetchStrategy: true } },
                    lastCheckAt: true,
                    tokenRefreshedAt: true,
                    errorMessage: true,
                    createdAt: true,
                },
                skip,
                take: pageSize,
                orderBy: { id: 'desc' },
            }),
            prisma.emailAccount.count({ where }),
        ]);

        return { list, total, page, pageSize };
    },

    /**
     * 获取邮箱详情
     */
    async getById(id: number, includeSecrets = false) {
        const email = await prisma.emailAccount.findUnique({
            where: { id },
            select: {
                id: true,
                email: true,
                provider: true,
                clientId: true,
                password: !!includeSecrets,
                refreshToken: !!includeSecrets,
                imapHost: true,
                imapPort: true,
                proxyId: true,
                status: true,
                groupId: true,
                group: { select: { id: true, name: true, fetchStrategy: true } },
                lastCheckAt: true,
                tokenRefreshedAt: true,
                errorMessage: true,
                createdAt: true,
                updatedAt: true,
            },
        });

        if (!email) {
            throw new AppError('NOT_FOUND', 'Email account not found', 404);
        }

        // 解密敏感信息
        if (includeSecrets) {
            return {
                ...email,
                refreshToken: email.refreshToken ? decrypt(email.refreshToken) : email.refreshToken,
                password: email.password ? decrypt(email.password) : email.password,
            };
        }

        return email;
    },

    /**
     * 根据邮箱地址获取（用于外部 API）
     */
    async getByEmail(emailAddress: string) {
        const email = await prisma.emailAccount.findUnique({
            where: { email: emailAddress },
            select: {
                id: true,
                email: true,
                provider: true,
                clientId: true,
                refreshToken: true,
                password: true,
                imapHost: true,
                imapPort: true,
                proxyId: true,
                status: true,
                groupId: true,
                group: {
                    select: {
                        fetchStrategy: true,
                    },
                },
            },
        });

        if (!email) {
            return null;
        }

        // 解密
        return {
            ...email,
            refreshToken: email.refreshToken ? decrypt(email.refreshToken) : undefined,
            password: email.password ? decrypt(email.password) : undefined,
            fetchStrategy: email.group?.fetchStrategy || 'GRAPH_FIRST',
        };
    },

    /**
     * 创建邮箱账户
     */
    async create(input: CreateEmailInput) {
        const { email, provider, clientId, refreshToken, password, imapHost, imapPort, groupId, proxyId } = input;

        const exists = await prisma.emailAccount.findUnique({ where: { email } });
        if (exists) {
            throw new AppError('DUPLICATE_EMAIL', 'Email already exists', 400);
        }

        const providerConfig = getProviderConfig(provider);
        if (!providerConfig) {
            throw new AppError('UNKNOWN_PROVIDER', `Unknown provider: ${provider}`, 400);
        }

        const data: Prisma.EmailAccountUncheckedCreateInput = {
            email,
            provider,
            status: 'ACTIVE',
            imapPort: imapPort ?? providerConfig.imapPort ?? 993,
            groupId: groupId || null,
            proxyId: proxyId ?? null,
        };

        if (provider === 'outlook') {
            data.clientId = clientId!;
            data.refreshToken = encrypt(refreshToken!);
            if (password) data.password = encrypt(password);
        } else {
            data.password = encrypt(password!);
            data.imapHost = imapHost || providerConfig.imapHost;
        }

        const account = await prisma.emailAccount.create({
            data,
            select: {
                id: true,
                email: true,
                provider: true,
                clientId: true,
                imapHost: true,
                imapPort: true,
                proxyId: true,
                status: true,
                groupId: true,
                createdAt: true,
            },
        });

        return account;
    },

    /**
     * 更新邮箱账户
     */
    async update(id: number, input: UpdateEmailInput) {
        const exists = await prisma.emailAccount.findUnique({ where: { id } });
        if (!exists) {
            throw new AppError('NOT_FOUND', 'Email account not found', 404);
        }

        const { provider, refreshToken, password, clientId, imapHost, imapPort, proxyId, ...rest } = input;
        const updateData: Prisma.EmailAccountUpdateInput = { ...rest };

        // 处理提供商变更或保留原值
        const nextProvider = provider || exists.provider;
        updateData.provider = nextProvider;
        if (proxyId !== undefined) {
            updateData.proxy = proxyId === null ? { disconnect: true } : { connect: { id: proxyId } };
        }

        const providerConfig = getProviderConfig(nextProvider);
        if (!providerConfig) {
            throw new AppError('UNKNOWN_PROVIDER', `Unknown provider: ${nextProvider}`, 400);
        }

        if (nextProvider === 'outlook') {
            if (clientId !== undefined) updateData.clientId = clientId;
            if (refreshToken) updateData.refreshToken = encrypt(refreshToken);
            if (password) updateData.password = encrypt(password);
        } else {
            if (password) updateData.password = encrypt(password);
            if (imapHost !== undefined) updateData.imapHost = imapHost;
            if (imapPort !== undefined) updateData.imapPort = imapPort;
        }

        const account = await prisma.emailAccount.update({
            where: { id },
            data: updateData,
            select: {
                id: true,
                email: true,
                provider: true,
                clientId: true,
                imapHost: true,
                imapPort: true,
                proxyId: true,
                status: true,
                updatedAt: true,
            },
        });

        return account;
    },

    /**
     * 更新邮箱状态
     */
    async updateStatus(id: number, status: 'ACTIVE' | 'ERROR' | 'DISABLED', errorMessage?: string | null) {
        await prisma.emailAccount.update({
            where: { id },
            data: {
                status,
                errorMessage: errorMessage || null,
                lastCheckAt: new Date(),
            },
        });
    },

    /**
     * 仅更新时间，不改动邮箱状态
     */
    async touchLastCheckAt(id: number) {
        await prisma.emailAccount.update({
            where: { id },
            data: {
                lastCheckAt: new Date(),
            },
        });
    },

    /**
     * 删除邮箱账户
     */
    async delete(id: number) {
        const exists = await prisma.emailAccount.findUnique({ where: { id } });
        if (!exists) {
            throw new AppError('NOT_FOUND', 'Email account not found', 404);
        }

        await prisma.emailAccount.delete({ where: { id } });
        await mailCacheService.clearAccountCache(id);
        return { success: true };
    },

    /**
     * 批量删除
     */
    async batchDelete(ids: number[]) {
        await prisma.emailAccount.deleteMany({
            where: { id: { in: ids } },
        });
        for (const id of ids) {
            await mailCacheService.clearAccountCache(id);
        }
        return { deleted: ids.length };
    },

    /**
     * 批量导入
     */
    async import(input: ImportEmailInput) {
        const { content, separator, provider: importProvider, groupId } = input;
        const lines = content.split('\n').filter((line: string) => line.trim());

        if (groupId !== undefined) {
            const group = await prisma.emailGroup.findUnique({ where: { id: groupId } });
            if (!group) {
                throw new AppError('GROUP_NOT_FOUND', 'Email group not found', 404);
            }
        }

        let success = 0;
        let failed = 0;
        const errors: string[] = [];

        for (const line of lines) {
            try {
                const parts = line.trim().split(separator);
                if (parts.length < 2) {
                    throw new Error('Invalid format');
                }

                const email = parts[0].trim();
                if (!email || !email.includes('@')) {
                    throw new Error('Invalid email address');
                }

                // 确定提供商：auto 模式按域名推断，否则使用指定值
                const provider = importProvider === 'auto'
                    ? (inferProviderFromEmail(email) || 'outlook')
                    : importProvider;

                const providerConfig = getProviderConfig(provider);
                if (!providerConfig) {
                    throw new Error(`Unknown provider: ${provider}`);
                }

                const data: Prisma.EmailAccountUncheckedUpdateInput = {
                    provider,
                    status: 'ACTIVE',
                };
                if (groupId !== undefined) data.groupId = groupId;

                if (provider === 'outlook') {
                    // Outlook OAuth 格式：
                    // 1. email----clientId----refreshToken (3列)
                    // 2. email----password----clientId----refreshToken (4列)
                    // 3. email----clientId----uuid----info----refreshToken (5列)
                    let clientId: string | undefined;
                    let refreshToken: string | undefined;
                    let password: string | undefined;

                    if (parts.length >= 5) {
                        clientId = parts[1];
                        refreshToken = parts[4];
                    } else if (parts.length === 4) {
                        password = parts[1];
                        clientId = parts[2];
                        refreshToken = parts[3];
                    } else {
                        clientId = parts[1];
                        refreshToken = parts[2];
                    }

                    if (!clientId || !refreshToken) {
                        throw new Error('Missing clientId or refreshToken for Outlook account');
                    }

                    data.clientId = clientId;
                    data.refreshToken = encrypt(refreshToken);
                    if (password) data.password = encrypt(password);
                } else {
                    // 第三方 IMAP 格式：
                    // 1. email----password (2列)
                    // 2. email----password----imapHost----imapPort (4列, custom 需要)
                    const password = parts[1];
                    if (!password) {
                        throw new Error('Missing password for IMAP account');
                    }
                    data.password = encrypt(password);

                    if (parts.length >= 4) {
                        const host = parts[2];
                        const port = parseInt(parts[3], 10);
                        if (!host) throw new Error('Missing imapHost');
                        data.imapHost = host;
                        if (!Number.isNaN(port) && port > 0) data.imapPort = port;
                    } else {
                        data.imapHost = providerConfig.imapHost;
                    }
                }

                // 检查是否存在
                const exists = await prisma.emailAccount.findUnique({ where: { email } });
                if (exists) {
                    // 更新
                    await prisma.emailAccount.update({
                        where: { email },
                        data,
                    });
                } else {
                    // 创建
                    const createData: Prisma.EmailAccountUncheckedCreateInput = {
                        email,
                        provider,
                        status: 'ACTIVE',
                        imapPort: (data.imapPort as number) || providerConfig.imapPort || 993,
                    };
                    if (data.clientId) createData.clientId = data.clientId as string;
                    if (data.refreshToken) createData.refreshToken = data.refreshToken as string;
                    if (data.password) createData.password = data.password as string;
                    if (data.imapHost) createData.imapHost = data.imapHost as string;
                    if (groupId !== undefined) createData.groupId = groupId;
                    await prisma.emailAccount.create({
                        data: createData,
                    });
                }
                success++;
            } catch (err) {
                failed++;
                errors.push(`Line "${line.substring(0, 30)}...": ${(err as Error).message}`);
            }
        }

        return { success, failed, errors };
    },

    /**
     * 导出
     */
    async export(ids?: number[], separator = '----', groupId?: number) {
        const where: Prisma.EmailAccountWhereInput = {};
        if (ids?.length) {
            where.id = { in: ids };
        }
        if (groupId !== undefined) {
            where.groupId = groupId;
        }

        const accounts = await prisma.emailAccount.findMany({
            where,
            select: {
                email: true,
                provider: true,
                clientId: true,
                refreshToken: true,
                password: true,
                imapHost: true,
                imapPort: true,
                proxyId: true,
            },
        });

        const lines = accounts.map((acc: {
            email: string;
            provider: string;
            clientId: string | null;
            refreshToken: string | null;
            password: string | null;
            imapHost: string | null;
            imapPort: number;
        }) => {
            if (acc.provider === 'outlook') {
                const token = acc.refreshToken ? decrypt(acc.refreshToken) : '';
                return `${acc.email}${separator}${acc.clientId || ''}${separator}${token}`;
            } else {
                const password = acc.password ? decrypt(acc.password) : '';
                if (acc.provider === 'custom' && acc.imapHost) {
                    return `${acc.email}${separator}${password}${separator}${acc.imapHost}${separator}${acc.imapPort}`;
                }
                return `${acc.email}${separator}${password}`;
            }
        });

        return lines.join('\n');
    },

    /**
     * 获取统计
     */
    async getStats() {
        const [total, active, error] = await Promise.all([
            prisma.emailAccount.count(),
            prisma.emailAccount.count({ where: { status: 'ACTIVE' } }),
            prisma.emailAccount.count({ where: { status: 'ERROR' } }),
        ]);

        return { total, active, error };
    },
};
