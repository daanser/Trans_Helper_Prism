// SPDX-License-Identifier: GPL-3.0-or-later
// TransHelper Prism — Nuxt 3 前端壳
// 继承旧 `old-Trans-Search/frontend/nuxt.config.ts`：Tailwind v3 (dark class)、防闪烁 script、devProxy、public.apiBase 可配。
// 按 tasks.md T0.5 重写，删掉旧 @nuxt/icon 重型图标库（不引入重型 UI 库），保留最小栈。

export default defineNuxtConfig({
  compatibilityDate: "2026-07-14",
  devtools: { enabled: true },
  modules: ["@nuxtjs/tailwindcss"],
  tailwindcss: {
    config: {
      darkMode: "class",
    },
  },
  nitro: {
    // 本地 dev 用默认 node preset（devProxy/routeRules 代理正常）；
    // Pages 部署构建时必须 NITRO_PRESET=cloudflare_module。
    ...(process.env.NITRO_PRESET ? { preset: process.env.NITRO_PRESET as "cloudflare_module" } : {}),
    // 本地 dev 代理：只用 Vite server.proxy（透传全路径）。
    // nitro 的 devProxy / routeRules proxy 都会吃掉 /api 前缀，别用。
  },
  vite: {
    server: {
      proxy: {
        "/api": {
          target: process.env.API_BASE_URL || "http://127.0.0.1:8787",
          changeOrigin: true,
        },
      },
    },
  },
  app: {
    head: {
      title: "TransHelper Prism",
      meta: [
        { name: "description", content: "TransHelper Prism — 跨性别与性少数中文 wiki 聚合语义检索" },
        { name: "theme-color", content: "#ede4cf" },
        // 社交分享（Discord / 即时通讯等）统一用中性、准确的文案
        { property: "og:title", content: "TransHelper Prism" },
        { property: "og:description", content: "跨性别与性少数中文 wiki 聚合语义检索，覆盖 MtF / FtM / RLE / Mio 四部知识库。" },
        { property: "og:site_name", content: "TransHelper Prism" },
        { property: "og:type", content: "website" },
        { property: "og:image", content: "/logo_foreground.svg" },
      ],

      link: [{ rel: "icon", type: "image/svg+xml", href: "/favicon.svg" }],

      // 防止 SSR 首屏深色闪烁（Cookie + localStorage 双查 + 系统偏好探测）
      script: [
        {
          // 登录回跳兜底：在 Nuxt 启动前把 #token= / #error= 落盘并清 hash。
          // 不这样做的话，水合/路由初始化可能重写 URL 丢掉 fragment，onMounted 里就读不到（线上踩过）。
          innerHTML: `
(function () {
  try {
    var raw = (window.location.hash || "").replace(/^#/, "");
    if (!raw) return;
    var params = new URLSearchParams(raw);
    var token = params.get("token");
    var error = params.get("error");
    if (!token && !error) return;
    if (token) {
      try { window.localStorage.setItem("prism_token", token); } catch (_) {}
    }
    if (error) {
      try { window.sessionStorage.setItem("prism_auth_error", error); } catch (_) {}
    }
    window.history.replaceState(window.history.state, "", window.location.pathname + window.location.search);
  } catch (_) {}
})();
          `,
          type: "text/javascript",
        },
        {
          innerHTML: `
(function () {
  try {
    var preference = "";
    var cookie = document.cookie.match(/(?:^|; )dark-mode=([^;]*)/);
    if (cookie) {
      preference = decodeURIComponent(cookie[1]);
    }
    if (!preference) {
      try {
        preference = localStorage.getItem("dark-mode") || "";
      } catch (_) {}
    }
    var dark = false;
    if (preference === "dark") {
      dark = true;
    } else if (preference === "light") {
      dark = false;
    } else {
      dark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    }
    if (dark) {
      document.documentElement.classList.add("dark");
    } else {
      document.documentElement.classList.remove("dark");
    }
  } catch (_) {}
})();
          `,
          type: "text/javascript",
        },
      ],
    },
  },

  css: ["~/assets/css/main.css"],
  runtimeConfig: {
    public: {
      // 前端只调自家 API；dev 下由 devProxy 转发到本地 Workers
      apiBase: process.env.NUXT_PUBLIC_API_BASE || "/api",
    },
  },
})
