#!/usr/bin/ucode
'use strict';
/*
 * Sight 迁移：把 homeproxy 里会被按名引用的匿名段改成具名段，并替换所有引用。
 * 匿名段名（cfgXXXXXX）含它在文件中的位置，前面的段增删后会变，主节点、出站、规则引用它会悄悄失效。
 * 新名与 Sight 页面一致：<前缀>_<8 位十六进制>。可重复执行，没有匿名段时不改动。
 */
import { cursor } from 'uci';
import { open } from 'fs';

const PREFIX = { node: 'node', routing_node: 'out', routing_rule: 'rule', ruleset: 'ruleset', dns_server: 'dns', dns_rule: 'dnsrule' };
const uci = cursor();
uci.load('homeproxy');

const urandom = open('/dev/urandom');
function random_hex() {
	return join('', map(split(urandom.read(4), ''), c => sprintf('%02x', ord(c))));
}

const taken = {}, renames = {};
uci.foreach('homeproxy', null, s => { taken[s['.name']] = true; });
uci.foreach('homeproxy', null, s => {
	const prefix = PREFIX[s['.type']];
	if (!prefix || !s['.anonymous'])
		return;
	let name = `${prefix}_${random_hex()}`;
	while (taken[name])
		name = `${prefix}_${random_hex()}`;
	taken[name] = true;
	renames[s['.name']] = name;
});
urandom.close();

if (!length(renames))
	exit(0);

for (let old, name in renames)
	uci.rename('homeproxy', old, name);

/* 引用可能在任意段的任意选项里，单值或列表项 */
uci.foreach('homeproxy', null, s => {
	for (let k, v in s) {
		if (substr(k, 0, 1) == '.')
			continue;
		if (type(v) == 'array') {
			if (length(filter(v, x => x in renames)))
				uci.set('homeproxy', s['.name'], k, map(v, x => renames[x] ?? x));
		} else if (v in renames) {
			uci.set('homeproxy', s['.name'], k, renames[v]);
		}
	}
});

uci.commit('homeproxy');
