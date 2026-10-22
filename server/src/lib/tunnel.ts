import net from 'node:net';
import { logger } from './logger.js';
import {
    systemSshForward,
    systemSshSocks,
    resetSystemSsh,
    closeSystemSsh,
    testSystemSshReachability,
    type SystemSshConfig,
} from './system-ssh.js';

/**
 * 隧道门面（SSH 走系统 ssh 子进程，SOCKS5 走本地转发）
 *
 * SSH 转发统一交给 lib/system-ssh.ts（ssh -L / ssh -D 子进程）。
 * 这里只保留 SOCKS5 代理的本地 TCP 转发，供 node-imap 这类不支持代理的客户端使用。
 */

export type SshTunnelConfig = SystemSshConfig;

export interface ProxyLikeConfig {
    id: number;
    name: string;
    type: string;
}

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;

interface LocalListener {
    server: net.Server;
    port: number;
    lastUsed: number;
}

const forwarders = new Map<string, LocalListener>();
let sweepTimer: NodeJS.Timeout | null = null;

function ensureSweeper(): void {
    if (sweepTimer) {
        return;
    }
    sweepTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of forwarders) {
            if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
                entry.server.close();
                forwarders.delete(key);
                logger.debug({ key }, 'SOCKS5 forwarder closed (idle)');
            }
        }
    }, SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
}

/** 通过 SOCKS5 代理打开到目标的 TCP 连接（仅 CONNECT） */
function connectSocks5(
    socksUrl: string,
    destHost: string,
    destPort: number,
    timeoutMs = 15000
): Promise<net.Socket> {
    const parsed = new URL(socksUrl.includes('://') ? socksUrl : `socks5://${socksUrl}`);
    const host = parsed.hostname;
    const port = Number(parsed.port || 1080);
    const username = decodeURIComponent(parsed.username || '');
    const password = decodeURIComponent(parsed.password || '');

    return new Promise((resolve, reject) => {
        const socket = net.connect({ host, port });
        let settled = false;
        const fail = (err: Error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            socket.destroy();
            reject(err);
        };
        const timer = setTimeout(() => fail(new Error(`SOCKS5 代理连接超时（${host}:${port}）`)), timeoutMs);
        timer.unref?.();

        socket.once('error', (err) => fail(err));
        socket.once('connect', () => {
            const methods = username ? [0x00, 0x02] : [0x00];
            socket.write(Buffer.from([0x05, methods.length, ...methods]));
        });

        let buffer = Buffer.alloc(0);
        let stage: 'method' | 'auth' | 'reply' = 'method';

        const sendRequest = () => {
            const hostBuf = Buffer.from(destHost);
            socket.write(
                Buffer.concat([
                    Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
                    hostBuf,
                    Buffer.from([(destPort >> 8) & 0xff, destPort & 0xff]),
                ])
            );
            stage = 'reply';
        };

        const onData = (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (stage === 'method') {
                if (buffer.length < 2) return;
                const method = buffer[1];
                buffer = buffer.subarray(2);
                if (method === 0x02) {
                    if (!username) {
                        fail(new Error('SOCKS5 代理要求认证，但未配置用户名'));
                        return;
                    }
                    const u = Buffer.from(username);
                    const p = Buffer.from(password);
                    socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]));
                    stage = 'auth';
                } else if (method === 0x00) {
                    sendRequest();
                } else {
                    fail(new Error('SOCKS5 代理拒绝了可用的认证方式'));
                    return;
                }
                if (buffer.length > 0 && (stage as string) !== 'reply') onData(Buffer.alloc(0));
                return;
            }
            if (stage === 'auth') {
                if (buffer.length < 2) return;
                if (buffer[1] !== 0x00) {
                    fail(new Error('SOCKS5 用户名或密码错误'));
                    return;
                }
                buffer = buffer.subarray(2);
                sendRequest();
                if (buffer.length > 0) onData(Buffer.alloc(0));
                return;
            }
            if (buffer.length < 4) return;
            const rep = buffer[1];
            const atyp = buffer[3];
            let offset = 4;
            if (atyp === 0x01) offset += 4;
            else if (atyp === 0x03) offset += 1 + buffer[4];
            else if (atyp === 0x04) offset += 16;
            offset += 2;
            if (buffer.length < offset) return;
            if (rep !== 0x00) {
                fail(new Error(`SOCKS5 CONNECT 被拒绝（code=${rep}）`));
                return;
            }
            settled = true;
            clearTimeout(timer);
            socket.removeListener('data', onData);
            resolve(socket);
        };

        socket.on('data', onData);
    });
}

