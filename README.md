# umiwrt-plugins

UmiWrt 自维护的插件 feed。每个目录是一个 OpenWrt 包，许可证以各目录内的 LICENSE 为准。

| 目录 | 上游 | 基线 |
|------|------|------|
| `luci-app-homeproxy/` | [immortalwrt/homeproxy](https://github.com/immortalwrt/homeproxy) `master` | `98a6ad9` |

## 使用

```sh
echo "src-git umiwrt_plugins https://github.com/umi-cloud/umiwrt-plugins.git" >> feeds.conf.default
./scripts/feeds update umiwrt_plugins
./scripts/feeds install -f -p umiwrt_plugins -a
```

`-f` 让本 feed 的同名包覆盖 luci feed 中的版本。

## 跟进上游

各包保留上游提交历史，按子目录合并：

```sh
git remote add homeproxy-upstream https://github.com/immortalwrt/homeproxy.git
git fetch homeproxy-upstream
git merge -X subtree=luci-app-homeproxy homeproxy-upstream/master
```

合并后更新上表的基线。新增其他插件用 `git subtree add --prefix=<目录> <上游> <分支>`。
