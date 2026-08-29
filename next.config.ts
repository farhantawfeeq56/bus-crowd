import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Pin the workspace root. Without this, a stray package-lock.json in a parent
  // directory makes Turbopack guess a root above the repo and warn on every boot.
  turbopack: { root: import.meta.dirname },

  // `pg` opens real TCP sockets — it must stay an external Node module and never
  // be pulled into the bundler's graph.
  serverExternalPackages: ['pg'],

  /*
   * Next's dev server rejects requests for /_next/* assets whose Host is not an
   * allowed dev origin, with a 403. Opening the app on a phone over the LAN
   * (http://<laptop-ip>:3000) therefore loads the HTML but none of the client
   * bundle: React never hydrates and the page freezes on its server-rendered
   * empty state. Demoing on real phones means the whole private address space
   * has to be allowed, because the laptop's DHCP address changes per network.
   *
   * Dev-only setting — `next build`/`next start` ignore it entirely.
   */
  allowedDevOrigins: [
    '10.*.*.*',       // private class A
    '172.16.*.*', '172.17.*.*', '172.18.*.*', '172.19.*.*',
    '172.20.*.*', '172.21.*.*', '172.22.*.*', '172.23.*.*',
    '172.24.*.*', '172.25.*.*', '172.26.*.*', '172.27.*.*',
    '172.28.*.*', '172.29.*.*', '172.30.*.*', '172.31.*.*',
    '192.168.*.*',    // private class C — the usual home/phone-hotspot range
    '*.local',        // mDNS hostnames, e.g. my-laptop.local
  ],
};

export default nextConfig;
