/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL: string;
  readonly VITE_APP_URL?: string;
  /** Dev only: skip Telegram initData verification and use a fake user. */
  readonly VITE_DEV_TELEGRAM_USER?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
