import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyCreate, validateCreate, buildCreate } from '../src/create.js';
import { memoryMb, parsePublish, parseVolume, parseMount, parseDockerRun } from '../src/dockerRun.js';
const container = (name, extra = {}) => ({ Id: name.padEnd(64, '0'), Names: ['/' + name], Image: 'busybox', ImageID: 'i', State: 'running', Status: 'Up', Ports: [], Labels: {}, NetworkSettings: { Networks: { bridge: {} } }, Mounts: [], ...extra });

const image = { Config: { Env: ['PATH=/usr/bin', 'APP_VERSION=1'], Cmd: ['httpd', '-f'], Entrypoint: null, WorkingDir: '/srv', ExposedPorts: { '80/tcp': {} }, Volumes: { '/cache': {} }, Labels: { maintainer: 'x', tier: 'base' } } };

test('docker run 导入：常见写法拆成表单，续行、合写短选项、= 写法与 sudo 前缀', () => {
	const r = parseDockerRun(`sudo docker run -dit --name=qb \\
		-p 8080:8080 -p 6881:6881/udp -p 127.0.0.1:9000:9000 \\
		-v /mnt/data/qb/config:/config -v downloads:/downloads:ro --mount type=bind,source=/mnt/media,target=/media,readonly \\
		-e PUID=1000 -e TZ=Asia/Shanghai --restart unless-stopped --network host --hostname qb.lan \\
		--device /dev/dri:/dev/dri --cap-add NET_ADMIN -m 1g --cpus 1.5 --log-opt max-size=10m --log-opt max-file=3 --privileged \\
		lscr.io/linuxserver/qbittorrent:latest sh -c "echo hi; sleep 1"`);
	assert.equal(r.image, 'lscr.io/linuxserver/qbittorrent:latest');
	assert.deepEqual(r.form, {
		name: 'qb', ports: [{ host: '8080', container: '8080', proto: 'tcp', ip: '' }, { host: '6881', container: '6881', proto: 'udp', ip: '' }, { host: '9000', container: '9000', proto: 'tcp', ip: '127.0.0.1' }],
		mounts: [{ host: '/mnt/data/qb/config', container: '/config', readonly: false }, { host: 'downloads', container: '/downloads', readonly: true }, { host: '/mnt/media', container: '/media', readonly: true }],
		env: ['PUID=1000', 'TZ=Asia/Shanghai'], restart: 'unless-stopped', network: 'host', hostname: 'qb.lan', devices: ['/dev/dri:/dev/dri'], caps: ['NET_ADMIN'],
		memory: '1024', cpus: '1.5', log: '10m:3', privileged: true, command: 'sh -c "echo hi; sleep 1"',
	});
	assert.deepEqual(r.warnings, []);
	/* 导入后的表单可直接通过校验并生成参数 */
	const form = { ...emptyCreate(), ...r.form, source: 'pull', pullRef: r.image };
	assert.deepEqual(validateCreate(form), []);
	assert.equal(buildCreate(form).body.HostConfig.Memory, 1024 * 1048576);
});

test('docker run 导入：不支持的参数逐条说明，不丢弃也不猜；不是 docker run 时报错', () => {
	const r = parseDockerRun('docker container run --rm -p 80 -v /data -e HOME --env-file .env -w /app --init -x --restart=on-failure:3 nginx');
	assert.equal(r.image, 'nginx:latest');
	assert.equal(r.form.restart, 'on-failure');
	const msgs = r.warnings.map(w => w.message);
	assert.ok(msgs.includes('--rm is not supported: the container is kept after it stops'));
	assert.ok(msgs.some(m => /^Port %s/.test(m)) && msgs.some(m => /^Volume %s/.test(m)) && msgs.some(m => /^Environment variable %s/.test(m)));
	assert.deepEqual(r.warnings.find(w => /were skipped/.test(w.message)).args, ['--env-file, -w, --init, -x']);
	assert.throws(() => parseDockerRun('podman run nginx'), /starts with docker run/);
	assert.throws(() => parseDockerRun('docker pull nginx'), /starts with docker run/);
	assert.throws(() => parseDockerRun('docker run -d --name x'), /No image/);
	assert.throws(() => parseDockerRun('docker run "nginx'), /unmatched quote/);
	assert.equal(parseDockerRun('docker run --log-opt max-size=5m nginx').warnings[0].message.startsWith('Log size'), true);
});

test('docker run 导入：内存、端口、卷与 --mount 的写法', () => {
	assert.deepEqual(['512m', '1g', '1.5G', '2048k', '1048576', 'x', '10k'].map(memoryMb), ['512', '1024', '1536', '2', '1', null, null]);
	assert.equal(parsePublish('8000-8010:8000-8010'), null);
	assert.equal(parsePublish('[::1]:80:80'), null);
	assert.deepEqual(parsePublish('0.0.0.0:53:53/udp'), { host: '53', container: '53', proto: 'udp', ip: '' });
	assert.equal(parseVolume('/data'), null);
	assert.equal(parseMount('type=tmpfs,target=/run'), null);
	assert.deepEqual(parseMount('source=vol,target=/v'), { host: 'vol', container: '/v', readonly: false });
});
