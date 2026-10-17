# SPDX-License-Identifier: GPL-2.0-only
#
# 路由器终端的 Sight 页面与接口 sight.ttyd：按需启动一次性的 ttyd 会话（只监听 LAN 侧地址），终端由 ttyd 提供。

include $(TOPDIR)/rules.mk

PKG_NAME:=sight-app-ttyd
PKG_VERSION:=1.0.0
PKG_RELEASE:=2

PKG_LICENSE:=GPL-2.0-only
PKG_LICENSE_FILES:=LICENSE

include $(INCLUDE_DIR)/package.mk

define Package/sight-app-ttyd
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Web Servers/Proxies
  TITLE:=Terminal page for Sight
  PKGARCH:=all
  # sight.rpc 由 sight-ui 0.5.0 起提供，terminal 图标自 0.9.0 起
  EXTRA_DEPENDS:=sight-ui (>=0.9.0)
  DEPENDS:=+ttyd +rpcd +rpcd-mod-ucode +ucode-mod-fs +ucode-mod-uci +ucode-mod-ubus +ucode-mod-uloop +sight-ui
endef

define Package/sight-app-ttyd/description
  Open a root terminal on the router from the Sight UI. Each session is a
  one-time ttyd instance bound to a LAN address with a random path that
  accepts a single connection and ends when it is closed.
endef

define Build/Compile
endef

define Package/sight-app-ttyd/install
	$(INSTALL_DIR) $(1)/www
	$(CP) ./htdocs/* $(1)/www/
	$(CP) ./root/* $(1)/
endef

define Package/sight-app-ttyd/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/rpcd reload
exit 0
endef

# 卸载后重载 rpcd，撤下本包注册的接口与权限
define Package/sight-app-ttyd/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/rpcd reload
exit 0
endef

$(eval $(call BuildPackage,sight-app-ttyd))
