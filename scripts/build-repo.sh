#!/bin/sh
# 在 ImmortalWrt SDK 容器内（工作目录为 SDK 根）编出全部 sight-app-* 包，
# 生成签名的 apk 源 packages.adb 与展示用的 catalog.json，输出到 <输出目录>/sdk<N>/。
# 用法：build-repo.sh <插件仓库> <输出目录>；签名私钥（PEM）经环境变量 SIGN_KEY 传入。
set -eu
src="$1" out="$2" sdk_root="$PWD"
apk="$sdk_root/staging_dir/host/bin/apk"
[ -n "${SIGN_KEY:-}" ] || { echo "缺少签名私钥 SIGN_KEY" >&2; exit 1; }

key="$(mktemp)"
trap 'rm -f "$key"' EXIT
printf '%s\n' "$SIGN_KEY" > "$key"

# 插件都是数据包（PKGARCH all），依赖只记入元数据，不需要其它 feed
echo "src-link umiwrt_plugins $src" > feeds.conf
./scripts/feeds update umiwrt_plugins
./scripts/feeds install -a -p umiwrt_plugins
make defconfig >/dev/null

for dir in "$src"/sight-app-*/; do
	pkg="$(basename "$dir")"
	echo "编译 $pkg"
	make "package/$pkg/compile" >/dev/null 2>&1 || make "package/$pkg/compile" V=s
done

sdk="$(python3 "$src/scripts/catalog.py" "$src" "$out/catalog.json")"
dest="$out/sdk$sdk"
rm -rf "$dest"
mkdir -p "$dest"
mv "$out/catalog.json" "$dest/"
cp bin/packages/*/umiwrt_plugins/sight-app-*.apk "$dest/"
cd "$dest"
"$apk" mkndx --root "$sdk_root" --keys-dir "$sdk_root" --allow-untrusted --sign "$key" --output packages.adb sight-app-*.apk
ls -l "$dest"
