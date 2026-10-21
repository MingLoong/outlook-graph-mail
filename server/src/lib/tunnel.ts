import net from 'node:net';
import { Client, type ConnectConfig } from 'ssh2';
import { logger } from './logger.js';

/**
 * SSH / SOCKS5 隧道管理器
 *
 * 用途：让邮件系统从"中转机"出口访问 IMAP / Graph API。
 * - SSH：ssh2 建连后用 forwardOut() 建立到目标的 TCP 通道
 * - 对 node-imap（无法注入 socket）：在本机起一个 TCP 监听，把连接转发进隧道
 * - 对 HTTP（Graph API）：在本机起一个最小 SOCKS5 服务，复用既有 socks-proxy-agent 链路
 *
 * 连接按 proxyId 复用，空闲超时回收；进程退出时统一关闭。
 */

const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = 60 * 1000;
const SSH_READY_TIMEOUT_MS = 20000;

export interface SshTunnelConfig {
    /** 用于连接复用的标识（通常是代理配置 id） */
    id: string;
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
}

interface PooledClient {
    client: Client;
    ready: Promise<void>;
    lastUsed: number;
}

interface LocalListener {
    server: net.Server;
    port: number;
    lastUsed: number;
    key: string;
}

const clients = new Map<string, PooledClient>();
const tcpForwarders = new Map<string, LocalListener>();
const socksServers = new Map<string, LocalListener>();

let sweepTimer: NodeJS.Timeout | null = null;

function clientKey(cfg: SshTunnelConfig): string {
    return `${cfg.id}|${cfg.host}|${cfg.port}|${cfg.username}`;
}

function ensureSweeper(): void {
    if (sweepTimer) {
        return;
    }
    sweepTimer = setInterval(() => {
        const now = Date.now();
        for (const [key, entry] of tcpForwarders) {
            if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
                entry.server.close();
                tcpForwarders.delete(key);
                logger.debug({ key }, 'SSH TCP forwarder closed (idle)');
            }
        }
        for (const [key, entry] of socksServers) {
            if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
                entry.server.close();
                socksServers.delete(key);
                logger.debug({ key }, 'SSH SOCKS server closed (idle)');
            }
        }
        for (const [key, entry] of clients) {
            if (now - entry.lastUsed > IDLE_TIMEOUT_MS) {
                try {
                    entry.client.end();
                } catch {
                    // ignore
                }
                clients.delete(key);
                logger.debug({ key }, 'SSH client closed (idle)');
            }
        }
    }, SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
}

function dropClient(key: string): void {
    const entry = clients.get(key);
    if (entry) {
        clients.delete(key);
        try {
            entry.client.end();
        } catch {
            // ignore
        }
    }
    for (const [k, fwd] of tcpForwarders) {
        if (fwd.key === key) {
            fwd.server.close();
            tcpForwarders.delete(k);
        }
    }
    const socks = socksServers.get(key);
    if (socks) {
        socks.server.close();
        socksServers.delete(key);
    }
}

/** 取得（或建立）一条可用的 SSH 连接 */
export async function acquireSshClient(cfg: SshTunnelConfig): Promise<Client> {
    ensureSweeper();
    const key = clientKey(cfg);
    const existing = clients.get(key);
    if (existing) {
        try {
            await existing.ready;
            existing.lastUsed = Date.now();
            return existing.client;
        } catch {
            dropClient(key);
        }
    }

    const client = new Client();
    const connectConfig: ConnectConfig = {
        host: cfg.host,
        port: cfg.port,
        username: cfg.username,
        readyTimeout: SSH_READY_TIMEOUT_MS,
        keepaliveInterval: 15000,
        keepaliveCountMax: 3,
    };
    if (cfg.privateKey) {
        connectConfig.privateKey = cfg.privateKey;
        if (cfg.passphrase) {
            connectConfig.passphrase = cfg.passphrase;
        }
    } else if (cfg.password) {
        connectConfig.password = cfg.password;
    }

    const ready = new Promise<void>((resolve, reject) => {
        const onReady = () => {
            client.removeListener('error', onError);
            resolve();
        };
        const onError = (err: Error) => {
            client.removeListener('ready', onReady);
            reject(err);
        };
        client.once('ready', onReady);
        client.once('error', onError);
        try {
            client.connect(connectConfig);
        } catch (err) {
            reject(err as Error);
        }
    });

    clients.set(key, { client, ready, lastUsed: Date.now() });

    client.on('close', () => {
        logger.debug({ key }, 'SSH connection closed');
        dropClient(key);
    });
    client.on('error', (err: Error) => {
        logger.warn({ key, err: err.message }, 'SSH connection error');
        dropClient(key);
    });

    await ready;
    logger.info({ host: cfg.host, port: cfg.port, user: cfg.username }, 'SSH tunnel connected');
    return client;
}

