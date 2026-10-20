# SPDX-License-Identifier: GPL-2.0-only
#
# 广告过滤的 Sight 页面与权限：服务本身由 adblock-fast 提供；状态读 procd 服务数据，启停用宿主的 sight.setInitAction；
# 域名检查与限时暂停由本包的 rpcd 对象 sight.adblock-fast 提供。
# 安装时一次性把默认拦截列表换成国内常用的（uci-defaults/95-sight-adblock-fast-lists）。

include $(TOPDIR)/rules.mk

PKG_NAME:=sight-app-adblock-fast
PKG_VERSION:=1.3.1
PKG_RELEASE:=1

PKG_LICENSE:=GPL-2.0-only
PKG_LICENSE_FILES:=LICENSE

include $(INCLUDE_DIR)/package.mk

define Package/sight-app-adblock-fast
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Web Servers/Proxies
  TITLE:=Ad blocking page for Sight
  PKGARCH:=all
  # 启动项接口 sight.setInitAction 与 SDK 由 sight-ui 0.5.0 起提供
  EXTRA_DEPENDS:=sight-ui (>=0.5.0)
  DEPENDS:=+adblock-fast +sight-ui
endef

define Package/sight-app-adblock-fast/description
  Manage adblock-fast from the Sight UI: turn ad blocking on or off or pause
  it for a while, pick or add block-lists, add blocked or allowed domains,
  check whether a domain is blocked and see the current state.
endef

define Build/Compile
endef

define Package/sight-app-adblock-fast/install
	$(INSTALL_DIR) $(1)/www
	$(CP) ./htdocs/* $(1)/www/
	$(CP) ./root/* $(1)/
endef

define Package/sight-app-adblock-fast/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/rpcd reload
exit 0
endef

# 卸载后重载 rpcd，撤下本包的权限
define Package/sight-app-adblock-fast/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/rpcd reload
exit 0
endef

$(eval $(call BuildPackage,sight-app-adblock-fast))
