import { z } from 'zod';

// 第三方邮箱提供商 key（'auto' 仅用于导入场景）
export const MAIL_PROVIDER_KEYS = ['outlook', 'gmail', 'qq', '163', '126', 'yahoo', 'aliyun', 'custom'] as const;

export const providerSchema = z.enum(MAIL_PROVIDER_KEYS);

type ProviderCredentialInput = {
    provider?: string;
    clientId?: string;
    refreshToken?: string;
    password?: string;
    imapHost?: string;
};

/**
 * 按提供商校验凭据：
 * - outlook：clientId + refreshToken 必填
 * - 其他第三方 IMAP：password（授权码/密码）必填
 * - custom：额外要求 imapHost
 */
function checkProviderCredentials(value: ProviderCredentialInput, ctx: z.RefinementCtx, requireSecrets: boolean) {
    const provider = value.provider || 'outlook';
    if (provider === 'outlook') {
        if ((requireSecrets || value.clientId !== undefined) && !value.clientId) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['clientId'], message: 'Outlook 账号需要客户端 ID (clientId)' });
        }
        if ((requireSecrets || value.refreshToken !== undefined) && !value.refreshToken) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['refreshToken'], message: 'Outlook 账号需要刷新令牌 (refreshToken)' });
        }
    } else {
        if ((requireSecrets || value.password !== undefined) && !value.password) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['password'], message: '第三方 IMAP 邮箱需要密码/授权码' });
        }
        if (provider === 'custom' && (requireSecrets || value.imapHost !== undefined) && !value.imapHost) {
            ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['imapHost'], message: '自定义 IMAP 邮箱需要填写 IMAP 服务器地址' });
        }
    }
}

const createBaseSchema = z.object({
    email: z.string().email(),
    provider: providerSchema.default('outlook'),
    clientId: z.string().min(1).optional(),
    refreshToken: z.string().min(1).optional(),
    password: z.string().min(1).optional(),
    imapHost: z.string().min(1).optional(),
    imapPort: z.coerce.number().int().min(1).max(65535).optional(),
    groupId: z.coerce.number().int().positive().optional(),
    proxyId: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
});

export const createEmailSchema = createBaseSchema.superRefine((value, ctx) => {
    checkProviderCredentials(value, ctx, true);
});

export const updateEmailSchema = createBaseSchema
    .partial()
    .omit({ groupId: true })
    .extend({
        status: z.enum(['ACTIVE', 'ERROR', 'DISABLED']).optional(),
        groupId: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
        proxyId: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
    })
    .superRefine((value, ctx) => {
        checkProviderCredentials(value, ctx, false);
    });

export const listEmailSchema = z.object({
    page: z.coerce.number().min(1).default(1),
    pageSize: z.coerce.number().min(1).max(100).default(10),
    status: z.enum(['ACTIVE', 'ERROR', 'DISABLED']).optional(),
    provider: providerSchema.optional(),
    keyword: z.string().optional(),
    groupId: z.coerce.number().int().positive().optional(),
    groupName: z.string().optional(),
});

export const importEmailSchema = z.object({
    content: z.string().min(1),
    separator: z.string().default('----'),
    provider: z.union([providerSchema, z.literal('auto')]).default('auto'),
    groupId: z.coerce.number().int().positive().optional(),
    proxyId: z.union([z.coerce.number().int().positive(), z.null()]).optional(),
});

export type CreateEmailInput = z.infer<typeof createEmailSchema>;
export type UpdateEmailInput = z.infer<typeof updateEmailSchema>;
export type ListEmailInput = z.infer<typeof listEmailSchema>;
export type ImportEmailInput = z.infer<typeof importEmailSchema>;
