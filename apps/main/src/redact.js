/** 日志/错误展示脱敏；不修改聊天记录和导出数据 */
export function redact(text) {
  return String(text ?? '')
    .replace(/(1[3-9]\d)\d{4}(\d{4})/g, '$1****$2')
    .replace(/([A-Za-z0-9._%+-])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, '$1***$2')
    .replace(/\b\d{17}[\dXx]\b/g, '******************')
    .replace(/((?:微信|VX|vx|WX|wx|QQ|qq|薇|v)\s*[：:]?\s*)[A-Za-z0-9_-]{4,}/g, '$1***');
}