/** SOCKS5 代理的本地 TCP 转发（让 IMAP 也能走 SOCKS5） */
export async function getSocksTcpForwarder(
    socksUrl: string,
    destHost: string,
    destPort: number
): Promise<{ host: string; port: number }> {
    const safeUrl = socksUrl.replace(/\/\/[^@/]*@/, '//***@');
    const key = `socks|${safeUrl}=>${destHost}:${destPort}`;
    const existing = forwarders.get(key);
    if (existing) {
        existing.lastUsed = Date.now();
        return { host: '127.0.0.1', port: existing.port };
    }
    ensureSweeper();

    const server = net.createServer((socket) => {
        const entry = forwarders.get(key);
        if (entry) {
            entry.lastUsed = Date.now();
        }
        connectSocks5(socksUrl, destHost, destPort)
            .then((upstream) => {
                socket.on('error', () => upstream.destroy());
                upstream.on('error', () => socket.destroy());
                upstream.on('close', () => socket.destroy());
                socket.pipe(upstream).pipe(socket);
            })
            .catch((err: Error) => {
                logger.warn({ destHost, destPort, err: err.message }, 'SOCKS5 forward failed');
                socket.destroy();
            });
    });

    const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (typeof addr === 'object' && addr) {
                resolve(addr.port);
            } else {
                reject(new Error('Failed to allocate local port'));
            }
        });
    });

    forwarders.set(key, { server, port, lastUsed: Date.now() });
    logger.debug({ destHost, destPort, port }, 'SOCKS5 TCP forwarder ready');
    return { host: '127.0.0.1', port };
}

/** SSH 本地转发：统一走系统 ssh -L */
export async function getSshTcpForwarder(
    cfg: SshTunnelConfig,
    destHost: string,
    destPort: number
): Promise<{ host: string; port: number }> {
    const result = await systemSshForward(cfg, destHost, destPort);
    if (!result) {
        throw new Error(`无法建立 SSH 转发到 ${destHost}:${destPort}（请确认服务器已安装 ssh / sshpass）`);
    }
    return result;
}

/** SSH 本地 SOCKS5：统一走系统 ssh -D */
export async function getSshSocksUrl(cfg: SshTunnelConfig): Promise<string> {
    const url = await systemSshSocks(cfg);
    if (!url) {
        throw new Error('无法建立 SSH SOCKS 隧道（请确认服务器已安装 ssh / sshpass）');
    }
    return url;
}

/** 测试：经 SSH 隧道探测目标端口耗时 */
export async function testSshReachability(
    cfg: SshTunnelConfig,
    destHost: string,
    destPort: number,
    timeoutMs = 12000
): Promise<number> {
    return testSystemSshReachability(cfg, destHost, destPort, timeoutMs);
}

/** 重置某个代理配置对应的所有隧道 */
export function resetTunnel(id: string): void {
    resetSystemSsh(id);
}

/** 关闭全部隧道与本地转发 */
export async function closeAllTunnels(): Promise<void> {
    if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
    }
    for (const [, entry] of forwarders) {
        entry.server.close();
    }
    forwarders.clear();
    await closeSystemSsh();
}

export default {
    getSshTcpForwarder,
    getSshSocksUrl,
    getSocksTcpForwarder,
    testSshReachability,
    resetTunnel,
    closeAllTunnels,
};
