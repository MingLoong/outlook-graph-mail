import { type FastifyPluginAsync } from 'fastify';
import { proxyService } from './proxy.service.js';
import { createProxySchema, updateProxySchema, testProxySchema } from './proxy.schema.js';

const proxyRoutes: FastifyPluginAsync = async (fastify) => {
    fastify.addHook('preHandler', fastify.authenticateJwt);

    // 代理配置列表
    fastify.get('/', async () => {
        const list = await proxyService.list();
        return { success: true, data: list };
    });

    // 创建代理配置
    fastify.post('/', async (request) => {
        const input = createProxySchema.parse(request.body);
        const proxy = await proxyService.create(input);
        request.log.info({
            systemEvent: true,
            action: 'proxy.create',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
            proxyId: proxy.id,
            proxyName: proxy.name,
            proxyType: proxy.type,
        }, '新增代理配置');
        return { success: true, data: proxy };
    });

    // 更新代理配置
    fastify.put<{ Params: { id: string } }>('/:id', async (request) => {
        const id = parseInt(request.params.id, 10);
        const input = updateProxySchema.parse(request.body);
        const proxy = await proxyService.update(id, input);
        request.log.info({
            systemEvent: true,
            action: 'proxy.update',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
            proxyId: proxy.id,
            proxyName: proxy.name,
        }, '修改代理配置');
        return { success: true, data: proxy };
    });

    // 删除代理配置
    fastify.delete<{ Params: { id: string } }>('/:id', async (request) => {
        const id = parseInt(request.params.id, 10);
        await proxyService.remove(id);
        request.log.info({
            systemEvent: true,
            action: 'proxy.delete',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
            proxyId: id,
        }, '删除代理配置');
        return { success: true, data: { id } };
    });

    // 测试连接：SSH 登录 + 目标端口探测
    fastify.post<{ Params: { id: string } }>('/:id/test', async (request) => {
        const id = parseInt(request.params.id, 10);
        const input = testProxySchema.parse(request.body ?? {});
        const result = await proxyService.test(id, input.targets);
        request.log.info({
            systemEvent: true,
            action: 'proxy.test',
            actorId: request.user?.id ?? null,
            actorUsername: request.user?.username ?? null,
            proxyId: id,
            ok: result.ok,
        }, '测试代理连接');
        return { success: true, data: result };
    });
};

export default proxyRoutes;
