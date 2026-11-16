// Finds the laptop address a phone on the same Wi-Fi can reach.
// Laptops often have extra virtual network adapters (VirtualBox, Hyper-V/WSL, VMware,
// Docker, VPNs) whose addresses a phone can never reach, so those are ranked last.
import os from 'node:os';

const VIRTUAL = /virtualbox|vbox|vmware|vmnet|vethernet|hyper-v|wsl|docker|br-|veth|virbr|loopback|bluetooth|tailscale|zerotier|hamachi|vpn|tun|tap|utun|npcap/i;
const WIFI = /wi-?fi|wlan|wireless|wlp|^en0$/i;

function score(name, address) {
  if (VIRTUAL.test(name)) return 0;
  if (/^192\.168\.(56|99)\./.test(address)) return 0;      // VirtualBox host-only defaults
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(address) && /^(eth|ethernet)/i.test(name) === false) return 1; // often WSL/Docker
  if (/^169\.254\./.test(address)) return 0;               // no network (self-assigned)
  if (WIFI.test(name)) return 3;
  return 2;                                                // Ethernet or unknown real adapter
}

/** All reachable-looking IPv4 addresses, best guess first: [{ name, address, likelyVirtual }] */
export function lanAddresses(interfaces = os.networkInterfaces()) {
  const list = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const a of addrs || []) {
      if (a.family !== 'IPv4' && a.family !== 4) continue;
      if (a.internal) continue;
      list.push({ name, address: a.address, score: score(name, a.address) });
    }
  }
  return list
    .sort((x, y) => y.score - x.score)
    .map(({ name, address, score: s }) => ({ name, address, likelyVirtual: s === 0 }));
}
