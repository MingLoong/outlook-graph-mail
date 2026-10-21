import assert from 'node:assert/strict';
import test from 'node:test';
import { isCacheFresh, normalizeMailboxName } from './mail.types.js';

void test('normalizeMailboxName 统一收件箱大小写', () => {
    assert.equal(normalizeMailboxName('inbox'), 'INBOX');
    assert.equal(normalizeMailboxName('INBOX'), 'INBOX');
    assert.equal(normalizeMailboxName('Inbox'), 'INBOX');
});

void test('normalizeMailboxName 其它文件夹保持原样', () => {
    assert.equal(normalizeMailboxName('Junk'), 'Junk');
    assert.equal(normalizeMailboxName('[Gmail]/Spam'), '[Gmail]/Spam');
    assert.equal(normalizeMailboxName(''), 'INBOX');
});

void test('isCacheFresh TTL 内命中', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    assert.equal(isCacheFresh(new Date(now - 30_000), 60, now), true);
    assert.equal(isCacheFresh(new Date(now), 60, now), true);
    assert.equal(isCacheFresh(new Date(now - 1000).toISOString(), 60, now), true);
});

void test('isCacheFresh 超过 TTL 未命中', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    assert.equal(isCacheFresh(new Date(now - 61_000), 60, now), false);
    assert.equal(isCacheFresh(new Date(now - 120_000).toISOString(), 60, now), false);
});

void test('isCacheFresh TTL<=0 禁用缓存', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    assert.equal(isCacheFresh(new Date(now), 0, now), false);
    assert.equal(isCacheFresh(new Date(now), -5, now), false);
});

void test('isCacheFresh 空值/非法日期未命中', () => {
    const now = Date.UTC(2026, 0, 1, 12, 0, 0);
    assert.equal(isCacheFresh(null, 60, now), false);
    assert.equal(isCacheFresh(undefined, 60, now), false);
    assert.equal(isCacheFresh('not-a-date', 60, now), false);
});
