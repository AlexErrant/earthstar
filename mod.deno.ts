/**
 * Modules for using Earthstar on the Deno runtime, e.g. persisting data to the filesystem.
 *
 * @module
 */
export { RuntimeDriverDeno } from "./src/runtime/driver_deno.ts";
export { getStorageDriverFilesystem } from "./src/peer/storage_drivers/filesystem.deno.ts";
export { Server, type ServerOpts } from "./src/server/server.ts";
export { ExtensionSyncWebsocket } from "./src/server/extensions/sync_websocket.ts";