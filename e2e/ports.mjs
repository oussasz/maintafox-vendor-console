// Ports of the browser-test servers. Below 32768 so no outgoing connection (Linux ephemeral range)
// can hold them; the console port is the origin the test API accepts (CORS_ORIGIN, Origin check).
export const E2E_API_PORT = 18321;
export const E2E_CONSOLE_PORT = 5174;
