/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** The tower's own MediaMTX WHEP host:port on the LAN. */
  readonly VITE_LOCAL_VIDEO_HOST: string;
  /** The tower's own gateway host:port (control + position + recordings). */
  readonly VITE_LOCAL_CONTROL_HOST: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
