import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import logger from '../../logger';
import { getLxcRootfsPath } from './lxcConfig';

export interface LxcBootstrapOptions {
  containerName: string;
  distribution: string; // ubuntu, debian, alpine, etc.
  hostname?: string;
  ipv4?: string;
  gateway?: string;
  nameservers?: string[];
  sshAuthorizedKeys?: string[];
}

/**
 * Distro-aware bootstrap configuration directly on the container's rootfs
 */
export async function bootstrapLxcContainer(options: LxcBootstrapOptions): Promise<void> {
  const rootfs = getLxcRootfsPath(options.containerName);
  if (!existsSync(rootfs)) {
    throw new Error(`LXC container rootfs not found at ${rootfs}`);
  }

  const distro = (options.distribution || 'ubuntu').toLowerCase();

  // 1. Hostname configuration
  if (options.hostname) {
    try {
      const hostnamePath = join(rootfs, 'etc', 'hostname');
      writeFileSync(hostnamePath, `${options.hostname.trim()}\n`, 'utf8');

      const hostsPath = join(rootfs, 'etc', 'hosts');
      const hostsContent = `127.0.0.1\tlocalhost\n127.0.1.1\t${options.hostname.trim()}\n::1\tlocalhost ip6-localhost ip6-loopback\n`;
      writeFileSync(hostsPath, hostsContent, 'utf8');
    } catch (err) {
      logger.warn(`Failed to set hostname in LXC rootfs: ${err}`);
    }
  }

  // 2. DNS Nameservers (/etc/resolv.conf)
  if (options.nameservers && options.nameservers.length > 0) {
    try {
      const resolvPath = join(rootfs, 'etc', 'resolv.conf');
      const lines = options.nameservers.map((ns) => `nameserver ${ns.trim()}`).join('\n');
      writeFileSync(resolvPath, `${lines}\n`, 'utf8');
    } catch (err) {
      logger.warn(`Failed to write /etc/resolv.conf: ${err}`);
    }
  }

  // 3. Static Networking Configuration
  if (options.ipv4) {
    const ip = options.ipv4.includes('/') ? options.ipv4 : `${options.ipv4}/24`;
    const gateway = options.gateway || '';
    const dns = options.nameservers && options.nameservers.length > 0 ? options.nameservers : ['1.1.1.1', '8.8.8.8'];

    if (distro.includes('ubuntu')) {
      // Ubuntu uses Netplan
      try {
        const netplanDir = join(rootfs, 'etc', 'netplan');
        if (!existsSync(netplanDir)) {
          mkdirSync(netplanDir, { recursive: true });
        }
        const netplanConfig = `network:
  version: 2
  renderer: networkd
  ethernets:
    eth0:
      dhcp4: false
      addresses:
        - ${ip}
${gateway ? `      routes:\n        - to: default\n          via: ${gateway}\n` : ''}      nameservers:
        addresses: [${dns.map((d) => `"${d}"`).join(', ')}]
`;
        writeFileSync(join(netplanDir, '01-netcfg.yaml'), netplanConfig, 'utf8');
      } catch (err) {
        logger.warn(`Failed to write netplan config for Ubuntu LXC: ${err}`);
      }
    } else if (distro.includes('debian') || distro.includes('alpine')) {
      // Debian / Alpine use /etc/network/interfaces
      try {
        const netDir = join(rootfs, 'etc', 'network');
        if (!existsSync(netDir)) {
          mkdirSync(netDir, { recursive: true });
        }
        const ipWithoutPrefix = ip.split('/')[0];
        const ifaceConfig = `auto lo\niface lo inet loopback\n\nauto eth0\niface eth0 inet static\n  address ${ipWithoutPrefix}\n  netmask 255.255.255.0\n${gateway ? `  gateway ${gateway}\n` : ''}${dns.length > 0 ? `  dns-nameservers ${dns.join(' ')}\n` : ''}`;
        writeFileSync(join(netDir, 'interfaces'), ifaceConfig, 'utf8');
      } catch (err) {
        logger.warn(`Failed to write /etc/network/interfaces for Debian/Alpine LXC: ${err}`);
      }
    }
  }

  // 4. SSH Authorized Keys (if provided)
  if (options.sshAuthorizedKeys && options.sshAuthorizedKeys.length > 0) {
    try {
      const rootSshDir = join(rootfs, 'root', '.ssh');
      if (!existsSync(rootSshDir)) {
        mkdirSync(rootSshDir, { recursive: true, mode: 0o700 });
      }
      const authKeysPath = join(rootSshDir, 'authorized_keys');
      writeFileSync(authKeysPath, options.sshAuthorizedKeys.join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
    } catch (err) {
      logger.warn(`Failed to write authorized_keys for root: ${err}`);
    }
  }
}
