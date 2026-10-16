# SPDX-License-Identifier: GPL-2.0-only
#
# Docker 的 Sight 页面、权限与引擎接口（docker.*，移植自 luci-app-dockerman 的 rpcd 后端，Apache-2.0）；
# 引擎由 dockerd 提供。与 luci-app-dockerman 注册同名对象，二者互斥。

include $(TOPDIR)/rules.mk

PKG_NAME:=sight-app-docker
PKG_VERSION:=1.1.0
PKG_RELEASE:=2

# root/usr/share/rpcd/ucode/sight.docker 与 root/usr/share/ucode/sight/docker_socket.uc 为 Apache-2.0
PKG_LICENSE:=GPL-2.0-only Apache-2.0
PKG_LICENSE_FILES:=LICENSE

include $(INCLUDE_DIR)/package.mk

define Package/sight-app-docker
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Web Servers/Proxies
  TITLE:=Docker page for Sight
  PKGARCH:=all
  DEPENDS:=@(aarch64||arm||x86_64) +dockerd +docker +rpcd-mod-ucode +ucode-mod-fs +ucode-mod-socket +ucode-mod-uci +sight-ui
  CONFLICTS:=luci-app-dockerman
endef

define Package/sight-app-docker/description
  Manage Docker from the Sight UI. Installs the page, its rpcd ACL and the
  docker.* engine methods; the engine itself comes from dockerd.
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

# 卸载后重载 rpcd，撤下本包注册的接口与权限
define Package/sight-app-docker/postrm
#!/bin/sh
[ -n "$${IPKG_INSTROOT}" ] || /etc/init.d/rpcd reload
exit 0
endef

$(eval $(call BuildPackage,sight-app-docker))
