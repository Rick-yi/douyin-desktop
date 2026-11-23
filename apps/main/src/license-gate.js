/**
 * 功能门禁
 *
 * IPC 模块统一从这里取检查结果，避免每处都写一遍授权判断。
 * 未初始化（或开发模式未启用授权）时一律放行。
 */
let manager = null;

export function setLicenseManager(m) {
  manager = m;
}

export function getLicenseManager() {
  return manager;
}

/**
 * @returns {null|{ok:false, code:string, feature:string, error:string}}
 */
export function requireFeature(feature) {
  if (!manager) return null;
  const r = manager.can(feature);
  if (r.allowed) return null;
  return {
    ok: false,
    code: r.code || 'LICENSE_REQUIRED',
    feature,
    error: r.message || '需要授权后才能使用该功能',
  };
}

export function licenseStatus() {
  return manager ? manager.status() : { state: 'uninitialized', enforce: false };
}
