import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    Table,
    Button,
    Space,
    Modal,
    Form,
    Input,
    Select,
    message,
    Popconfirm,
    Tag,
    Typography,
    Upload,
    Tooltip,
    List,
    Tabs,
    Spin,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
    PlusOutlined,
    EditOutlined,
    DeleteOutlined,
    UploadOutlined,
    DownloadOutlined,
    InboxOutlined,
    SearchOutlined,
    MailOutlined,
    GroupOutlined,
    SyncOutlined,
} from '@ant-design/icons';
import { emailApi, groupApi, proxyApi, type ProxyConfigItem } from '../../api';
import { getErrorMessage } from '../../utils/error';
import { requestData } from '../../utils/request';
import dayjs from 'dayjs';

const { Title, Text } = Typography;
const { TextArea } = Input;
const { Dragger } = Upload;
const MAIL_FETCH_STRATEGY_OPTIONS = [
    { value: 'GRAPH_FIRST', label: 'Graph 优先（失败回退 IMAP）' },
    { value: 'IMAP_FIRST', label: 'IMAP 优先（失败回退 Graph）' },
    { value: 'GRAPH_ONLY', label: '仅 Graph' },
    { value: 'IMAP_ONLY', label: '仅 IMAP' },
] as const;

type MailFetchStrategy = (typeof MAIL_FETCH_STRATEGY_OPTIONS)[number]['value'];

const MAIL_FETCH_STRATEGY_LABELS: Record<MailFetchStrategy, string> = {
    GRAPH_FIRST: 'Graph 优先',
    IMAP_FIRST: 'IMAP 优先',
    GRAPH_ONLY: '仅 Graph',
    IMAP_ONLY: '仅 IMAP',
};

// 第三方邮箱提供商选项（与后端 providers.ts 保持一致）
const PROVIDER_OPTIONS = [
    { value: 'outlook', label: 'Outlook/Microsoft', authType: 'oauth2', imapHost: '', imapPort: 993, note: '使用 OAuth2 认证（clientId + refreshToken）' },
    { value: 'gmail', label: 'Gmail', authType: 'password', imapHost: 'imap.gmail.com', imapPort: 993, note: '需开启 IMAP，并使用应用专用密码（非登录密码）' },
    { value: 'qq', label: 'QQ邮箱', authType: 'password', imapHost: 'imap.qq.com', imapPort: 993, note: '需开启 IMAP 服务，使用授权码（非 QQ 密码）' },
    { value: '163', label: '163邮箱', authType: 'password', imapHost: 'imap.163.com', imapPort: 993, note: '需开启 IMAP 服务，使用授权码' },
    { value: '126', label: '126邮箱', authType: 'password', imapHost: 'imap.126.com', imapPort: 993, note: '需开启 IMAP 服务，使用授权码' },
    { value: 'yahoo', label: 'Yahoo邮箱', authType: 'password', imapHost: 'imap.mail.yahoo.com', imapPort: 993, note: '需在账户安全设置中生成应用密码' },
    { value: 'aliyun', label: '阿里邮箱', authType: 'password', imapHost: 'imap.aliyun.com', imapPort: 993, note: '使用阿里邮箱登录密码或授权码' },
    { value: 'custom', label: '自定义 IMAP', authType: 'password', imapHost: '', imapPort: 993, note: '手动填写 IMAP 服务器地址和端口' },
] as const;

type MailProviderKey = (typeof PROVIDER_OPTIONS)[number]['value'];

const PROVIDER_LABELS: Record<string, string> = Object.fromEntries(
    PROVIDER_OPTIONS.map((p) => [p.value, p.label])
);

const PROVIDER_COLORS: Record<string, string> = {
    outlook: 'blue',
    gmail: 'red',
    qq: 'green',
    '163': 'orange',
    '126': 'gold',
    yahoo: 'purple',
    aliyun: 'cyan',
    custom: 'default',
};

// 域名 -> provider 自动识别
const DOMAIN_PROVIDER_MAP: Record<string, string> = {
    'gmail.com': 'gmail',
    'googlemail.com': 'gmail',
    'qq.com': 'qq',
    'foxmail.com': 'qq',
    '163.com': '163',
    '126.com': '126',
    'yahoo.com': 'yahoo',
    'yahoo.co.jp': 'yahoo',
    'yahoo.co.uk': 'yahoo',
    'yahoo.com.cn': 'yahoo',
    'aliyun.com': 'aliyun',
    'alimail.com': 'aliyun',
    'outlook.com': 'outlook',
    'hotmail.com': 'outlook',
    'live.com': 'outlook',
    'live.cn': 'outlook',
    'msn.com': 'outlook',
};

const inferProviderFromEmail = (email: string): string | undefined => {
    if (!email || !email.includes('@')) return undefined;
    const domain = email.split('@')[1]?.toLowerCase().trim();
    if (!domain) return undefined;
    return DOMAIN_PROVIDER_MAP[domain];
};

interface EmailGroup {
    id: number;
    name: string;
    description: string | null;
    fetchStrategy: MailFetchStrategy;
    emailCount: number;
    createdAt: string;
    updatedAt: string;
}

interface EmailAccount {
    id: number;
    email: string;
    provider: string;
    clientId: string | null;
    imapHost: string | null;
    imapPort: number;
    status: 'ACTIVE' | 'ERROR' | 'DISABLED';
    groupId: number | null;
    proxyId: number | null;
    group: { id: number; name: string } | null;
    lastCheckAt: string | null;
    tokenRefreshedAt: string | null;
    errorMessage: string | null;
    createdAt: string;
}

interface EmailListResult {
    list: EmailAccount[];
    total: number;
}

interface MailItem {
    id: string;
    folder?: 'inbox' | 'junk';
    from: string;
    subject: string;
    text: string;
    html: string;
    date: string;
}

