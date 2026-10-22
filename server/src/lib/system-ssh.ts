import net from 'node:net';
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { writeFile, chmod, mkdtemp, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { logger } from './logger.js';

/**
 * 系统 ssh 子进程隧道
 *
 * 背景：ssh2 在持续双向传输时会偶发数十秒停滞（实测同一目标 6 次中约 1–2 次），
 * 而系统 `ssh -L` / `ssh -D` 在同一网络条件下 6/6 稳定。因此优先使用系统 ssh，
 * 不可用（没有 ssh/sshpass、或建立失败）时由调用方回退到 ssh2 实现。
 */

export interface SystemSshConfig {
    id: string;
    host: string;
    port: number;
    username: string;
    password?: string;
    privateKey?: string;
    passphrase?: string;
}

interface SpawnedTunnel {
    proc: ChildProcess;
    port: number;
    lastUsed: number;
}

const tunnels = new Map<string, SpawnedTunnel>();
const keyFiles = new Map<string, string>();

let sshBinary: boolean | null = null;

function hasSsh(): boolean {
    if (sshBinary === null) {
        try {
            execFileSync('sh', ['-c', 'command -v ssh'], { stdio: 'ignore' });
            sshBinary = true;
        } catch {
            sshBinary = false;
        }
    }
    return sshBinary;
}

function hasSshpass(): boolean {
    try {
        execFileSync('sh', ['-c', 'command -v sshpass'], { stdio: 'ignore' });
        return true;
    } catch {
        return false;
    }
}

async function ensureKeyFile(cfg: SystemSshConfig): Promise<string | null> {
    if (!cfg.privateKey) {
        return null;
    }
    const cached = keyFiles.get(cfg.id);
    if (cached) {
        return cached;
    }
    const dir = await mkdtemp(join(tmpdir(), 'ogm-ssh-'));
    const file = join(dir, 'id_key');
    await writeFile(file, cfg.privateKey, { mode: 0o600 });
    await chmod(file, 0o600);
    keyFiles.set(cfg.id, file);
    return file;
}

async function allocatePort(): Promise<number | null> {
    return new Promise((resolve) => {
        const server = net.createServer();
        server.once('error', () => resolve(null));
        server.listen(0, '127.0.0.1', () => {
            const addr = server.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            server.close(() => resolve(port || null));
        });
    });
}

async function waitForPort(port: number, timeoutMs = 20000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        const ok = await new Promise<boolean>((resolve) => {
            const socket = net.connect({ host: '127.0.0.1', port });
            socket.once('connect', () => {
                socket.destroy();
                resolve(true);
            });
            socket.once('error', () => resolve(false));
            socket.setTimeout(800, () => {
                socket.destroy();
                resolve(false);
            });
        });
        if (ok) {
            return true;
        }
        await new Promise((r) => setTimeout(r, 200));
    }
    return false;
}

async function spawnTunnel(
    cfg: SystemSshConfig,
    key: string,
    localPort: number,
    forwardArgs: string[]
): Promise<boolean> {
    const baseArgs = [
        '-N',
        '-o', 'StrictHostKeyChecking=no',
        '-o', 'UserKnownHostsFile=/dev/null',
        '-o', 'ExitOnForwardFailure=yes',
        '-o', 'ServerAliveInterval=15',
        '-o', 'ServerAliveCountMax=3',
        '-o', 'ConnectTimeout=15',
        '-p', String(cfg.port),
        ...forwardArgs,
        cfg.username + '@' + cfg.host,
    ];

    const env: NodeJS.ProcessEnv = { ...process.env };
    let child: ChildProcess;

    if (cfg.privateKey) {
        const keyFile = await ensureKeyFile(cfg);
        if (!keyFile) {
            return false;
        }
        child = spawn('ssh', ['-i', keyFile, ...baseArgs], { stdio: 'ignore', env });
    } else {
        if (!hasSshpass()) {
            logger.debug('sshpass not available; system ssh password auth disabled');
            return false;
        }
        env.SSHPASS = cfg.password || '';
        child = spawn('sshpass', ['-e', 'ssh', ...baseArgs], { stdio: 'ignore', env });
    }

    const started = await new Promise<boolean>((resolve) => {
        let settled = false;
        child.once('error', (err) => {
            if (!settled) {
                settled = true;
                logger.warn({ err: err.message }, 'system ssh spawn error');
                resolve(false);
            }
        });
        child.once('exit', (code) => {
            if (!settled) {
                settled = true;
                logger.warn({ code }, 'system ssh exited before tunnel was ready');
                resolve(false);
            }
        });
        void waitForPort(localPort).then((ok) => {
            if (!settled) {
                settled = true;
                resolve(ok);
            }
        });
    });

    if (!started) {
        try {
            child.kill('SIGKILL');
        } catch {
            // ignore
        }
        return false;
    }

    tunnels.set(key, { proc: child, port: localPort, lastUsed: Date.now() });
    child.once('exit', () => {
        if (tunnels.get(key)?.proc === child) {
            tunnels.delete(key);
            logger.debug({ key }, 'system ssh tunnel exited');
        }
    });
    logger.info({ target: cfg.host, localPort }, 'system ssh tunnel ready');
    return true;
}

/** ssh -L 本地转发；失败返回 null */
export async function systemSshForward(
    cfg: SystemSshConfig,
    destHost: string,
    destPort: number
): Promise<{ host: string; port: number } | null> {
    if (!hasSsh()) {
        return null;
    }
    const key = 'sys|' + cfg.id + '|' + cfg.host + '|' + cfg.username + '=>' + destHost + ':' + destPort;
    const existing = tunnels.get(key);
    if (existing) {
        existing.lastUsed = Date.now();
        return { host: '127.0.0.1', port: existing.port };
    }
    const localPort = await allocatePort();
    if (!localPort) {
        return null;
    }
    const forward = '127.0.0.1:' + localPort + ':' + destHost + ':' + destPort;
    const ok = await spawnTunnel(cfg, key, localPort, ['-L', forward]);
    return ok ? { host: '127.0.0.1', port: localPort } : null;
}

/** ssh -D 本地 SOCKS5；失败返回 null */
export async function systemSshSocks(cfg: SystemSshConfig): Promise<string | null> {
    if (!hasSsh()) {
        return null;
    }
    const key = 'sys-socks|' + cfg.id + '|' + cfg.host + '|' + cfg.username;
    const existing = tunnels.get(key);
    if (existing) {
        existing.lastUsed = Date.now();
        return 'socks5://127.0.0.1:' + existing.port;
    }
    const localPort = await allocatePort();
    if (!localPort) {
        return null;
    }
    const ok = await spawnTunnel(cfg, key, localPort, ['-D', '127.0.0.1:' + localPort]);
    return ok ? 'socks5://127.0.0.1:' + localPort : null;
}

/** 预热：提前建立到指定目标的隧道，避免首个请求等待建连 */
export async function warmSystemSsh(
    cfg: SystemSshConfig,
    targets: Array<{ host: string; port: number }>
): Promise<void> {
    await Promise.all(targets.map((x) => systemSshForward(cfg, x.host, x.port).catch(() => null)));
}

export async function closeSystemSsh(): Promise<void> {
    for (const [, entry] of tunnels) {
        try {
            entry.proc.kill('SIGTERM');
        } catch {
            // ignore
        }
    }
    tunnels.clear();
    for (const [, file] of keyFiles) {
        try {
            await unlink(file);
        } catch {
            // ignore
        }
    }
    keyFiles.clear();
}

export default { systemSshForward, systemSshSocks, warmSystemSsh, closeSystemSsh };
