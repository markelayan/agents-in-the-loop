// Loopback check shared by the HTTP routes and the MCP endpoint.
export function isLoopbackAddr(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}
