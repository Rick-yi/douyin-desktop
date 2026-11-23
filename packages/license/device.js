/**
 * 设备指纹
 *
 * 只上报哈希，不上报任何硬件原始值。
 * 组成：Windows MachineGuid + 系统盘卷序列号 + CPU ProcessorId。
 * 任一取不到就用其余的；全都取不到时退回主机名（这种情况下重装系统会变）。
 */
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import os from 'node:os';

function run(cmd, timeout = 3000) {
  try {
    return execSync(cmd, {
      encoding: 'utf8',
      timeout,
      stdio: ['ignore', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    return '';
  }
}

function machineGuid() {
  const out = run('reg query "HKLM\\SOFTWARE\\Microsoft\\Cryptography" /v MachineGuid');
  const m = out.match(/MachineGuid\s+REG_SZ\s+([0-9a-fA-F-]{20,})/);
  return m ? m[1] : '';
}

function volumeSerial() {
  const out = run('cmd /c vol C:');
  // 英文 "Volume Serial Number is 1A2B-3C4D"，中文 "卷的序列号是 1A2B-3C4D"
  const m = out.match(/([0-9A-F]{4}-[0-9A-F]{4})/i);
  return m ? m[1].toUpperCase() : '';
}

function cpuId() {
  // wmic 在新系统被移除，PowerShell 作为兜底
  let out = run('wmic cpu get ProcessorId /value');
  let m = out.match(/ProcessorId=([0-9A-Fa-f]+)/);
  if (m) return m[1];
  out = run('powershell -NoProfile -Command "(Get-CimInstance Win32_Processor).ProcessorId"');
  m = out.match(/([0-9A-Fa-f]{8,})/);
  return m ? m[1] : '';
}

/**
 * 计算稳定指纹（64 位十六进制）
 * @returns {{ deviceId: string, parts: { machineGuid: boolean, volume: boolean, cpu: boolean, hostname: boolean } }}
 */
export function computeDeviceId() {
  const g = machineGuid();
  const v = volumeSerial();
  const c = cpuId();
  const raw = [g, v, c].filter(Boolean).join('|');
  const usedHostname = !raw;
  const source = usedHostname ? os.hostname() : raw;
  const deviceId = createHash('sha256').update(source).digest('hex');
  return {
    deviceId,
    parts: {
      machineGuid: !!g,
      volume: !!v,
      cpu: !!c,
      hostname: usedHostname,
    },
  };
}