interface MailListResult {
    messages: MailItem[];
    cached?: boolean;
    cachedAt?: string;
}

interface EmailDetailsResult extends EmailAccount {
    clientId: string | null;
    refreshToken: string | null;
    password: string | null;
    imapHost: string | null;
    imapPort: number;
}

const EmailsPage: React.FC = () => {
    const [loading, setLoading] = useState(false);
    const [data, setData] = useState<EmailAccount[]>([]);
    const [total, setTotal] = useState(0);
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(10);
    const [selectedRowKeys, setSelectedRowKeys] = useState<React.Key[]>([]);
    const [modalVisible, setModalVisible] = useState(false);
    const [importModalVisible, setImportModalVisible] = useState(false);
    const [mailModalVisible, setMailModalVisible] = useState(false);
    const [editingId, setEditingId] = useState<number | null>(null);
    const [keyword, setKeyword] = useState('');
    const [debouncedKeyword, setDebouncedKeyword] = useState('');
    const [filterGroupId, setFilterGroupId] = useState<number | undefined>(undefined);
    const [importContent, setImportContent] = useState('');
    const [separator, setSeparator] = useState('----');
    const [importGroupId, setImportGroupId] = useState<number | undefined>(undefined);
    const [importProvider, setImportProvider] = useState<string>('auto');
    const [mailList, setMailList] = useState<MailItem[]>([]);
    const [mailLoading, setMailLoading] = useState(false);
    const [mailCacheInfo, setMailCacheInfo] = useState<{ cached: boolean; cachedAt?: string }>({ cached: false });
    const [currentEmail, setCurrentEmail] = useState<string>('');
    const [currentEmailId, setCurrentEmailId] = useState<number | null>(null);
    const [currentMailbox, setCurrentMailbox] = useState<string>('INBOX');
    const [emailDetailVisible, setEmailDetailVisible] = useState(false);
    const [emailDetailContent, setEmailDetailContent] = useState<string>('');
    const [emailDetailSubject, setEmailDetailSubject] = useState<string>('');
    const [emailDetailLoading, setEmailDetailLoading] = useState(false);
    const [emailEditLoading, setEmailEditLoading] = useState(false);
    const [form] = Form.useForm();
    const watchedProvider = Form.useWatch('provider', form) as MailProviderKey | undefined;
    const isOutlookProvider = (watchedProvider || 'outlook') === 'outlook';
    const isCustomProvider = watchedProvider === 'custom';

    // Group-related state
    const [groups, setGroups] = useState<EmailGroup[]>([]);
    const [proxies, setProxies] = useState<ProxyConfigItem[]>([]);
    const [groupModalVisible, setGroupModalVisible] = useState(false);
    const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
    const [groupForm] = Form.useForm();
    const [assignGroupModalVisible, setAssignGroupModalVisible] = useState(false);
    const [assignTargetGroupId, setAssignTargetGroupId] = useState<number | undefined>(undefined);
    const [refreshingTokenIds, setRefreshingTokenIds] = useState<Set<number>>(new Set());
    const [batchRefreshing, setBatchRefreshing] = useState(false);
    const latestListRequestIdRef = useRef(0);

    const toOptionalNumber = (value: unknown): number | undefined => {
        if (value === undefined || value === null || value === '') {
            return undefined;
        }
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : undefined;
    };

    const fetchGroups = useCallback(async () => {
        const result = await requestData<EmailGroup[]>(
            () => groupApi.getList(),
            '获取分组失败',
            { silent: true }
        );
        if (result) {
            setGroups(result);
        }
    }, []);

    const fetchProxies = useCallback(async () => {
        const result = await requestData<ProxyConfigItem[]>(
            () => proxyApi.getList(),
            '获取代理配置失败',
            { silent: true }
        );
        if (result) {
            setProxies(result);
        }
    }, []);

    const fetchData = useCallback(async () => {
        const currentRequestId = ++latestListRequestIdRef.current;
        setLoading(true);
        const params: { page: number; pageSize: number; keyword: string; groupId?: number } = { page, pageSize, keyword: debouncedKeyword };
        if (filterGroupId !== undefined) params.groupId = filterGroupId;

        const result = await requestData<EmailListResult>(
            () => emailApi.getList(params),
            '获取数据失败'
        );
        if (currentRequestId !== latestListRequestIdRef.current) {
            return;
        }
        if (result) {
            setData(result.list);
            setTotal(result.total);
        }
        setLoading(false);
    }, [debouncedKeyword, filterGroupId, page, pageSize]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            void fetchGroups();
            void fetchProxies();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [fetchGroups, fetchProxies]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            setDebouncedKeyword(keyword.trim());
        }, 300);
        return () => window.clearTimeout(timer);
    }, [keyword]);

    useEffect(() => {
        const timer = window.setTimeout(() => {
            void fetchData();
        }, 0);
        return () => window.clearTimeout(timer);
    }, [fetchData]);

    const handleCreate = () => {
        setEditingId(null);
        setEmailEditLoading(false);
        form.resetFields();
        form.setFieldsValue({ provider: 'outlook', imapPort: 993 });
        setModalVisible(true);
    };

    const handleEdit = useCallback(async (record: EmailAccount) => {
        setEditingId(record.id);
        setEmailEditLoading(true);
        form.resetFields();
        setModalVisible(true);
        try {
            const res = await emailApi.getById<EmailDetailsResult>(record.id, true);
            if (res.code === 200) {
                const details = res.data;
                form.setFieldsValue({
                    email: details.email,
                    provider: details.provider || 'outlook',
                    clientId: details.clientId,
                    refreshToken: details.refreshToken,
                    password: details.password,
                    imapHost: details.imapHost,
                    imapPort: details.imapPort,
                    status: details.status,
                    groupId: details.groupId,
                    proxyId: details.proxyId ?? undefined,
                });
            }
        } catch {
            message.error('获取详情失败');
        } finally {
            setEmailEditLoading(false);
        }
    }, [form]);

    const handleDelete = useCallback(async (id: number) => {
        try {
            const res = await emailApi.delete(id);
            if (res.code === 200) {
                message.success('删除成功');
                fetchData();
                fetchGroups();
            } else {
                message.error(res.message);
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '删除失败'));
        }
    }, [fetchData, fetchGroups]);

    const handleBatchDelete = async () => {
        if (selectedRowKeys.length === 0) {
            message.warning('请选择要删除的邮箱');
            return;
        }

        try {
            const res = await emailApi.batchDelete(selectedRowKeys as number[]);
            if (res.code === 200) {
                message.success(`成功删除 ${res.data.deleted} 个邮箱`);
                setSelectedRowKeys([]);
                fetchData();
                fetchGroups();
            } else {
                message.error(res.message);
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '删除失败'));
        }
    };

    const handleSubmit = async () => {
        try {
            const values = await form.validateFields();
            const normalizedGroupId =
                values.groupId === null ? null : toOptionalNumber(values.groupId);
            const provider = (values.provider || 'outlook') as string;

            // 按提供商组装提交数据
            const buildPayload = () => {
                const base: Record<string, unknown> = {
                    email: values.email,
                    provider,
                    status: values.status,
                };
                if (provider === 'outlook') {
                    if (values.clientId) base.clientId = values.clientId;
                    if (values.refreshToken) base.refreshToken = values.refreshToken;
                    if (values.password) base.password = values.password;
                } else {
                    if (values.password) base.password = values.password;
                    if (values.imapHost) base.imapHost = values.imapHost;
                    if (values.imapPort) base.imapPort = values.imapPort;
                }
                return base;
            };

            if (editingId) {
                const submitData = {
                    ...buildPayload(),
                    groupId: normalizedGroupId ?? null,
                    proxyId: toOptionalNumber(values.proxyId) ?? null,
                };
                const res = await emailApi.update(editingId, submitData as Parameters<typeof emailApi.update>[1]);
                if (res.code === 200) {
                    message.success('更新成功');
                    setModalVisible(false);
                    fetchData();
                    fetchGroups();
                } else {
                    message.error(res.message);
                }
            } else {
                const submitData = {
                    ...buildPayload(),
                    groupId: toOptionalNumber(values.groupId),
                    proxyId: toOptionalNumber(values.proxyId),
                };
                const res = await emailApi.create(submitData as Parameters<typeof emailApi.create>[0]);
                if (res.code === 200) {
                    message.success('创建成功');
                    setModalVisible(false);
                    fetchData();
                    fetchGroups();
                } else {
                    message.error(res.message);
                }
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '保存失败'));
        }
    };

    const handleImport = async () => {
        if (!importContent.trim()) {
            message.warning('请输入或粘贴邮箱数据');
            return;
        }

        try {
            const res = await emailApi.import(
                importContent,
                separator,
                toOptionalNumber(importGroupId),
                importProvider
            );
            if (res.code === 200) {
                message.success(res.message);
                setImportModalVisible(false);
                setImportContent('');
                setImportGroupId(undefined);
                setImportProvider('auto');
                fetchData();
                fetchGroups();
            } else {
                message.error(res.message);
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '导入失败'));
        }
    };

    const handleExport = async () => {
        try {
            const ids = selectedRowKeys.length > 0 ? selectedRowKeys as number[] : undefined;
            const groupId = ids ? undefined : toOptionalNumber(filterGroupId);
            const res = await emailApi.export(ids, separator, groupId);
            if (res.code !== 200) {
                message.error(res.message || '导出失败');
                return;
            }
            const content = res.data?.content || '';

            const blob = new Blob([content], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'email_accounts.txt';
            a.click();
            URL.revokeObjectURL(url);

            message.success('导出成功');
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '导出失败'));
        }
    };

    const loadMails = useCallback(async (
        emailId: number,
        mailbox: string,
        opts?: { showSuccessToast?: boolean; fresh?: boolean }
    ) => {
        setMailLoading(true);
        const result = await requestData<MailListResult>(
            // 只取邮件头，首屏更快；正文在点「查看」时按需加载
            () => emailApi.viewMails(emailId, mailbox, { fresh: opts?.fresh, headersOnly: true, limit: 20 }),
            '获取邮件失败'
        );
        if (result) {
            setMailList(result.messages || []);
            setMailCacheInfo({ cached: !!result.cached, cachedAt: result.cachedAt });
            fetchData();
            if (opts?.showSuccessToast) {
                message.success('刷新成功');
            }
        }
        setMailLoading(false);
    }, [fetchData]);

    const handleViewMails = useCallback(async (record: EmailAccount, mailbox: string) => {
        setCurrentEmail(record.email);
        setCurrentEmailId(record.id);
        setCurrentMailbox(mailbox);
        setMailModalVisible(true);
        setMailCacheInfo({ cached: false });
        await loadMails(record.id, mailbox);
    }, [loadMails]);

    const handleRefreshMails = async () => {
        if (!currentEmailId) return;
        // 「收取新邮件」= 强制真实拉取（跳过缓存读取，仍刷新缓存）
        await loadMails(currentEmailId, currentMailbox, { showSuccessToast: true, fresh: true });
    };

    const handleClearMailbox = async () => {
        if (!currentEmailId) return;
        try {
            const res = await emailApi.clearMailbox(currentEmailId, currentMailbox);
            if (res.code === 200) {
                message.success(`已清空 ${res.data?.deletedCount || 0} 封邮件`);
                setMailList([]);
                fetchData();
            } else {
                message.error(res.message || '清空失败');
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '清空失败'));
        }
    };

    // ========================================
    // Token refresh handlers
    // ========================================
    const handleRefreshToken = useCallback(async (record: EmailAccount) => {
        setRefreshingTokenIds(prev => new Set(prev).add(record.id));
        try {
            const res = await emailApi.refreshSingleToken(record.id);
            if (res.code === 200 && res.data?.success) {
                message.success(`${record.email} Token 刷新成功`);
                fetchData();
            } else {
                message.error(res.data?.message || 'Token 刷新失败');
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, 'Token 刷新失败'));
        } finally {
            setRefreshingTokenIds(prev => {
                const next = new Set(prev);
                next.delete(record.id);
                return next;
            });
        }
    }, [fetchData]);

    const handleBatchRefreshTokens = async () => {
        setBatchRefreshing(true);
        try {
            const res = await emailApi.refreshTokens(filterGroupId);
            if (res.code === 200) {
                message.success('批量 Token 刷新任务已启动，请稍后刷新页面查看结果');
            } else {
                message.error(res.message || '启动失败');
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '启动失败'));
        } finally {
            setBatchRefreshing(false);
        }
    };

    const handleViewEmailDetail = async (record: MailItem) => {
        setEmailDetailSubject(record.subject || '无主题');
        setEmailDetailContent('');
        setEmailDetailVisible(true);
        if (!currentEmailId) {
            return;
        }
        setEmailDetailLoading(true);
        try {
            const body = await requestData<{ html?: string; text?: string; subject?: string }>(
                () => emailApi.viewMailBody(currentEmailId, record.id, currentMailbox),
                '获取邮件正文失败'
            );
            if (body) {
                if (body.subject) {
                    setEmailDetailSubject(body.subject);
                }
                setEmailDetailContent(body.html || body.text || '无内容');
            } else {
                setEmailDetailContent('无内容');
            }
        } finally {
            setEmailDetailLoading(false);
        }
    };

    // ========================================
    // Group CRUD handlers
    // ========================================
    const handleCreateGroup = () => {
        setEditingGroupId(null);
        groupForm.resetFields();
        groupForm.setFieldsValue({ fetchStrategy: 'GRAPH_FIRST' });
        setGroupModalVisible(true);
    };

    const handleEditGroup = useCallback((group: EmailGroup) => {
        setEditingGroupId(group.id);
        groupForm.setFieldsValue({
            name: group.name,
            description: group.description,
            fetchStrategy: group.fetchStrategy,
        });
        setGroupModalVisible(true);
    }, [groupForm]);

    const handleDeleteGroup = useCallback(async (id: number) => {
        try {
            const res = await groupApi.delete(id);
            if (res.code === 200) {
                message.success('分组已删除');
                fetchGroups();
                fetchData();
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '删除失败'));
        }
    }, [fetchData, fetchGroups]);

    const handleGroupSubmit = async () => {
        try {
            const values = await groupForm.validateFields();
            if (editingGroupId) {
                const res = await groupApi.update(editingGroupId, values);
                if (res.code === 200) {
                    message.success('分组已更新');
                    setGroupModalVisible(false);
                    fetchGroups();
                }
            } else {
                const res = await groupApi.create(values);
                if (res.code === 200) {
                    message.success('分组已创建');
                    setGroupModalVisible(false);
                    fetchGroups();
                }
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '分组保存失败'));
        }
    };

    const handleBatchAssignGroup = async () => {
        if (selectedRowKeys.length === 0) {
            message.warning('请先选择邮箱');
            return;
        }
        if (!assignTargetGroupId) {
            message.warning('请选择目标分组');
            return;
        }
        try {
            const res = await groupApi.assignEmails(assignTargetGroupId, selectedRowKeys as number[]);
            if (res.code === 200) {
                message.success(`已将 ${res.data.count} 个邮箱分配到分组`);
                setAssignGroupModalVisible(false);
                setAssignTargetGroupId(undefined);
                setSelectedRowKeys([]);
                fetchData();
                fetchGroups();
            }
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '分配失败'));
        }
    };

    const handleBatchRemoveGroup = async () => {
        if (selectedRowKeys.length === 0) {
            message.warning('请先选择邮箱');
            return;
        }
        // Find the groupIds of selected emails, remove from each group
        const selectedEmails = data.filter((e: EmailAccount) => selectedRowKeys.includes(e.id));
        const groupIds = [...new Set(selectedEmails.map((e: EmailAccount) => e.groupId).filter(Boolean))] as number[];

        try {
            for (const gid of groupIds) {
                const emailIds = selectedEmails.filter((e: EmailAccount) => e.groupId === gid).map((e: EmailAccount) => e.id);
                await groupApi.removeEmails(gid, emailIds);
            }
            message.success('已将选中邮箱移出分组');
            setSelectedRowKeys([]);
            fetchData();
            fetchGroups();
        } catch (err: unknown) {
            message.error(getErrorMessage(err, '移出失败'));
        }
    };

    // ========================================
    // Email table columns
    // ========================================
    const columns: ColumnsType<EmailAccount> = useMemo(() => [
        {
            title: '邮箱',
            dataIndex: 'email',
            key: 'email',
            ellipsis: true,
        },
        {
            title: '提供商',
            dataIndex: 'provider',
            key: 'provider',
            width: 120,
            render: (provider: string | null) => {
                const key = provider || 'outlook';
                return <Tag color={PROVIDER_COLORS[key] || 'default'}>{PROVIDER_LABELS[key] || key}</Tag>;
            },
        },
        {
            title: '客户端 ID / IMAP 服务器',
            key: 'credential',
            ellipsis: true,
            render: (_: unknown, record: EmailAccount) => {
                if ((record.provider || 'outlook') === 'outlook') {
                    return record.clientId || '-';
                }
                return record.imapHost ? `${record.imapHost}:${record.imapPort}` : '-';
            },
        },
        {
            title: '分组',
            dataIndex: 'group',
            key: 'group',
            width: 120,
            render: (group: EmailAccount['group']) =>
                group ? <Tag color="blue">{group.name}</Tag> : <Tag>未分组</Tag>,
        },
        {
            title: '状态',
            dataIndex: 'status',
            key: 'status',
            width: 100,
            render: (status: string) => {
                const colors: Record<string, string> = {
                    ACTIVE: 'green',
                    ERROR: 'red',
                    DISABLED: 'default',
                };
                const labels: Record<string, string> = {
                    ACTIVE: '正常',
                    ERROR: '异常',
                    DISABLED: '禁用',
                };
                return <Tag color={colors[status]}>{labels[status]}</Tag>;
            },
        },
        {
            title: '最后检查',
            dataIndex: 'lastCheckAt',
            key: 'lastCheckAt',
            width: 160,
            render: (val: string | null) => (val ? dayjs(val).format('YYYY-MM-DD HH:mm') : '-'),
        },
        {
            title: 'Token 刷新',
            dataIndex: 'tokenRefreshedAt',
            key: 'tokenRefreshedAt',
            width: 160,
            render: (val: string | null) => (val ? dayjs(val).format('YYYY-MM-DD HH:mm') : '-'),
        },
        {
            title: '创建时间',
            dataIndex: 'createdAt',
            key: 'createdAt',
            width: 160,
            render: (val: string) => dayjs(val).format('YYYY-MM-DD HH:mm'),
        },
        {
            title: '操作',
            key: 'action',
            width: 240,
            render: (_: unknown, record: EmailAccount) => (
                <Space>
                    <Tooltip title={(record.provider || 'outlook') === 'outlook' ? '刷新 Token' : '第三方邮箱无需刷新 Token'}>
                        <Button
                            type="text"
                            icon={<SyncOutlined spin={refreshingTokenIds.has(record.id)} />}
                            onClick={() => handleRefreshToken(record)}
                            disabled={refreshingTokenIds.has(record.id) || record.status === 'DISABLED' || (record.provider || 'outlook') !== 'outlook'}
                        />
                    </Tooltip>
                    <Tooltip title="收件箱">
                        <Button
                            type="text"
                            icon={<MailOutlined />}
                            onClick={() => handleViewMails(record, 'INBOX')}
                        />
                    </Tooltip>
                    <Tooltip title="垃圾箱">
                        <Button
                            type="text"
                            icon={<DeleteOutlined style={{ color: '#faad14' }} />}
                            onClick={() => handleViewMails(record, 'Junk')}
                        />
                    </Tooltip>
                    <Tooltip title="编辑">
                        <Button
                            type="text"
                            icon={<EditOutlined />}
                            onClick={() => handleEdit(record)}
                        />
                    </Tooltip>
                    <Tooltip title="删除">
                        <Popconfirm
                            title="确定要删除此邮箱吗？"
                            onConfirm={() => handleDelete(record.id)}
                        >
                            <Button type="text" danger icon={<DeleteOutlined />} />
                        </Popconfirm>
                    </Tooltip>
                </Space>
            ),
        },
    ], [handleDelete, handleEdit, handleRefreshToken, handleViewMails, refreshingTokenIds]);

    const rowSelection = useMemo(
        () => ({
            selectedRowKeys,
            onChange: setSelectedRowKeys,
        }),
        [selectedRowKeys]
    );

    const tablePagination = useMemo(
        () => ({
            current: page,
            pageSize,
            total,
            showSizeChanger: true,
            showTotal: (count: number) => `共 ${count} 条`,
            onChange: (currentPage: number, currentPageSize: number) => {
                setPage(currentPage);
                setPageSize(currentPageSize);
            },
        }),
        [page, pageSize, total]
    );

    const emailDetailSrcDoc = useMemo(
        () => `
                        <!DOCTYPE html>
                        <html>
                        <head>
                            <meta charset="utf-8">
                            <style>
                                body { 
                                    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
                                    font-size: 14px;
                                    line-height: 1.6;
                                    color: #333;
                                    margin: 0;
                                    padding: 16px;
                                    background: #fafafa;
                                }
                                img { max-width: 100%; height: auto; }
                                a { color: #1890ff; }
                            </style>
                        </head>
                        <body>${emailDetailContent}</body>
                        </html>
                    `,
        [emailDetailContent]
    );

    const groupFilterOptions = useMemo(
        () =>
            groups.map((group: EmailGroup) => ({
                value: group.id,
                label: `${group.name} (${group.emailCount})`,
            })),
        [groups]
    );

    const groupOptions = useMemo(
        () =>
            groups.map((group: EmailGroup) => ({
                value: group.id,
                label: group.name,
            })),
        [groups]
    );

    const proxyOptions = useMemo(
        () =>
            proxies.map((proxy: ProxyConfigItem) => ({
                value: proxy.id,
                label:
                    proxy.type === 'SSH'
                        ? `${proxy.name}（SSH ${proxy.sshHost}）${proxy.enabled ? '' : ' · 已停用'}`
                        : `${proxy.name}（${proxy.type}）${proxy.enabled ? '' : ' · 已停用'}`,
            })),
        [proxies]
    );

    // ========================================
    // Group table columns
    // ========================================
    const groupColumns: ColumnsType<EmailGroup> = useMemo(() => [
        {
            title: '分组名称',
            dataIndex: 'name',
            key: 'name',
            render: (name: string) => <Tag color="blue">{name}</Tag>,
        },
        {
            title: '描述',
            dataIndex: 'description',
            key: 'description',
            render: (val: string | null) => val || '-',
        },
        {
            title: '拉取策略',
            dataIndex: 'fetchStrategy',
            key: 'fetchStrategy',
            width: 190,
            render: (value: MailFetchStrategy) => <Tag color="purple">{MAIL_FETCH_STRATEGY_LABELS[value]}</Tag>,
        },
        {
            title: '邮箱数',
            dataIndex: 'emailCount',
            key: 'emailCount',
            width: 100,
        },
        {
            title: '创建时间',
            dataIndex: 'createdAt',
            key: 'createdAt',
            width: 180,
            render: (val: string) => dayjs(val).format('YYYY-MM-DD HH:mm'),
        },
        {
            title: '操作',
            key: 'action',
            width: 160,
            render: (_: unknown, record: EmailGroup) => (
                <Space>
                    <Button
                        type="text"
                        icon={<EditOutlined />}
                        onClick={() => handleEditGroup(record)}
                    />
                    <Popconfirm
                        title="删除分组后，组内邮箱将变为「未分组」。确认？"
                        onConfirm={() => handleDeleteGroup(record.id)}
                    >
                        <Button type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                </Space>
            ),
        },
    ], [handleDeleteGroup, handleEditGroup]);

    // ========================================
    // Render
    // ========================================
    return (
        <div>
            <Title level={4} style={{ margin: '0 0 16px' }}>邮箱管理</Title>
            <Tabs
                defaultActiveKey="emails"
                animated={false}
                destroyInactiveTabPane
                items={[
                    {
                        key: 'emails',
                        label: '邮箱列表',
                        children: (
                            <>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
                                    <Space wrap>
                                        <Input
                                            placeholder="搜索邮箱"
                                            prefix={<SearchOutlined />}
                                            value={keyword}
                                            onChange={(e) => setKeyword(e.target.value)}
                                            style={{ width: 200 }}
                                            allowClear
                                        />
                                        <Select
                                            placeholder="按分组筛选"
                                            allowClear
                                            style={{ width: 160 }}
                                            value={filterGroupId}
                                            options={groupFilterOptions}
                                            onChange={(val: number | string | undefined) => {
                                                setFilterGroupId(toOptionalNumber(val));
                                                setPage(1);
                                            }}
                                        />
                                    </Space>
                                    <Space wrap>
                                        <Button
                                            icon={<SyncOutlined spin={batchRefreshing} />}
                                            onClick={handleBatchRefreshTokens}
                                            loading={batchRefreshing}
                                        >
                                            刷新全部 Token
                                        </Button>
                                        <Button icon={<UploadOutlined />} onClick={() => setImportModalVisible(true)}>
                                            导入
                                        </Button>
                                        <Button icon={<DownloadOutlined />} onClick={handleExport}>
                                            导出
                                        </Button>
                                        {selectedRowKeys.length > 0 && (
                                            <>
                                                <Button icon={<GroupOutlined />} onClick={() => setAssignGroupModalVisible(true)}>
                                                    分配分组 ({selectedRowKeys.length})
                                                </Button>
                                                <Button onClick={handleBatchRemoveGroup}>
                                                    移出分组 ({selectedRowKeys.length})
                                                </Button>
                                                <Popconfirm
                                                    title={`确定要删除选中的 ${selectedRowKeys.length} 个邮箱吗？`}
                                                    onConfirm={handleBatchDelete}
                                                >
                                                    <Button danger>批量删除 ({selectedRowKeys.length})</Button>
                                                </Popconfirm>
                                            </>
                                        )}
                                        <Button type="primary" icon={<PlusOutlined />} onClick={handleCreate}>
                                            添加邮箱
                                        </Button>
                                    </Space>
                                </div>

                                <Table
                                    columns={columns}
                                    dataSource={data}
                                    rowKey="id"
                                    loading={loading}
                                    rowSelection={rowSelection}
                                    pagination={tablePagination}
                                    virtual
                                    scroll={{ y: 560, x: 1200 }}
                                />
                            </>
                        ),
                    },
                    {
                        key: 'groups',
                        label: '邮箱分组',
                        children: (
                            <>
                                <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
                                    <Button type="primary" icon={<PlusOutlined />} onClick={handleCreateGroup}>
                                        创建分组
                                    </Button>
                                </div>
                                <Table
                                    columns={groupColumns}
                                    dataSource={groups}
                                    rowKey="id"
                                    pagination={false}
                                />
                            </>
                        ),
                    },
                ]}
            />

            {/* 添加/编辑邮箱 Modal */}
            <Modal
                title={editingId ? '编辑邮箱' : '添加邮箱'}
                open={modalVisible}
                onOk={handleSubmit}
                onCancel={() => setModalVisible(false)}
                destroyOnClose
                width={600}
            >
                <Spin spinning={emailEditLoading}>
                    <Form form={form} layout="vertical">
                    <Form.Item name="email" label="邮箱地址" rules={[{ required: true, message: '请输入邮箱地址' }, { type: 'email', message: '请输入有效的邮箱地址' }]}>
                        <Input
                            placeholder="example@outlook.com"
                            onBlur={(e) => {
                                // 输入邮箱后自动识别提供商（仅当未手动选择时）
                                const currentProvider = form.getFieldValue('provider');
                                if (currentProvider && currentProvider !== 'outlook') return;
                                const inferred = inferProviderFromEmail((e.target as HTMLInputElement).value);
                                if (inferred && inferred !== 'outlook') {
                                    const preset = PROVIDER_OPTIONS.find((p) => p.value === inferred);
                                    form.setFieldsValue({
                                        provider: inferred,
                                        imapHost: preset?.imapHost,
                                        imapPort: preset?.imapPort,
                                    });
                                    message.info(`已自动识别为 ${preset?.label || inferred}`);
                                }
                            }}
                        />
                    </Form.Item>
                    <Form.Item
                        name="provider"
                        label="邮箱提供商"
                        rules={[{ required: true, message: '请选择邮箱提供商' }]}
                    >
                        <Select
                            placeholder="选择邮箱提供商"
                            onChange={(value: string) => {
                                const preset = PROVIDER_OPTIONS.find((p) => p.value === value);
                                if (preset) {
                                    form.setFieldsValue({
                                        imapHost: preset.imapHost,
                                        imapPort: preset.imapPort,
                                    });
                                }
                            }}
                            options={PROVIDER_OPTIONS.map((p) => ({
                                value: p.value,
                                label: p.label,
                            }))}
                        />
                    </Form.Item>

                    {watchedProvider && (
                        <div style={{ marginBottom: 16, padding: '8px 12px', background: '#f6f8fa', borderRadius: 6, fontSize: 13, color: '#555' }}>
                            💡 {PROVIDER_OPTIONS.find((p) => p.value === watchedProvider)?.note}
                        </div>
                    )}

                    {isOutlookProvider ? (
                        <>
                            <Form.Item name="password" label="密码（可选）">
                                <Input.Password placeholder="可选" />
                            </Form.Item>
                            <Form.Item
                                name="clientId"
                                label="客户端 ID"
                                rules={[{ required: true, message: '请输入客户端 ID' }]}
                            >
                                <Input placeholder="Azure AD 应用程序 ID" />
                            </Form.Item>
                            <Form.Item
                                name="refreshToken"
                                label="刷新令牌"
                                rules={[{ required: !editingId, message: '请输入刷新令牌' }]}
                            >
                                <TextArea rows={4} placeholder="OAuth2 Refresh Token" />
                            </Form.Item>
                        </>
                    ) : (
                        <>
                            <Form.Item
                                name="password"
                                label={watchedProvider === 'qq' || watchedProvider === '163' || watchedProvider === '126' ? '授权码' : '密码/应用专用密码'}
                                rules={[{ required: !editingId, message: '请输入密码或授权码' }]}
                            >
                                <Input.Password placeholder={
                                    watchedProvider === 'gmail' ? 'Gmail 应用专用密码（非登录密码）' :
                                    watchedProvider === 'qq' || watchedProvider === '163' || watchedProvider === '126' ? '邮箱设置中生成的 IMAP 授权码' :
                                    '密码或授权码'
                                } />
                            </Form.Item>
                            {isCustomProvider && (
                                <>
                                    <Form.Item
                                        name="imapHost"
                                        label="IMAP 服务器地址"
                                        rules={[{ required: true, message: '请输入 IMAP 服务器地址' }]}
                                    >
                                        <Input placeholder="imap.example.com" />
                                    </Form.Item>
                                    <Form.Item name="imapPort" label="IMAP 端口" initialValue={993}>
                                        <Input type="number" placeholder="993" />
                                    </Form.Item>
                                </>
                            )}
                        </>
                    )}

                    <Form.Item name="groupId" label="所属分组">
                        <Select placeholder="可选：选择分组" allowClear options={groupOptions} />
                    </Form.Item>
                    <Form.Item
                        name="proxyId"
                        label="网络代理"
                        extra="海外邮箱或国内邮箱无法直连时，选择一条代理配置；留空则直连"
                    >
                        <Select placeholder="直连（不使用代理）" allowClear options={proxyOptions} />
                    </Form.Item>
                    <Form.Item name="status" label="状态" initialValue="ACTIVE">
                        <Select>
                            <Select.Option value="ACTIVE">正常</Select.Option>
                            <Select.Option value="DISABLED">禁用</Select.Option>
                        </Select>
                    </Form.Item>
                    </Form>
                </Spin>
            </Modal>

            {/* 批量导入 Modal */}
            <Modal
                title="批量导入邮箱"
                open={importModalVisible}
                onOk={handleImport}
                onCancel={() => setImportModalVisible(false)}
                destroyOnClose
                width={700}
            >
                <Space direction="vertical" style={{ width: '100%' }} size="middle">
                    <div>
                        <Text type="secondary">
                            上传文件或粘贴内容。选择「智能识别」将按邮箱域名自动判断账号类型。
                            <br />
                            Outlook 格式：邮箱{separator}客户端ID{separator}刷新令牌（4 列为 邮箱{separator}密码{separator}客户端ID{separator}刷新令牌）
                            <br />
                            第三方 IMAP 格式：邮箱{separator}密码（自定义 IMAP 为 邮箱{separator}密码{separator}IMAP地址{separator}端口）
                        </Text>
                    </div>
                    <Input
                        addonBefore="分隔符"
                        value={separator}
                        onChange={(e) => setSeparator(e.target.value)}
                        style={{ width: 200 }}
                    />
                    <Select
                        placeholder="导入提供商类型"
                        value={importProvider}
                        style={{ width: 260 }}
                        onChange={(value: string) => setImportProvider(value)}
                        options={[
                            { value: 'auto', label: '🔍 智能识别（按域名自动判断）' },
                            ...PROVIDER_OPTIONS.map((p) => ({ value: p.value, label: p.label })),
                        ]}
                    />
                    <Select
                        placeholder="导入到分组（可选）"
                        allowClear
                        value={importGroupId}
                        options={groupOptions}
                        onChange={(value: number | string | undefined) => setImportGroupId(toOptionalNumber(value))}
                        style={{ width: 260 }}
                    />
                    <Dragger
                        beforeUpload={(file) => {
                            const reader = new FileReader();
                            reader.onload = (e) => {
                                const fileContent = e.target?.result as string;
                                if (fileContent) {
                                    const lines = fileContent.split(/\r?\n/).filter((line: string) => line.trim());
                                    const processedLines = lines.map((line: string) => {
                                        const parts = line.split(separator);
                                        if (parts.length >= 5) {
                                            return `${parts[0]}${separator}${parts[1]}${separator}${parts[4]}`;
                                        }
                                        return line;
                                    });

                                    setImportContent(processedLines.join('\n'));
                                    message.success(`文件读取成功，已解析 ${lines.length} 行数据`);
                                }
                            };
                            reader.readAsText(file);
                            return false;
                        }}
                        showUploadList={false}
                        maxCount={1}
                        accept=".txt,.csv"
                    >
                        <p className="ant-upload-drag-icon">
                            <InboxOutlined />
                        </p>
                        <p className="ant-upload-text">点击或拖拽文件到此区域</p>
                        <p className="ant-upload-hint">支持 .txt 或 .csv 文件</p>
                    </Dragger>
                    <TextArea
                        rows={12}
                        value={importContent}
                        onChange={(e) => setImportContent(e.target.value)}
                        placeholder={`example@outlook.com${separator}client_id${separator}refresh_token`}
                    />
                </Space>
            </Modal>

            {/* 邮件列表 Modal */}
            {mailModalVisible && (
                <Modal
                    title={`${currentEmail} 的${currentMailbox === 'INBOX' ? '收件箱' : '垃圾箱'}`}
                    open={mailModalVisible}
                    onCancel={() => setMailModalVisible(false)}
                    footer={null}
                    destroyOnClose
                    width={1000}
                    styles={{ body: { padding: '16px 24px' } }}
                >
                    <Space style={{ marginBottom: 16 }}>
                        <Button type="primary" onClick={handleRefreshMails} loading={mailLoading}>
                            收取新邮件
                        </Button>
                        <Popconfirm
                            title={`确定要清空${currentMailbox === 'INBOX' ? '收件箱' : '垃圾箱'}的所有邮件吗？`}
                            onConfirm={handleClearMailbox}
                        >
                            <Button danger>清空</Button>
                        </Popconfirm>
                        <span style={{ marginLeft: 16, color: '#888' }}>
                            共 {mailList.length} 封邮件
                        </span>
                        {mailCacheInfo.cached && (
                            <Tooltip title="短时间内重复打开使用缓存，点「收取新邮件」强制实时拉取">
                                <Tag color="blue" style={{ marginLeft: 8 }}>
                                    缓存 {mailCacheInfo.cachedAt ? dayjs(mailCacheInfo.cachedAt).format('HH:mm:ss') : ''}
                                </Tag>
                            </Tooltip>
                        )}
                    </Space>
                    <List
                        loading={mailLoading}
                        dataSource={mailList}
                        itemLayout="horizontal"
                        pagination={{
                            pageSize: 10,
                            showSizeChanger: true,
                            showQuickJumper: true,
                            showTotal: (total: number) => `共 ${total} 条`,
                            style: { marginTop: 16 },
                        }}
                        style={{ maxHeight: 450, overflow: 'auto' }}
                        renderItem={(item: MailItem) => (
                            <List.Item
                                key={item.id}
                                actions={[
                                    <Button
                                        type="primary"
                                        size="small"
                                        onClick={() => handleViewEmailDetail(item)}
                                    >
                                        查看
                                    </Button>,
                                ]}
                            >
                                <List.Item.Meta
                                    title={
                                        <Space size={6}>
                                            {item.folder === 'junk' ? <Tag color="orange">垃圾箱</Tag> : null}
                                            <Typography.Text ellipsis style={{ maxWidth: 600 }}>
                                            {item.subject || '(无主题)'}
                                        </Typography.Text>
                                        </Space>
                                    }
                                    description={
                                        <Space size="large">
                                            <span style={{ color: '#1890ff' }}>{item.from || '未知发件人'}</span>
                                            <span style={{ color: '#999' }}>
                                                {item.date ? dayjs(item.date).format('YYYY-MM-DD HH:mm') : '-'}
                                            </span>
                                        </Space>
                                    }
                                />
                            </List.Item>
                        )}
                    />
                </Modal>
            )}

            {/* 邮件详情 Modal */}
            {emailDetailVisible && (
                <Modal
                    title={emailDetailSubject}
                    open={emailDetailVisible}
                    onCancel={() => setEmailDetailVisible(false)}
                    footer={null}
                    destroyOnClose
                    width={900}
                    styles={{ body: { padding: '16px 24px' } }}
                >
                    <Spin spinning={emailDetailLoading} tip="正在加载邮件正文...">
                        <iframe
                            title="email-content"
                            sandbox="allow-same-origin"
                            srcDoc={emailDetailSrcDoc}
                            style={{
                                width: '100%',
                                height: 'calc(100vh - 300px)',
                                border: '1px solid #eee',
                                borderRadius: '8px',
                                backgroundColor: '#fafafa',
                            }}
                        />
                    </Spin>
                </Modal>
            )}

            {/* 创建/编辑分组 Modal */}
            <Modal
                title={editingGroupId ? '编辑分组' : '创建分组'}
                open={groupModalVisible}
                onOk={handleGroupSubmit}
                onCancel={() => setGroupModalVisible(false)}
                destroyOnClose
                width={460}
            >
                <Form form={groupForm} layout="vertical">
                    <Form.Item name="name" label="分组名称" rules={[{ required: true, message: '请输入分组名称' }]}>
                        <Input placeholder="例如：aws、discord" />
                    </Form.Item>
                    <Form.Item name="description" label="描述">
                        <Input placeholder="可选描述" />
                    </Form.Item>
                    <Form.Item
                        name="fetchStrategy"
                        label="邮件拉取策略"
                        rules={[{ required: true, message: '请选择拉取策略' }]}
                    >
                        <Select options={MAIL_FETCH_STRATEGY_OPTIONS.map((option) => ({ value: option.value, label: option.label }))} />
                    </Form.Item>
                </Form>
            </Modal>

            {/* 批量分配分组 Modal */}
            <Modal
                title="分配邮箱到分组"
                open={assignGroupModalVisible}
                onOk={handleBatchAssignGroup}
                onCancel={() => setAssignGroupModalVisible(false)}
                destroyOnClose
                width={400}
            >
                <p>已选择 {selectedRowKeys.length} 个邮箱</p>
                <Select
                    placeholder="选择目标分组"
                    style={{ width: '100%' }}
                    value={assignTargetGroupId}
                    options={groupOptions}
                    onChange={setAssignTargetGroupId}
                />
            </Modal>
        </div>
    );
};

export default EmailsPage;
