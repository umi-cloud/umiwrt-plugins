# umiwrt-plugins

UmiWrt 自维护的应用 feed。每个目录是一个 OpenWrt 包，连同它在 [Sight](https://github.com/umi-cloud/luci-theme-sight) 里的页面一起维护；许可证以各目录内的 LICENSE 为准。

| 目录 | 内容 | 上游与基线 |
|------|------|------------|
| `sight-app-homeproxy/` | HomeProxy 后端（sing-box 客户端）与 Sight 页面，不含 LuCI 界面 | [immortalwrt/homeproxy](https://github.com/immortalwrt/homeproxy) `master` `98a6ad9` |
| `sight-app-ddns/` | DDNS 的 Sight 页面与权限；后端依赖 `luci-app-ddns` | 无（本仓库原创） |
| `sight-app-docker/` | Docker 的 Sight 页面与权限；后端依赖 `luci-app-dockerman` | 无（本仓库原创） |

## 使用

```sh
echo "src-git umiwrt_plugins https://github.com/umi-cloud/umiwrt-plugins.git" >> feeds.conf.default
./scripts/feeds update umiwrt_plugins
./scripts/feeds install -a -p umiwrt_plugins
```

`sight-app-homeproxy` 声明了 `PROVIDES`/`CONFLICTS luci-app-homeproxy`，与 luci feed 里的原包二选一。

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

## 开发

以下命令里 `SIGHT_UI` 指向 `luci-theme-sight/sight-ui` 的本地检出。

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

本仓库删掉了上游的 LuCI 界面（`htdocs/luci-static`、`menu.d`、`po/`）并重写了 `Makefile`，上游改到这些文件时合并会报冲突，保持删除、保留本仓库的 `Makefile` 即可。合并后更新上表的基线。
