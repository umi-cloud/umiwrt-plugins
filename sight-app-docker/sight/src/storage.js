/* 存储空间与数据目录：各项占用、可放数据的磁盘、数据目录所在文件系统的问题、迁移计划（纯函数） */
import { PROJECT_LABEL } from './compose.js';
import { BUILTIN_NETWORKS } from './resources.js';

/* dockerd 未设置 data_root 时 init 脚本的缺省值 */
export const DEFAULT_DATA_ROOT = '/opt/docker/';

/**
 * 纯函数：system/df + 整形后的列表 → 存储空间各项 { size, reclaimable, count }，size 取不到为 null。
 * 镜像的可清理量为没有容器使用的镜像大小之和（共享的层可能重复计入，只作估计）；
 * 容器为可写层大小，可清理的是已停止的容器；卷为没有容器使用的。
 */
export function storageOf(df, images, containers, volumes) {
	const unusedImages = (images || []).filter(i => !i.containers);
	const rw = {};
	for (const c of df?.Containers || []) if (c.SizeRw >= 0) rw[c.Id] = c.SizeRw;
	const stopped = (containers || []).filter(c => c.state !== 'running' && c.state !== 'restarting' && c.state !== 'paused');
	const vols = Array.isArray(volumes) ? volumes : [];
	const unusedVolumes = vols.filter(v => !v.containers.length);
	const sum = list => list.reduce((n, x) => n + (x ?? 0), 0);
	return {
		images: { size: df?.LayersSize ?? null, reclaimable: sum(unusedImages.map(i => i.size)), count: unusedImages.length },
		containers: { size: df?.Containers ? sum(Object.values(rw)) : null, reclaimable: sum(stopped.map(c => rw[c.id])), count: stopped.length, items: stopped },
		volumes: { size: vols.some(v => v.size != null) ? sum(vols.map(v => v.size)) : null, reclaimable: sum(unusedVolumes.map(v => v.size)), count: unusedVolumes.length },
	};
}

/* Docker 的 overlay2 需要支持 d_type 的 Linux 文件系统；vfat、exFAT、NTFS 放不了数据 */
const DOCKER_FS = ['ext4', 'xfs', 'btrfs', 'f2fs'];

/**
 * 纯函数：宿主 sight.storage.list → 可放 Docker 数据的盘：已挂载的（usable）、文件系统合适但未挂载的（unmounted，可挂载后使用），
 * 以及文件系统不合适的（unsupported）；系统卷不列。
 */
export function diskChoices(storage) {
	const usable = [], unmounted = [], unsupported = [];
	for (const d of storage?.disks || []) for (const v of d.volumes || []) {
		if (v.system || !v.fstype || v.fstype === 'swap') continue;
		const title = v.label || v.partname || v.name;
		if (!v.mounts?.length) {
			if (DOCKER_FS.includes(v.fstype)) unmounted.push({ device: v.device, name: v.name, title, fstype: v.fstype, size: v.size });
			continue;
		}
		if (!v.usage) continue;
		const item = { mount: v.mounts[0], device: v.device, title, fstype: v.fstype, free: v.usage.avail, size: v.usage.size };
		(DOCKER_FS.includes(v.fstype) ? usable : unsupported).push(item);
	}
	usable.sort((a, b) => b.free - a.free);
	unmounted.sort((a, b) => b.size - a.size);
	return { usable, unmounted, unsupported };
}

/** 纯函数：给未挂载的盘取挂载点 /mnt/<卷标或分区名>（只留安全字符）；与已有挂载点重名时用设备名 */
export function mountTargetFor(disk, used = []) {
	const slug = s => String(s || '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|-+$/g, '').slice(0, 32);
	const first = `/mnt/${slug(disk.title) || slug(disk.name) || 'data'}`;
	return used.includes(first) ? `/mnt/${slug(disk.name) || 'data'}` : first;
}

/* 放不了 overlay 存储的文件系统：overlay 不能叠在 overlay 上（OpenWrt 根目录即 overlay），FAT/exFAT/NTFS 不支持所需特性 */
const OVERLAY_UNSUPPORTED = ['overlay', 'aufs', 'vfat', 'msdos', 'exfat', 'ntfs', 'ntfs3', 'fuseblk', 'squashfs', 'jffs2'];

/**
 * 纯函数：root_status → 数据目录的问题：'shadowed'（运行中被新挂载的盘盖住，需重启）、'unsupported'（文件系统放不了，容器建不起来）、
 * 'temporary'（在内存里，重启路由器后丢失）或 ''
 */
export function rootProblem(s) {
	if (!s?.root) return '';
	if (s.shadowed) return 'shadowed';
	if (/overlay/.test(s.driver || '') && OVERLAY_UNSUPPORTED.includes(s.fstype)) return 'unsupported';
	if (s.fstype === 'tmpfs') return 'temporary';
	return '';
}

/** 纯函数：网络列表的原始数据 → 迁移时新建用的参数；内置网络与 Compose 项目的网络（由 compose 重建）不迁 */
export function migrationNetworks(networks) {
	return (networks || []).filter(n => !BUILTIN_NETWORKS.includes(n.Name) && !n.Labels?.[PROJECT_LABEL]).map(n => ({
		Name: n.Name, Driver: n.Driver || 'bridge', CheckDuplicate: true,
		...(n.Options && Object.keys(n.Options).length ? { Options: n.Options } : {}),
		...(n.IPAM?.Config?.length ? { IPAM: { Driver: n.IPAM.Driver || 'default', Config: n.IPAM.Config.map(c => Object.fromEntries(['Subnet', 'Gateway', 'IPRange'].filter(k => c[k]).map(k => [k, c[k]]))) } } : {}),
		...(n.Internal ? { Internal: true } : {}), ...(n.Labels && Object.keys(n.Labels).length ? { Labels: n.Labels } : {}),
	}));
}

/** 纯函数：目录落在哪块盘上（取最长的挂载点前缀）；不在任何数据盘上返回 null */
export function diskOf(dir, usable) {
	const path = (dir || DEFAULT_DATA_ROOT).replace(/\/+$/, '');
	return usable.filter(d => path === d.mount || path.startsWith(d.mount + '/')).sort((a, b) => b.mount.length - a.mount.length)[0] || null;
}

/** 纯函数：两个目录是否相同（忽略末尾的 /） */
export const sameDir = (a, b) => String(a || '').replace(/\/+$/, '') === String(b || '').replace(/\/+$/, '');
