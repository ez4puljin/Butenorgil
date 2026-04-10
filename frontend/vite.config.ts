import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "fs";
import path from "path";

const KEY  = path.join(__dirname, "certs", "192.168.1.198+2-key.pem");
const CERT = path.join(__dirname, "certs", "192.168.1.198+2.pem");

const httpsOpts = !process.env.VITE_NO_HTTPS && fs.existsSync(KEY) && fs.existsSync(CERT)
  ? { key: fs.readFileSync(KEY), cert: fs.readFileSync(CERT) }
  : undefined; // cert байхгүй эсвэл VITE_NO_HTTPS=1 бол HTTP-ээр ажиллана

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 3000,
    https: httpsOpts,
    proxy: httpsOpts
      ? {
          // HTTPS frontend → HTTP backend (Mixed Content-аас зайлсхийх)
          "/api": {
            target: "http://127.0.0.1:8000",
            changeOrigin: true,
            rewrite: (p) => p.replace(/^\/api/, ""),
          },
        }
      : undefined,
  },
});
