import net from 'node:net';
import { prisma } from '../../lib/prisma.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { logger } from '../../lib/logger.js';
import {
    getSshSocksUrl,
    getSshTcpForwarder,
    getSocksTcpForwarder,
    resetTunnel,
    testSshReachability,
    type SshTunnelConfig,
} from '../../lib/tunnel.js';
import { AppError } from '../../plugins/error.js';

type ProxyRow = {
    id: number;
    name: string;
    type: string;
    url: string | null;
    sshHost: string | null;
    sshPort: number;
    sshUser: string | null;
    authType: string;
    password: string | null;
    privateKey: string | null;
    passphrase: string | null;
    enabled: boolean;
    lastCheckedAt: Date | null;
    lastError: string | null;
};

/** 运行时视图：IMAP 走隧道，HTTP 走 socks/http 代理 */
export interface ProxyRuntime {
    id: number;
    name: string;
    type: string;
    /** 把 IMAP 目标地址转换成可达的本地地址（SSH 才有） */
    imapEndpoint?: (host: string, port: number) => Promise<{ host: string; port: number }>;
    /** Graph / HTTP 请求使用的代理参数 */
    httpProxy?: () => Promise<{ socks5?: string; http?: string }>;
}

function safeDecrypt(value: string | null): string | undefined {
    if (!value) {
        return undefined;
    }
    try {
        return decrypt(value);
    } catch (err) {
        logger.warn({ err }, 'Failed to decrypt proxy secret');
        return undefined;
    }
}

function toPublic(row: ProxyRow) {
    let keyFingerprint = '';
    if (row.privateKey) {
        const plain = safeDecrypt(row.privateKey);
        if (plain) {
            const lines = plain.trim().split('\n');
            keyFingerprint = lines.length > 1 ? `${lines[0].slice(0, 40)}… (${lines.length - 2} 行)` : '已配置';
        }
    }
    return {
        id: row.id,
        name: row.name,
        type: row.type,
        url: row.url,
        sshHost: row.sshHost,
        sshPort: row.sshPort,
        sshUser: row.sshUser,
        authType: row.authType,
        enabled: row.enabled,
        hasPassword: Boolean(row.password),
        hasPrivateKey: Boolean(row.privateKey),
        hasPassphrase: Boolean(row.passphrase),
        privateKeyPreview: keyFingerprint,
        lastCheckedAt: row.lastCheckedAt,
        lastError: row.lastError,
        createdAt: (row as unknown as { createdAt: Date }).createdAt,
        updatedAt: (row as unknown as { updatedAt: Date }).updatedAt,
    };
}

function buildTunnelConfig(row: ProxyRow): SshTunnelConfig {
    if (row.type !== 'SSH' || !row.sshHost || !row.sshUser) {
        throw new AppError('PROXY_CONFIG_INVALID', 'SSH 代理配置不完整', 400);
    }
    const cfg: SshTunnelConfig = {
        id: String(row.id),
        host: row.sshHost,
        port: row.sshPort || 22,
        username: row.sshUser,
    };
    if (row.authType === 'PASSWORD') {
        const pwd = safeDecrypt(row.password);
        if (!pwd) {
            throw new AppError('PROXY_SECRET_MISSING', 'SSH 密码缺失或无法解密', 400);
        }
        cfg.password = pwd;
    } else {
        const key = safeDecrypt(row.privateKey);
        if (!key) {
            throw new AppError('PROXY_SECRET_MISSING', 'SSH 私钥缺失或无法解密', 400);
        }
        cfg.privateKey = key;
        const passphrase = safeDecrypt(row.passphrase);
        if (passphrase) {
            cfg.passphrase = passphrase;
        }
    }
    return cfg;
}

