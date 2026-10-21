import { z } from 'zod';

export const proxyTypeSchema = z.enum(['SSH', 'SOCKS5', 'HTTP']);
export const proxyAuthTypeSchema = z.enum(['PASSWORD', 'KEY']);

const baseProxyShape = {
    name: z.string().min(1, '请输入代理名称').max(50),
    type: proxyTypeSchema.default('SSH'),
    url: z.string().max(500).optional(),
    sshHost: z.string().max(255).optional(),
    sshPort: z.number().int().min(1).max(65535).default(22),
    sshUser: z.string().max(100).optional(),
    authType: proxyAuthTypeSchema.default('KEY'),
    password: z.string().max(4096).optional(),
    privateKey: z.string().max(16384).optional(),
    passphrase: z.string().max(1024).optional(),
    enabled: z.boolean().default(true),
};

function requireFields(
    value: {
        type?: string;
        url?: string;
        sshHost?: string;
        sshUser?: string;
        authType?: string;
        password?: string;
        privateKey?: string;
    },
    ctx: z.RefinementCtx
): void {
    if (value.type === 'SSH') {
        if (!value.sshHost) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sshHost'], message: 'SSH 代理需要填写主机地址' });
        }
        if (!value.sshUser) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['sshUser'], message: 'SSH 代理需要填写登录用户名' });
        }
        if (value.authType === 'PASSWORD' && !value.password) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['password'], message: '密码认证需要填写密码' });
        }
        if (value.authType !== 'PASSWORD' && !value.privateKey) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['privateKey'], message: '密钥认证需要填写私钥' });
        }
    } else if (!value.url) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['url'], message: 'SOCKS5 / HTTP 代理需要填写代理地址' });
    }
}

export const createProxySchema = z.object(baseProxyShape).superRefine(requireFields);

/** 更新：字段全部可选，只有显式传入的字段才校验（允许保留原密钥） */
export const updateProxySchema = z
    .object({
        ...baseProxyShape,
        name: z.string().min(1).max(50).optional(),
        sshPort: z.number().int().min(1).max(65535).optional(),
        enabled: z.boolean().optional(),
    })
    .partial();

export const testProxySchema = z.object({
    /** 可选：测试时直连的探测目标 */
    targets: z
        .array(
            z.object({
                host: z.string().min(1),
                port: z.number().int().min(1).max(65535),
            })
        )
        .optional(),
});

export type CreateProxyInput = z.infer<typeof createProxySchema>;
export type UpdateProxyInput = z.infer<typeof updateProxySchema>;
