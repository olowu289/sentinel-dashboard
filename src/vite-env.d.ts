/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_PLATFORM_URL: string;
  readonly VITE_PLATFORM_PROXY: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
