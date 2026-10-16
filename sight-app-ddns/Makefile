# SPDX-License-Identifier: GPL-2.0-only
#
# DDNS 的 Sight 页面、权限与状态接口 sight.ddns（移植自 luci-app-ddns，Apache-2.0）；服务本身由 ddns-scripts 提供。

include $(TOPDIR)/rules.mk

PKG_NAME:=sight-app-ddns
PKG_VERSION:=1.1.0
PKG_RELEASE:=1

# root/usr/share/rpcd/ucode/sight.ddns 为 Apache-2.0，其余为 GPL-2.0-only
PKG_LICENSE:=GPL-2.0-only Apache-2.0

include $(INCLUDE_DIR)/package.mk

define Package/sight-app-ddns
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Web Servers/Proxies
  TITLE:=DDNS page for Sight
  PKGARCH:=all
  DEPENDS:=+ddns-scripts +rpcd-mod-ucode +ucode-mod-fs +ucode-mod-math +ucode-mod-uci +sight-ui
endef

define Package/sight-app-ddns/description
  Manage DDNS from the Sight UI. Installs the page, its rpcd ACL and the
  sight.ddns status methods; the service itself comes from ddns-scripts.
endef

define Build/Compile
endef

define Package/sight-app-ddns/install
	$(INSTALL_DIR) $(1)/www
	$(CP) ./htdocs/* $(1)/www/
	$(CP) ./root/* $(1)/
endef

define Package/sight-app-ddns/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/rpcd reload
exit 0
endef

$(eval $(call BuildPackage,sight-app-ddns))
