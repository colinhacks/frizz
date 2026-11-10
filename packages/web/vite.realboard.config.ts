import { defineConfig, mergeConfig, type Plugin } from "vite"
import base from "./vite.config.ts"

// THE ONE-THREAD PANE PROTOTYPE, ON THE REAL BOARD. This branch's web source, served by this Vite, talking
// to the Frizz already running on this Mac (the launcher's stable port), so the prototype can be felt on
// real threads without restarting anything or running a second server. Not for main.
//
//   cd packages/web && nubx vite --config vite.realboard.config.ts
//   http://127.0.0.1:5199/project/frizz
//
// THE SAME RULE AS THE SERVER'S OWN GUARD (local-origin.ts). The server only trusts a page it served,
// which it judges by Host and Origin. A proxy that rewrote those for every caller would hand any website
// open in the browser a way to drive this Mac's Frizz, so this one forwards only what the server would
// have let through had it served this page itself: Host is this Vite, and Origin is absent or this Vite.
// A request with no Origin keeps its `sec-fetch-site`, which the server checks in turn.
const PORT = 5199
const SELF_HOST = `127.0.0.1:${PORT}`
const SELF_ORIGIN = `http://${SELF_HOST}`
const TARGET = "http://127.0.0.1:9393"

function sameOriginOnly(req: { headers: Record<string, string | string[] | undefined> }): boolean {
  const origin = req.headers.origin
  return req.headers.host === SELF_HOST && (origin === undefined || origin === SELF_ORIGIN)
}

function guard(): Plugin {
  return {
    name: "frizz:realboard-guard",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.startsWith("/_frizz") && !sameOriginOnly(req)) {
          res.statusCode = 403
          res.end("Forbidden")
          return
        }
        next()
      })
    },
  }
}

export default mergeConfig(
  base,
  defineConfig({
    plugins: [guard()],
    server: {
      host: "127.0.0.1",
      port: PORT,
      strictPort: true,
      proxy: {
        "/_frizz": {
          target: TARGET,
          changeOrigin: true,
          ws: true,
          configure(proxy) {
            proxy.on("proxyReq", (proxyReq, req) => {
              if (req.headers.origin) proxyReq.setHeader("origin", TARGET)
            })
            proxy.on("proxyReqWs", (proxyReq, req, socket) => {
              if (!sameOriginOnly(req)) {
                socket.destroy()
                return
              }
              if (req.headers.origin) proxyReq.setHeader("origin", TARGET)
            })
          },
        },
      },
    },
  }),
)
