# SPDX-License-Identifier: GPL-2.0-only
#
# Docker 的 Sight 页面：只含页面与它所需的权限，后端由 luci-app-dockerman 提供。

include $(TOPDIR)/rules.mk

PKG_NAME:=sight-app-docker
PKG_VERSION:=1.0.1
PKG_RELEASE:=1

PKG_LICENSE:=GPL-2.0-only

include $(INCLUDE_DIR)/package.mk

define Package/sight-app-docker
  SECTION:=luci
  CATEGORY:=LuCI
  SUBMENU:=3. Applications
  TITLE:=Docker page for Sight
  PKGARCH:=all
  DEPENDS:=+luci-app-dockerman +sight-ui
endef

define Package/sight-app-docker/description
  Manage Docker from the Sight UI. Installs the page and its rpcd ACL;
  the service itself comes from luci-app-dockerman.
endef

define Build/Compile
endef

define Package/sight-app-docker/install
	$(INSTALL_DIR) $(1)/www
	$(CP) ./htdocs/* $(1)/www/
	$(CP) ./root/* $(1)/
endef

define Package/sight-app-docker/postinst
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/rpcd reload
exit 0
endef

$(eval $(call BuildPackage,sight-app-docker))
