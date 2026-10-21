import React, { useCallback, useEffect, useState } from 'react';
import {
    Alert,
    Button,
    Card,
    Form,
    Input,
    InputNumber,
    Modal,
    Popconfirm,
    Radio,
    Select,
    Space,
    Switch,
    Table,
    Tag,
    Typography,
    message,
} from 'antd';
import { CloudServerOutlined, DeleteOutlined, EditOutlined, PlusOutlined, ThunderboltOutlined } from '@ant-design/icons';
import { proxyApi, type ProxyConfigItem, type ProxyTestResult } from '../../api';

const { Text, Paragraph } = Typography;

const TYPE_LABEL: Record<string, { color: string; text: string }> = {
    SSH: { color: 'blue', text: 'SSH 隧道' },
    SOCKS5: { color: 'purple', text: 'SOCKS5' },
    HTTP: { color: 'cyan', text: 'HTTP' },
};

const ProxyPage: React.FC = () => {
    const [loading, setLoading] = useState(false);
    const [list, setList] = useState<ProxyConfigItem[]>([]);
    const [modalOpen, setModalOpen] = useState(false);
    const [editing, setEditing] = useState<ProxyConfigItem | null>(null);
    const [saving, setSaving] = useState(false);
    const [testing, setTesting] = useState<number | null>(null);
    const [testResult, setTestResult] = useState<{ id: number; result: ProxyTestResult } | null>(null);
    const [form] = Form.useForm();
    const proxyType = Form.useWatch('type', form) || 'SSH';
    const authType = Form.useWatch('authType', form) || 'KEY';

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const res = await proxyApi.getList();
            setList((res.data as ProxyConfigItem[]) || []);
        } catch (err) {
            message.error(err instanceof Error ? err.message : '加载代理配置失败');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const openCreate = () => {
        setEditing(null);
        form.resetFields();
        form.setFieldsValue({ type: 'SSH', sshPort: 22, authType: 'KEY', enabled: true });
        setTestResult(null);
        setModalOpen(true);
    };

    const openEdit = (record: ProxyConfigItem) => {
        setEditing(record);
        form.resetFields();
        form.setFieldsValue({
            name: record.name,
            type: record.type,
            url: record.url || undefined,
            sshHost: record.sshHost || undefined,
            sshPort: record.sshPort || 22,
            sshUser: record.sshUser || undefined,
            authType: record.authType,
            enabled: record.enabled,
        });
        setTestResult(null);
        setModalOpen(true);
    };

    const handleSave = async () => {
        const values = await form.validateFields();
        setSaving(true);
        try {
            if (editing) {
                await proxyApi.update(editing.id, values);
                message.success('代理配置已更新');
            } else {
                await proxyApi.create(values);
                message.success('代理配置已创建');
            }
            setModalOpen(false);
            await load();
        } catch (err) {
            message.error(err instanceof Error ? err.message : '保存失败');
        } finally {
            setSaving(false);
        }
    };

    const handleTest = async (record: ProxyConfigItem) => {
        setTesting(record.id);
        try {
            const res = await proxyApi.test(record.id);
            const result = res.data as ProxyTestResult;
            setTestResult({ id: record.id, result });
            if (result?.ok) {
                message.success('连接测试通过');
            } else {
                message.warning(result?.loginError || '连接测试未通过');
            }
            await load();
        } catch (err) {
            message.error(err instanceof Error ? err.message : '测试失败');
        } finally {
            setTesting(null);
        }
    };

    const handleDelete = async (record: ProxyConfigItem) => {
        try {
            await proxyApi.delete(record.id);
            message.success('已删除');
            await load();
        } catch (err) {
            message.error(err instanceof Error ? err.message : '删除失败');
        }
    };

    const columns = [
        {
            title: '名称',
            dataIndex: 'name',
            render: (name: string, record: ProxyConfigItem) => (
                <Space direction="vertical" size={0}>
                    <Text strong>{name}</Text>
                    <Text type="secondary" style={{ fontSize: 12 }}>
                        {record.type === 'SSH'
                            ? `${record.sshUser}@${record.sshHost}:${record.sshPort}`
                            : record.url || '-'}
                    </Text>
                </Space>
            ),
        },
        {
            title: '类型',
            dataIndex: 'type',
            width: 110,
            render: (type: string) => {
                const meta = TYPE_LABEL[type] || { color: 'default', text: type };
                return <Tag color={meta.color}>{meta.text}</Tag>;
            },
        },
        {
            title: '认证',
            width: 130,
            render: (_: unknown, record: ProxyConfigItem) =>
                record.type === 'SSH' ? (
                    <Space size={4} wrap>
                        <Tag>{record.authType === 'KEY' ? '私钥' : '密码'}</Tag>
                        {record.hasPrivateKey && record.authType === 'KEY' ? <Tag color="green">已配置</Tag> : null}
                        {record.hasPassword && record.authType === 'PASSWORD' ? <Tag color="green">已配置</Tag> : null}
                    </Space>
                ) : (
                    <Text type="secondary">-</Text>
                ),
        },
        {
            title: '状态',
            width: 150,
            render: (_: unknown, record: ProxyConfigItem) => (
                <Space direction="vertical" size={0}>
                    <Tag color={record.enabled ? 'green' : 'default'}>{record.enabled ? '已启用' : '已停用'}</Tag>
                    {record.lastError ? (
                        <Text type="danger" style={{ fontSize: 12 }} ellipsis={{ tooltip: record.lastError }}>
                            {record.lastError}
                        </Text>
                    ) : record.lastCheckedAt ? (
                        <Text type="secondary" style={{ fontSize: 12 }}>
                            正常
                        </Text>
                    ) : null}
                </Space>
            ),
        },
        {
            title: '操作',
            width: 230,
            render: (_: unknown, record: ProxyConfigItem) => (
                <Space size={4}>
                    <Button
                        size="small"
                        icon={<ThunderboltOutlined />}
                        loading={testing === record.id}
                        onClick={() => void handleTest(record)}
                    >
                        测试
                    </Button>
                    <Button size="small" icon={<EditOutlined />} onClick={() => openEdit(record)}>
                        编辑
                    </Button>
                    <Popconfirm title="确定删除该代理配置？" onConfirm={() => void handleDelete(record)}>
                        <Button size="small" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                </Space>
            ),
        },
    ];

    return (
        <div>
            <Card
                title={
                    <Space>
                        <CloudServerOutlined />
                        代理配置
                    </Space>
                }
                extra={
                    <Button type="primary" icon={<PlusOutlined />} onClick={openCreate}>
                        新建代理
                    </Button>
                }
            >
                <Alert
                    type="info"
                    showIcon
                    style={{ marginBottom: 16 }}
                    message="使用说明"
                    description={
                        <div>
                            <Paragraph style={{ marginBottom: 4 }}>
                                <b>SSH 隧道</b>：填一台能访问目标邮箱的机器（跳板机），邮件收发会从它出口。适合海外服务器访问国内邮箱、或国内服务器访问
                                Gmail。
                            </Paragraph>
                            <Paragraph style={{ marginBottom: 0 }}>
                                配置后到「邮箱管理」把账号的代理设为该配置即可生效。密码/私钥加密存储，接口不会回显。
                            </Paragraph>
                        </div>
                    }
                />

                <Table
                    rowKey="id"
                    size="small"
                    loading={loading}
                    dataSource={list}
                    columns={columns}
                    pagination={false}
                />

                {testResult ? (
                    <Card size="small" style={{ marginTop: 16 }} title={`测试结果 · ${testResult.result.type}`}>
                        <Space direction="vertical" style={{ width: '100%' }}>
                            <Text>
                                SSH 登录：{testResult.result.loginOk ? <Tag color="green">成功</Tag> : <Tag color="red">失败</Tag>}
                            </Text>
                            {testResult.result.targets.map((t) => (
                                <Text key={`${t.host}:${t.port}`}>
                                    {t.ok ? '✅' : '❌'} {t.host}:{t.port}
                                    {t.ok && t.ms ? ` · ${t.ms} ms` : ''}
                                    {!t.ok && t.error ? ` · ${t.error}` : ''}
                                </Text>
                            ))}
                        </Space>
                    </Card>
                ) : null}
            </Card>

            <Modal
                title={editing ? '编辑代理配置' : '新建代理配置'}
                open={modalOpen}
                onCancel={() => setModalOpen(false)}
                onOk={() => void handleSave()}
                confirmLoading={saving}
                width={640}
                destroyOnClose
            >
                <Form form={form} layout="vertical" initialValues={{ type: 'SSH', sshPort: 22, authType: 'KEY', enabled: true }}>
                    <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
                        <Input placeholder="例如：国内跳板机" maxLength={50} />
                    </Form.Item>
                    <Form.Item name="type" label="类型" rules={[{ required: true }]}>
                        <Radio.Group optionType="button" buttonStyle="solid">
                            <Radio.Button value="SSH">SSH 隧道</Radio.Button>
                            <Radio.Button value="SOCKS5">SOCKS5</Radio.Button>
                            <Radio.Button value="HTTP">HTTP</Radio.Button>
                        </Radio.Group>
                    </Form.Item>

                    {proxyType === 'SSH' ? (
                        <>
                            <Space style={{ display: 'flex' }} size={12}>
                                <Form.Item
                                    name="sshHost"
                                    label="SSH 主机"
                                    rules={[{ required: true, message: '请输入主机地址' }]}
                                    style={{ flex: 2, minWidth: 240 }}
                                >
                                    <Input placeholder="IP 或域名" />
                                </Form.Item>
                                <Form.Item name="sshPort" label="端口" style={{ width: 110 }}>
                                    <InputNumber min={1} max={65535} style={{ width: '100%' }} />
                                </Form.Item>
                            </Space>
                            <Form.Item name="sshUser" label="用户名" rules={[{ required: true, message: '请输入用户名' }]}>
                                <Input placeholder="root" />
                            </Form.Item>
                            <Form.Item name="authType" label="认证方式">
                                <Radio.Group>
                                    <Radio value="KEY">私钥（推荐）</Radio>
                                    <Radio value="PASSWORD">密码</Radio>
                                </Radio.Group>
                            </Form.Item>
                            {authType === 'PASSWORD' ? (
                                <>
                                    <Form.Item
                                        name="password"
                                        label="密码"
                                        rules={editing?.hasPassword ? [] : [{ required: true, message: '请输入密码' }]}
                                    >
                                        <Input.Password
                                            autoComplete="new-password"
                                            placeholder={editing?.hasPassword ? '留空表示不修改' : 'SSH 登录密码'}
                                        />
                                    </Form.Item>
                                    <Form.Item name="privateKey" hidden>
                                        <Input />
                                    </Form.Item>
                                </>
                            ) : (
                                <>
                                    <Form.Item
                                        name="privateKey"
                                        label="私钥"
                                        rules={editing?.hasPrivateKey ? [] : [{ required: true, message: '请粘贴私钥内容' }]}
                                        extra={
                                            editing?.hasPrivateKey
                                                ? `已配置：${editing.privateKeyPreview || '（已加密保存）'}，留空表示不修改`
                                                : '粘贴 OpenSSH 私钥全文（以 -----BEGIN 开头），推荐 ed25519'
                                        }
                                    >
                                        <Input.TextArea rows={5} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" />
                                    </Form.Item>
                                    <Form.Item
                                        name="passphrase"
                                        label="私钥口令"
                                        extra={editing?.hasPassphrase ? '已配置，留空表示不修改' : '私钥无口令则留空'}
                                    >
                                        <Input.Password autoComplete="new-password" placeholder="可选" />
                                    </Form.Item>
                                </>
                            )}
                        </>
                    ) : (
                        <Form.Item
                            name="url"
                            label="代理地址"
                            rules={[{ required: true, message: '请输入代理地址' }]}
                            extra={proxyType === 'SOCKS5' ? '例如：socks5://1.2.3.4:1080' : '例如：http://1.2.3.4:8080'}
                        >
                            <Input placeholder={proxyType === 'SOCKS5' ? 'socks5://host:port' : 'http://host:port'} />
                        </Form.Item>
                    )}

                    <Form.Item name="enabled" label="启用" valuePropName="checked">
                        <Switch />
                    </Form.Item>
                </Form>
            </Modal>
        </div>
    );
};

export default ProxyPage;
