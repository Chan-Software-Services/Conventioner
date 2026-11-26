/// <reference types="vite/client" />
declare module '*.vue' {
  import { DefineComponent } from 'vue';

  const component: DefineComponent<object, object, unknown>;
  export default component;
}

interface ImportMetaEnv {
  /** The front-end Sentry project's DSN; blank or unset, no error is tracked (ADR 0049). */
  readonly VITE_SENTRY_DSN?: string;
}
