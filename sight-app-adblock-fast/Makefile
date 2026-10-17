# SPDX-License-Identifier: GPL-2.0-only
#
# 广告过滤的 Sight 页面与权限：只含页面，服务本身由 adblock-fast 提供；状态读 procd 服务数据，启停用宿主的 sight.setInitAction。

include $(TOPDIR)/rules.mk

PKG_NAME:=sight-app-adblock-fast
PKG_VERSION:=1.0.0
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
  Manage adblock-fast from the Sight UI: turn ad blocking on or off, pick
  block-lists, add blocked or allowed domains and see the current state.
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
