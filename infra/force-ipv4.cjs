// Workaround for this sandbox's DNS resolver hanging ~15s on AAAA queries
// (see infra/README-network-workaround.md). Forces Node's dns.lookup to
// resolve IPv4 only, which is instant here. Loaded via NODE_OPTIONS=--require.
const dns = require("dns");
const originalLookup = dns.lookup;
dns.lookup = (hostname, options, callback) => {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  return originalLookup(hostname, { ...options, family: 4 }, callback);
};
