import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createProxySchema, testProxySchema } from './proxy.schema.js';

void test('SSH 代理缺少主机或用户名时报错', () => {
    const result = createProxySchema.safeParse({ name: 'jump', type: 'SSH', authType: 'KEY', privateKey: 'key' });
    assert.equal(result.success, false);
    if (!result.success) {
        const paths = result.error.issues.map((i) => i.path.join('.'));
        assert.ok(paths.includes('sshHost'));
        assert.ok(paths.includes('sshUser'));
    }
});

void test('SSH 密钥认证缺少私钥时报错', () => {
    const result = createProxySchema.safeParse({
        name: 'jump',
        type: 'SSH',
        sshHost: '1.2.3.4',
        sshUser: 'root',
        authType: 'KEY',
    });
    assert.equal(result.success, false);
    if (!result.success) {
        assert.ok(result.error.issues.some((i) => i.path.join('.') === 'privateKey'));
    }
});

void test('SSH 密码认证缺少密码时报错', () => {
    const result = createProxySchema.safeParse({
        name: 'jump',
        type: 'SSH',
        sshHost: '1.2.3.4',
        sshUser: 'root',
        authType: 'PASSWORD',
    });
    assert.equal(result.success, false);
    if (!result.success) {
        assert.ok(result.error.issues.some((i) => i.path.join('.') === 'password'));
    }
});

void test('SOCKS5 / HTTP 需要代理地址', () => {
    for (const type of ['SOCKS5', 'HTTP'] as const) {
        const result = createProxySchema.safeParse({ name: `p-${type}`, type });
        assert.equal(result.success, false);
        if (!result.success) {
            assert.ok(result.error.issues.some((i) => i.path.join('.') === 'url'));
        }
    }
});

void test('完整的 SSH 密钥配置可以通过', () => {
    const result = createProxySchema.safeParse({
        name: '国内跳板机',
        type: 'SSH',
        sshHost: '8.134.156.173',
        sshPort: 22,
        sshUser: 'root',
        authType: 'KEY',
        privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----',
        enabled: true,
    });
    assert.equal(result.success, true);
    if (result.success) {
        assert.equal(result.data.sshPort, 22);
        assert.equal(result.data.enabled, true);
    }
});

void test('测试接口允许不传探测目标', () => {
    assert.equal(testProxySchema.safeParse({}).success, true);
    const withTargets = testProxySchema.safeParse({ targets: [{ host: 'imap.163.com', port: 993 }] });
    assert.equal(withTargets.success, true);
});
