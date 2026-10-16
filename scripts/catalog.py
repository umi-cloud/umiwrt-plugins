#!/usr/bin/env python3
"""生成应用市场目录 catalog.json：取各插件已构建页面的 manifest.json 与中文词典，只留展示所需字段。
用法：catalog.py <插件仓库> <输出文件>；标准输出打印插件接口版本（SDK_VERSION），用作发布目录名。"""
import json
import pathlib
import sys

root, output = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
apps, sdks = [], set()
for path in sorted(root.glob('sight-app-*/htdocs/sight-plugins/*/manifest.json')):
	m = json.loads(path.read_text())
	if m['package'] != path.parts[-5]:
		sys.exit(f'{path}：package 与目录名不一致')
	sdks.add(m['sdk'])
	app = {k: m[k] for k in ('id', 'package', 'title', 'description', 'icon') if k in m}
	zh_file = m.get('locales', {}).get('zh')
	if zh_file:
		zh = json.loads((path.parent / zh_file).read_text())
		texts = {k: zh[m[k]] for k in ('title', 'description') if m.get(k) in zh}
		if texts:
			app['locales'] = {'zh': texts}
	apps.append(app)

if len(sdks) != 1:
	sys.exit(f'插件的接口版本不一致或没有插件：{sorted(sdks)}')
sdk = sdks.pop()
output.write_text(json.dumps({'sdk': sdk, 'apps': apps}, ensure_ascii=False, indent='\t') + '\n')
print(sdk)
