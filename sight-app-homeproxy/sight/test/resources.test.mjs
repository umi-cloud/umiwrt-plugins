import { test } from 'node:test';
import assert from 'node:assert/strict';
import { updateResult, missingResources, parseDomains, validDomains, collectDomains, changedLists } from '../src/resources.js';

test('规则库：缺失判断与更新状态码', () => {
	assert.deepEqual(missingResources('bypass_mainland_china', { china_ip4: '1', china_ip6: null, china_list: '', gfw_list: null }), ['china_ip6']);
	assert.deepEqual(missingResources('proxy_mainland_china', { china_ip4: '1', china_ip6: '1', china_list: '', gfw_list: null }), ['china_list']);
	assert.deepEqual(missingResources('gfwlist', null), []);
	assert.deepEqual(missingResources('global', {}), []);
	assert.deepEqual([{ status: 0 }, { status: 3 }, { status: 2 }, null].map(updateResult), ['updated', 'latest', 'busy', 'failed']);
});

test('域名列表：解析、校验、收集草稿、找出有变化的列表', () => {
	assert.deepEqual(parseDomains(' A.Example.com\r\n\nb.example\na.example.com'), ['a.example.com', 'b.example']);
	assert.ok(validDomains(['a.example']) && !validDomains(['-bad']));
	const next = collectDomains({ proxy_list: ['a.example'], direct_list: [] }, { proxy_list: 'b.example', direct_list: '' });
	assert.deepEqual(next, { proxy_list: ['a.example', 'b.example'], direct_list: [] });
	assert.deepEqual(changedLists(next, { proxy_list: ['a.example'], direct_list: [] }), ['proxy_list']);
});