export const proxyService = {
    async list() {
        const rows = (await prisma.proxyConfig.findMany({ orderBy: { id: 'asc' } })) as unknown as ProxyRow[];
        return rows.map(toPublic);
    },

    async getById(id: number) {
        const row = (await prisma.proxyConfig.findUnique({ where: { id } })) as unknown as ProxyRow | null;
        if (!row) {
            throw new AppError('PROXY_NOT_FOUND', '代理配置不存在', 404);
        }
        return row;
    },

    async create(input: {
        name: string;
        type?: string;
        url?: string;
        sshHost?: string;
        sshPort?: number;
        sshUser?: string;
        authType?: string;
        password?: string;
        privateKey?: string;
        passphrase?: string;
        enabled?: boolean;
    }) {
        const exists = await prisma.proxyConfig.findUnique({ where: { name: input.name } });
        if (exists) {
            throw new AppError('PROXY_NAME_EXISTS', '代理名称已存在', 409);
        }
        const row = await prisma.proxyConfig.create({
            data: {
                name: input.name,
                type: input.type || 'SSH',
                url: input.url || null,
                sshHost: input.sshHost || null,
                sshPort: input.sshPort || 22,
                sshUser: input.sshUser || null,
                authType: input.authType || 'KEY',
                password: input.password ? encrypt(input.password) : null,
                privateKey: input.privateKey ? encrypt(input.privateKey) : null,
                passphrase: input.passphrase ? encrypt(input.passphrase) : null,
                enabled: input.enabled !== false,
            },
        });
        resetTunnel(String(row.id));
        return toPublic(row as unknown as ProxyRow);
    },

    async update(
        id: number,
        input: {
            name?: string;
            type?: string;
            url?: string | null;
            sshHost?: string;
            sshPort?: number;
            sshUser?: string;
            authType?: string;
            password?: string;
            privateKey?: string;
            passphrase?: string;
            enabled?: boolean;
        }
    ) {
        await this.getById(id);
        const data: Record<string, unknown> = {};
        if (input.name !== undefined) data.name = input.name;
        if (input.type !== undefined) data.type = input.type;
        if (input.url !== undefined) data.url = input.url || null;
        if (input.sshHost !== undefined) data.sshHost = input.sshHost || null;
        if (input.sshPort !== undefined) data.sshPort = input.sshPort;
        if (input.sshUser !== undefined) data.sshUser = input.sshUser || null;
        if (input.authType !== undefined) data.authType = input.authType;
        if (input.enabled !== undefined) data.enabled = input.enabled;
        // 空字符串表示"保留原值"，显式 null 表示清空
        if (input.password) data.password = encrypt(input.password);
        if (input.privateKey) data.privateKey = encrypt(input.privateKey);
        if (input.passphrase) data.passphrase = encrypt(input.passphrase);

        const row = await prisma.proxyConfig.update({ where: { id }, data });
        resetTunnel(String(id));
        return toPublic(row as unknown as ProxyRow);
    },

    async remove(id: number) {
        await this.getById(id);
        await prisma.proxyConfig.delete({ where: { id } });
        resetTunnel(String(id));
    },

    /** 交给邮件链路使用的运行时对象；未配置或禁用时返回 null（直连） */
    async resolveRuntime(proxyId?: number | null): Promise<ProxyRuntime | null> {
        if (!proxyId) {
            return null;
        }
        let row: ProxyRow | null = null;
        try {
            row = (await prisma.proxyConfig.findUnique({ where: { id: proxyId } })) as unknown as ProxyRow | null;
        } catch (err) {
            logger.warn({ err, proxyId }, 'Failed to load proxy config');
            return null;
        }
        if (!row || !row.enabled) {
            return null;
        }
        if (row.type === 'SOCKS5') {
            const url = row.url || '';
            return {
                id: row.id,
                name: row.name,
                type: 'SOCKS5',
                // SOCKS5 同时支持 HTTP（走 socks-proxy-agent）和 IMAP（走本地 TCP 转发）
                imapEndpoint: (host: string, port: number) => getSocksTcpForwarder(url, host, port),
                httpProxy: async () => ({ socks5: url }),
            };
        }
        if (row.type === 'HTTP') {
            const url = row.url || '';
            return { id: row.id, name: row.name, type: 'HTTP', httpProxy: async () => ({ http: url }) };
        }
        const cfg = buildTunnelConfig(row);
        return {
            id: row.id,
            name: row.name,
            type: 'SSH',
            imapEndpoint: (host: string, port: number) => getSshTcpForwarder(cfg, host, port),
            httpProxy: async () => ({ socks5: await getSshSocksUrl(cfg) }),
        };
    },

    /** 测试连接：SSH 登录 + 目标端口探测 */
    async test(id: number, targets?: Array<{ host: string; port: number }>) {
        const row = await this.getById(id);
        const probeTargets = targets && targets.length > 0
            ? targets
            : [
                  { host: 'imap.qiye.aliyun.com', port: 993 },
                  { host: 'imap.gmail.com', port: 993 },
              ];
        const results: Array<{ host: string; port: number; ok: boolean; ms?: number; error?: string }> = [];
        let loginOk = false;
        let loginError: string | undefined;

        try {
            if (row.type === 'SSH') {
                const cfg = buildTunnelConfig(row);
                resetTunnel(String(row.id));
                for (const target of probeTargets) {
                    try {
                        const ms = await testSshReachability(cfg, target.host, target.port);
                        loginOk = true;
                        results.push({ host: target.host, port: target.port, ok: true, ms });
                    } catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        if (!loginOk && !loginError) {
                            loginError = message;
                        }
                        results.push({ host: target.host, port: target.port, ok: false, error: message });
                    }
                }
            } else {
                const url = row.url || '';
                if (!url) {
                    throw new AppError('PROXY_CONFIG_INVALID', '代理地址为空', 400);
                }
                // SOCKS5 / HTTP 代理只服务 HTTP 类请求，这里校验地址格式并做一次代理连通性探测
                const parsed = new URL(url.includes('://') ? url : `http://${url}`);
                if (!parsed.hostname || !parsed.port) {
                    throw new AppError('PROXY_CONFIG_INVALID', '代理地址需要包含主机和端口', 400);
                }
                for (const target of probeTargets) {
                    const started = Date.now();
                    try {
                        await new Promise<void>((resolve, reject) => {
                            const socket = net.connect({
                                host: parsed.hostname,
                                port: Number(parsed.port),
                                timeout: 10000,
                            });
                            socket.once('connect', () => {
                                socket.destroy();
                                resolve();
                            });
                            socket.once('timeout', () => {
                                socket.destroy();
                                reject(new Error(`代理 ${parsed.hostname}:${parsed.port} 连接超时`));
                            });
                            socket.once('error', (err) => reject(err));
                        });
                        loginOk = true;
                        results.push({ host: target.host, port: target.port, ok: true, ms: Date.now() - started });
                    } catch (err) {
                        const message = err instanceof Error ? err.message : String(err);
                        results.push({ host: target.host, port: target.port, ok: false, error: message });
                    }
                }
            }
        } catch (err) {
            loginError = err instanceof Error ? err.message : String(err);
        }

        const allOk = results.length > 0 && results.every((r) => r.ok);
        await prisma.proxyConfig.update({
            where: { id },
            data: {
                lastCheckedAt: new Date(),
                lastError: allOk ? null : loginError || results.find((r) => !r.ok)?.error || '测试失败',
            },
        });

        return {
            ok: allOk,
            type: row.type,
            loginOk,
            loginError,
            // 注意：不返回主机密码、私钥等敏感信息
            host: row.sshHost,
            port: row.sshPort,
            user: row.sshUser,
            targets: results,
        };
    },
};

export default proxyService;
