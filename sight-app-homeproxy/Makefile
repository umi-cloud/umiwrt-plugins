# SPDX-License-Identifier: GPL-2.0-only
#
# Copyright (C) 2022-2023 ImmortalWrt.org
#
# HomeProxy 后端（源自 immortalwrt/homeproxy）与它的 Sight 页面；不含 LuCI 界面。

include $(TOPDIR)/rules.mk

PKG_NAME:=sight-app-homeproxy
PKG_VERSION:=1.5.1
PKG_RELEASE:=1

PKG_LICENSE:=GPL-2.0-only
PKG_LICENSE_FILES:=LICENSE

include $(INCLUDE_DIR)/package.mk

define Package/sight-app-homeproxy
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Web Servers/Proxies
  TITLE:=HomeProxy (sing-box) for Sight
  PKGARCH:=all
  # 启动项等系统接口由 sight-ui 0.4.0 起自带的 sight 对象提供
  EXTRA_DEPENDS:=sight-ui (>=0.5.0)
  DEPENDS:= \
	+sing-box \
	+firewall4 \
	+kmod-nft-tproxy \
	+ucode-mod-digest \
	+rpcd +rpcd-mod-ucode \
	+ucode-mod-fs \
	+ucode-mod-math \
	+ucode-mod-socket \
	+ucode-mod-ubus \
	+ucode-mod-uci \
	+sight-ui
  # 只声明互斥，不 PROVIDES luci-app-homeproxy：否则会连带选中 LuCI 的翻译包
  CONFLICTS:=luci-app-homeproxy
endef

define Package/sight-app-homeproxy/description
  The HomeProxy proxy platform (sing-box client) managed from the Sight UI.
  Ships the HomeProxy backend and its Sight page; the LuCI views are not included.
endef

define Package/sight-app-homeproxy/conffiles
/etc/config/homeproxy
/etc/homeproxy/certs/
/etc/homeproxy/ruleset/
/etc/homeproxy/resources/direct_list.txt
/etc/homeproxy/resources/proxy_list.txt
endef

define Build/Compile
endef

define Package/sight-app-homeproxy/install
	$(INSTALL_DIR) $(1)/www
	$(CP) ./htdocs/* $(1)/www/
	$(CP) ./root/* $(1)/
endef

define Package/sight-app-homeproxy/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/rpcd reload
exit 0
endef

# 卸载后重载 rpcd，撤下本包注册的接口与权限
define Package/sight-app-homeproxy/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/rpcd reload
exit 0
endef

$(eval $(call BuildPackage,sight-app-homeproxy))
