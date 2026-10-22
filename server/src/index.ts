import { buildApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './lib/logger.js';
import prisma from './lib/prisma.js';
import { startApiLogRetentionJob } from './jobs/api-log-retention.js';
import { startTokenRefreshJob } from './jobs/token-refresh.js';
import { startMailCacheCleanupJob } from './jobs/mail-cache-retention.js';
import { closeAllTunnels } from './lib/tunnel.js';
import { closeSystemSsh } from './lib/system-ssh.js';

async function main() {
    const app = await buildApp();
    let stopApiLogRetentionJob = () => {};
    let stopTokenRefreshJob = () => {};
    let stopMailCacheCleanupJob = () => {};

    // 优雅关闭
    const shutdown = async () => {
        logger.info('Shutting down...');
        stopApiLogRetentionJob();
        stopTokenRefreshJob();
        stopMailCacheCleanupJob();
        await closeAllTunnels();
        await closeSystemSsh();
        await app.close();
        await prisma.$disconnect();
        process.exit(0);
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    try {
        // 测试数据库连接
        await prisma.$connect();
        logger.info('Database connected');
        stopApiLogRetentionJob = startApiLogRetentionJob();
        stopTokenRefreshJob = startTokenRefreshJob();
        stopMailCacheCleanupJob = startMailCacheCleanupJob();

        // 启动服务器
        await app.listen({ port: env.PORT, host: '0.0.0.0' });
        logger.info(`Server running at http://localhost:${env.PORT}`);
    } catch (err) {
        logger.error({ err }, 'Failed to start server');
        process.exit(1);
    }
}

void main();
