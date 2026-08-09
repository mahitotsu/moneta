// Workaround for this sandbox's DNS resolver hanging ~15s on AAAA queries
// (see the "Do not run `npx jest ...` directly" section of e2e/README.md).
// Forces Node's dns.lookup to resolve IPv4 only, which is instant here.
// Loaded via NODE_OPTIONS=--require by the npm scripts in package.json.
const dns = require("dns");
const originalLookup = dns.lookup;
dns.lookup = (hostname, options, callback) => {
  if (typeof options === "function") {
    callback = options;
    options = {};
  }
  return originalLookup(hostname, { ...options, family: 4 }, callback);
};