/** 通过 SSH 打开到目标的 TCP 通道（带超时，避免通道被拒时静默挂起） */
function openSshChannel(
    client: Client,
    destHost: string,
    destPort: number,
    timeoutMs = 15000
): Promise<unknown> {
    return new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(`SSH 通道建立超时（${destHost}:${destPort} 超过 ${timeoutMs}ms）`));
        }, timeoutMs);
        timer.unref?.();

        client.forwardOut('127.0.0.1', 0, destHost, destPort, (err, stream) => {
            if (settled) {
                // 超时后才返回的通道直接关闭，避免泄漏
                stream?.close?.();
                return;
            }
            settled = true;
            clearTimeout(timer);
            if (err) {
                reject(err);
                return;
            }
            resolve(stream);
        });
    });
}

/**
 * 建立一个本地 TCP 监听，把连接转发到 destHost:destPort。
 * 返回本地可连接地址，供 node-imap 这类无法注入 socket 的客户端使用。
 */
export async function getSshTcpForwarder(
    cfg: SshTunnelConfig,
    destHost: string,
    destPort: number
): Promise<{ host: string; port: number }> {
    const key = `${clientKey(cfg)}=>${destHost}:${destPort}`;
    const existing = tcpForwarders.get(key);
    if (existing) {
        existing.lastUsed = Date.now();
        return { host: '127.0.0.1', port: existing.port };
    }

    const client = await acquireSshClient(cfg);
    const server = net.createServer((socket) => {
        const entry = tcpForwarders.get(key);
        if (entry) {
            entry.lastUsed = Date.now();
        }
        openSshChannel(client, destHost, destPort)
            .then((channel) => {
                const stream = channel as unknown as net.Socket;
                socket.on('error', () => stream.destroy());
                stream.on('error', () => socket.destroy());
                stream.on('close', () => socket.destroy());
                socket.pipe(stream).pipe(socket);
            })
            .catch((err: Error) => {
                logger.warn({ destHost, destPort, err: err.message }, 'SSH forwardOut failed, resetting tunnel');
                socket.destroy();
                // 通道建立失败通常意味着 SSH 会话已不可用（会话数耗尽/连接半死），
                // 立即丢弃并让下一次请求重新建连，避免连续失败
                dropClient(clientKey(cfg));
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

    tcpForwarders.set(key, { server, port, lastUsed: Date.now(), key: clientKey(cfg) });
    logger.debug({ destHost, destPort, port }, 'SSH TCP forwarder ready');
    return { host: '127.0.0.1', port };
}

/** 在本地起一个最小 SOCKS5 服务（仅 CONNECT），用于 HTTP/HTTPS 走 SSH 出口 */
export async function getSshSocksUrl(cfg: SshTunnelConfig): Promise<string> {
    const key = clientKey(cfg);
    const existing = socksServers.get(key);
    if (existing) {
        existing.lastUsed = Date.now();
        return `socks5://127.0.0.1:${existing.port}`;
    }

    const client = await acquireSshClient(cfg);

    const server = net.createServer((socket) => {
        const entry = socksServers.get(key);
        if (entry) {
            entry.lastUsed = Date.now();
        }
        let buffer = Buffer.alloc(0);
        let stage: 'greeting' | 'request' | 'piping' = 'greeting';

        const onData = (chunk: Buffer) => {
            buffer = Buffer.concat([buffer, chunk]);
            if (stage === 'greeting') {
                if (buffer.length < 2) return;
                const methodCount = buffer[1];
                if (buffer.length < 2 + methodCount) return;
                buffer = buffer.subarray(2 + methodCount);
                socket.write(Buffer.from([0x05, 0x00]));
                stage = 'request';
                if (buffer.length > 0) onData(Buffer.alloc(0));
                return;
            }
            if (stage === 'request') {
                if (buffer.length < 5) return;
                const cmd = buffer[1];
                const atyp = buffer[3];
                let offset = 4;
                let host = '';
                if (atyp === 0x01) {
                    if (buffer.length < 4 + 4 + 2) return;
                    host = `${buffer[4]}.${buffer[5]}.${buffer[6]}.${buffer[7]}`;
                    offset = 8;
                } else if (atyp === 0x03) {
                    const len = buffer[4];
                    if (buffer.length < 5 + len + 2) return;
                    host = buffer.subarray(5, 5 + len).toString('utf8');
                    offset = 5 + len;
                } else if (atyp === 0x04) {
                    if (buffer.length < 4 + 16 + 2) return;
                    const parts: string[] = [];
                    for (let i = 0; i < 16; i += 2) {
                        parts.push(buffer.readUInt16BE(4 + i).toString(16));
                    }
                    host = parts.join(':');
                    offset = 20;
                } else {
                    socket.destroy();
                    return;
                }
                const port = buffer.readUInt16BE(offset);
                buffer = buffer.subarray(offset + 2);
                stage = 'piping';
                socket.removeListener('data', onData);

                if (cmd !== 0x01) {
                    socket.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                    socket.destroy();
                    return;
                }

                openSshChannel(client, host, port)
                    .then((channel) => {
                        const stream = channel as net.Socket;
                        socket.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                        stream.on('error', () => socket.destroy());
                        stream.on('close', () => socket.destroy());
                        socket.on('error', () => stream.destroy());
                        if (buffer.length > 0) {
                            stream.write(buffer);
                        }
                        socket.pipe(stream).pipe(socket);
                    })
                    .catch((err: Error) => {
                        logger.warn({ host, port, err: err.message }, 'SSH SOCKS CONNECT failed');
                        socket.write(Buffer.from([0x05, 0x05, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
                        socket.destroy();
                    });
            }
        };

        socket.on('data', onData);
        socket.on('error', () => socket.destroy());
    });

    const port = await new Promise<number>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            if (typeof addr === 'object' && addr) {
                resolve(addr.port);
            } else {
                reject(new Error('Failed to allocate local socks port'));
            }
        });
    });

    socksServers.set(key, { server, port, lastUsed: Date.now(), key });
    logger.debug({ port }, 'SSH SOCKS5 server ready');
    return `socks5://127.0.0.1:${port}`;
}

/** 测试用：直接探测目标端口是否可达（不建本地监听） */
export async function testSshReachability(
    cfg: SshTunnelConfig,
    destHost: string,
    destPort: number,
    timeoutMs = 12000
): Promise<number> {
    const client = await acquireSshClient(cfg);
    const started = Date.now();
    await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`连接 ${destHost}:${destPort} 超时`)), timeoutMs);
        openSshChannel(client, destHost, destPort)
            .then((channel) => {
                clearTimeout(timer);
                const stream = channel as NodeJS.ReadWriteStream & { destroy?: () => void };
                stream.destroy?.();
                resolve();            })
            .catch((err: Error) => {
                clearTimeout(timer);
                reject(err);
            });
    });
    return Date.now() - started;
}

export function resetTunnel(id: string): void {
    for (const key of [...clients.keys()]) {
        if (key.startsWith(`${id}|`)) {
            dropClient(key);
        }
    }
}

export async function closeAllTunnels(): Promise<void> {
    if (sweepTimer) {
        clearInterval(sweepTimer);
        sweepTimer = null;
    }
    for (const [, entry] of tcpForwarders) {
        entry.server.close();
    }
    tcpForwarders.clear();
    for (const [, entry] of socksServers) {
        entry.server.close();
    }
    socksServers.clear();
    for (const [, entry] of clients) {
        try {
            entry.client.end();
        } catch {
            // ignore
        }
    }
    clients.clear();
}

export default { acquireSshClient, getSshTcpForwarder, getSshSocksUrl, testSshReachability, resetTunnel, closeAllTunnels };
