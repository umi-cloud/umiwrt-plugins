import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isPort, isUint, base64Bytes, decodeBase64, planOptions } from '../src/validators.js';

test('端口与整数', () => {
	assert.ok(isPort('1') && isPort('65535') && !isPort('0') && !isPort('65536') && !isPort('80a'));
	assert.ok(isUint('0') && isUint('42') && !isUint('-1') && !isUint('1.5'));
});

test('Base64：URL 安全字符与缺失填充均可解码，非法输入为 null', () => {
	assert.equal(decodeBase64('5Lit5paH'), '中文');
	assert.equal(decodeBase64('YWJj'), 'abc');
	assert.equal(decodeBase64('YWJ'), 'ab');
	assert.equal(decodeBase64('YW-_'), null);
	assert.equal(decodeBase64('!!'), null);
	assert.equal(base64Bytes('AAAAAAAAAAAAAAAAAAAAAA==')?.length, 16);
	assert.equal(base64Bytes(''), null);
});

test('planOptions：按种类整理，空值删除已有项，不适用的受管键删除，bool 原值 0 保留', () => {
	const fields = { a: 'string', b: 'list', c: 'bool', d: 'bool', e: 'string' };
	const values = {}, remove = new Set();
	planOptions(fields, { a: ' x ', b: [' 1', '', '2'], c: false, d: false, e: 'gone' }, { a: 'old', b: ['9'], c: '1', d: '0', e: 'keep' }, values, remove, ['a', 'b', 'c', 'd']);
	assert.deepEqual(values, { a: 'x', b: ['1', '2'] });
	assert.deepEqual([...remove].sort(), ['c', 'e']);
});
