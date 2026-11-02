// Preload for offline acceptance only. Inherited by Vitest worker processes.
// No sockets (including database sockets) or DNS lookups may reach a service.
// In-process provider fakes and mocks remain usable. Never import at app boot.
const deny = () => {
  throw new Error("R10-D offline acceptance: network access is disabled");
};
const net = require("node:net");
net.Socket.prototype.connect = deny;
net.connect = deny;
net.createConnection = deny;
require("node:tls").connect = deny;
for (const name of ["node:http", "node:https"]) {
  const transport = require(name);
  transport.request = deny;
  transport.get = deny;
}
for (const name of ["node:dns", "node:dns/promises"]) {
  const dns = require(name);
  for (const key of Object.keys(dns)) {
    if (
      /^(lookup|resolve|reverse)/.test(key) &&
      typeof dns[key] === "function"
    ) {
      dns[key] = deny;
    }
  }
}
// Vite compares localhost lookup modes during startup. Resolve this locally,
// without consulting either the OS resolver or a DNS server.
const localhost = (hostname, options) => {
  if (hostname !== "localhost") return deny();
  const family = options === 6 || options?.family === 6 ? 6 : 4;
  const result = { address: family === 6 ? "::1" : "127.0.0.1", family };
  return options?.all ? [result] : result;
};
require("node:dns/promises").lookup = async (hostname, options) =>
  localhost(hostname, options);
require("node:dns").lookup = (hostname, options, callback) => {
  if (typeof options === "function") {
    callback = options;
    options = undefined;
  }
  const result = localhost(hostname, options);
  queueMicrotask(() =>
    Array.isArray(result)
      ? callback(null, result)
      : callback(null, result.address, result.family)
  );
};
require("node:dgram").createSocket = deny;
require("node:module").syncBuiltinESMExports();
