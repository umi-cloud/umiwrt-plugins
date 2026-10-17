# umiwrt-plugins

UmiWrt 自维护的应用 feed。每个目录是一个 OpenWrt 包，连同它在 [Sight](https://github.com/umi-cloud/sight-ui) 里的页面一起维护；许可证以各目录内的 LICENSE 为准。

| 目录 | 内容 | 上游与基线 |
|------|------|------------|
| `sight-app-homeproxy/` | HomeProxy 后端（sing-box 客户端）与 Sight 页面，不含 LuCI 界面，不依赖 luci-base | [immortalwrt/homeproxy](https://github.com/immortalwrt/homeproxy) `master` `98a6ad9` |
| `sight-app-ddns/` | DDNS 的 Sight 页面、权限与状态接口 `sight.ddns`（移植自 luci-app-ddns，Apache-2.0）；服务由 `ddns-scripts` 提供 | 页面原创；`sight.ddns` 取自 luci-app-ddns |
| `sight-app-docker/` | Docker 的 Sight 页面、权限与引擎接口 `docker.*`（移植自 luci-app-dockerman 的 rpcd 后端，Apache-2.0），以及本包新增的 `sight.docker`：日志、后台任务（`pull_start` 下载镜像、`recreate_start` 更新/编辑时重建容器并在失败时恢复原容器、`compose_start` Compose 项目启停与更新，`task_status` 查询）、Compose 项目文件（`compose_list`/`compose_read`/`compose_write`，存 `/etc/sight-docker/compose/`）、一次性容器终端（`terminal_start`/`terminal_status`/`terminal_stop`，ttyd 只监听 LAN 侧地址）；装包时预置国内镜像加速（只做一次）。引擎由 `dockerd` 提供，终端依赖 `ttyd` 与 `docker`（CLI），Compose 依赖 `docker-compose`；与 luci-app-dockerman 互斥 | 页面原创；`docker.*` 取自 luci-app-dockerman |

## 使用

```sh
echo "src-git umiwrt_plugins https://github.com/umi-cloud/umiwrt-plugins.git" >> feeds.conf.default
./scripts/feeds update umiwrt_plugins
./scripts/feeds install -a -p umiwrt_plugins
```

`sight-app-homeproxy` 声明了 `PROVIDES`/`CONFLICTS luci-app-homeproxy`，与 luci feed 里的原包二选一。

## 应用源

Sight 的应用市场从这里安装插件。推送到 `master` 后 CI（`.github/workflows/publish.yml`）在 ImmortalWrt SDK 镜像里编出全部 `sight-app-*`，生成签名索引与 `catalog.json`，发布到 gh-pages：

```
https://umi-cloud.github.io/umiwrt-plugins/sdk<N>/packages.adb
```

- `<N>` 是插件清单里的接口版本（sight-ui 的 `SDK_VERSION`），所有插件必须一致；旧目录保留给未升级的设备。
- 签名私钥放在仓库 Secrets 的 `SIGHT_APPS_SIGN_KEY`，公钥随 sight-ui 装到设备 `/etc/apk/keys/sight-apps.pem`。
- 发新版本要提高包的 `PKG_VERSION` 或 `PKG_RELEASE`，设备上才会出现「有更新」。
- 本地生成测试源：`SIGN_KEY="$(cat 私钥.pem)" docker run --rm -e SIGN_KEY -v $PWD:/src:ro -v /tmp/repo:/out immortalwrt/sdk:x86-64-openwrt-25.12 sh /src/scripts/build-repo.sh /src /out`（`/tmp/repo` 需对容器内 uid 1000 可写）。

## 包的结构

```
sight-app-<id>/
  Makefile
  root/                          后端：init 脚本、配置生成、rpcd 方法、默认配置（只带页面的包没有这部分，后端由依赖的包提供）
  root/usr/share/rpcd/acl.d/sight-plugin-<id>.json   Sight 页面所需的权限
  sight/                         Sight 页面源码（不进固件）
    plugin.json  src/  i18n/  test/  scripts/
  htdocs/sight-plugins/<id>/     页面构建产物，提交入库
```

页面与 Sight 共用运行时和组件，约定见 sight-ui 的 `docs/plugins.md`。

打包约定：

- 不依赖 LuCI（`luci-base`、`luci-app-*`）。需要的 LuCI 后端移植进本包，保留原版权与许可声明，`PKG_LICENSE` 列出全部许可证；`LICENSE` 放在包目录。
- 启动项操作调宿主的 `sight.setInitAction`，包里用 `EXTRA_DEPENDS:=sight-ui (>=0.4.0)` 约束宿主版本；rpcd 对象不要用 `luci.` 前缀（沿用上游名称的除外，如 `luci.homeproxy`）。
- 与提供同名 rpcd 对象的 LuCI 包用 `CONFLICTS` 互斥，不写 `PROVIDES luci-app-*`（会连带选中 LuCI 翻译包）。
- `postinst`、`postrm` 都重载 rpcd，装卸后接口与权限即时生效或撤下。
- 不移植把参数直接拼进 shell 的方法；需要执行命令时用参数数组。

## 开发

以下命令里 `SIGHT_UI` 指向 `umi-cloud/sight-ui` 仓库的本地检出。

```sh
# 构建页面（必须用 sight-ui 的工具，保证与宿主同一版本的 Svelte）
cd $SIGHT_UI && PLUGIN_DIR=/path/to/umiwrt-plugins/sight-app-homeproxy docker compose run --rm plugin-build

# 单元测试
cd sight-app-homeproxy && node --import $SIGHT_UI/scripts/sdk-register.mjs --test sight/test/*.test.mjs

# 真实流程（专用测试容器，会修改并恢复配置）
SIGHT_UI=$SIGHT_UI LUCI_URL=http://127.0.0.1:8143 CONTAINER=<容器名> node sight/scripts/flow-check.mjs
```

改了 `sight/` 下的源码后要重新构建并提交 `htdocs/sight-plugins/`。sight-ui 递增 `SDK_VERSION` 后，所有页面都要重新构建。

## 跟进上游

各包保留上游提交历史，按子目录合并：

```sh
git remote add homeproxy-upstream https://github.com/immortalwrt/homeproxy.git
git fetch homeproxy-upstream
git merge -X subtree=sight-app-homeproxy homeproxy-upstream/master
```

本仓库删掉了上游的 LuCI 界面（`htdocs/luci-static`、`menu.d`、`po/`）并重写了 `Makefile`，上游改到这些文件时合并会报冲突，保持删除、保留本仓库的 `Makefile` 即可。`root/etc/homeproxy/scripts/homeproxy.uc` 自带 URL 编解码（取代 `luci.http`，`update_subscriptions.uc` 改从 `homeproxy` 导入），上游改到这两处的 import 时保留本仓库的写法。合并后更新上表的基线。
