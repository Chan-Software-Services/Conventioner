import { readFileSync, realpathSync } from 'node:fs';
import { relative } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import { defineConfig, loadEnv, normalizePath, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import vueJsx from '@vitejs/plugin-vue-jsx';
import vueDevTools from 'vite-plugin-vue-devtools';

/**
 * Cloudflare's published test site keys (`1x00000000000000000000AA`, `3x00000000000000000000FF`, ...):
 * a digit, `x`, at least twenty zeros and two letters, the shape the back end refuses for a secret
 * (`utils/configured_secret.py`). A bundle carrying one passes, fails or always asks every person,
 * whatever the back end's secret.
 */
const TEST_SITE_KEY = /^\dx0{20,}[A-Za-z]{2}$/;

/**
 * Refuse to build a bundle that cannot pass the human check the back end enforces (T539).
 *
 * The site key is baked into the bundle at build time, and with none, `HumanCheck` renders no
 * widget and sends a placeholder token. A back end with a Turnstile secret, which it needs to boot,
 * checks that token with Cloudflare, which never issued it, and every organizer sign-up and vendor
 * code request is asked for the check again, on a deployment that looks healthy, with nothing
 * naming the variable. The back end's `TURNSTILE_SECRET_KEY` and this site key are a matched pair
 * from one Turnstile widget, and a deploy that sets only the first ships a product nobody can sign
 * up to or sign in with a code.
 *
 * So the failure lands here, at build time, where it names itself: the same shape as the back
 * end's boot refusal, and for the same reason. The escape hatch is the same one too, opt-in and by
 * the same name: a bundle built without a key, or with one of Cloudflare's test keys, only works
 * against a back end that has also been told it is a local development one
 * (`ALLOW_INSECURE_LOCAL_DEV` + `DISABLE_CAPTCHA`).
 */
function assertHumanCheckSiteKey(env: Record<string, string>) {
  const siteKey = env.VITE_TURNSTILE_SITE_KEY?.trim();
  const hatch = env.VITE_ALLOW_INSECURE_LOCAL_DEV === 'true';
  if (siteKey && !TEST_SITE_KEY.test(siteKey)) {
    return;
  }
  if (siteKey) {
    if (hatch) {
      console.warn(
        "[human check] VITE_ALLOW_INSECURE_LOCAL_DEV is set: building a bundle with Cloudflare's " +
          'test site key. Only a local development back end accepts its token. Never ' +
          'deploy this bundle.',
      );
      return;
    }
    throw new Error(
      "VITE_TURNSTILE_SITE_KEY is one of Cloudflare's published test site keys, which pass, fail " +
        'or always ask every person whatever the back end checks. Set it to the site key of the ' +
        "Turnstile widget whose secret is the back end's TURNSTILE_SECRET_KEY (Cloudflare " +
        'dashboard, Turnstile), or set VITE_ALLOW_INSECURE_LOCAL_DEV=true if this build is only ' +
        'ever going to talk to a local back end running with DISABLE_CAPTCHA.',
    );
  }
  if (hatch) {
    console.warn(
      '[human check] VITE_ALLOW_INSECURE_LOCAL_DEV is set: building a bundle with no Turnstile ' +
        'site key. It sends a placeholder token, which only a local development back end ' +
        'accepts. Never deploy this bundle.',
    );
    return;
  }
  throw new Error(
    'VITE_TURNSTILE_SITE_KEY is not set, so this bundle would carry no Turnstile site key and send ' +
      'a placeholder token instead. The back end checks that token with Cloudflare, which never ' +
      'issued it, and asks every sign-up and vendor code request for the check again, naming none ' +
      'of this: a deployment nobody can sign up to. Set VITE_TURNSTILE_SITE_KEY to the site key of ' +
      "the Turnstile widget whose secret is the back end's TURNSTILE_SECRET_KEY (Cloudflare " +
      'dashboard, Turnstile), or set VITE_ALLOW_INSECURE_LOCAL_DEV=true if this build is only ever ' +
      'going to talk to a local back end running with DISABLE_CAPTCHA.',
  );
}

/**
 * Refuse to build a bundle with no API address (T273).
 *
 * `VITE_FLASK_HOST` is baked into the bundle at build time as the base of every API request. With
 * none, each request goes to the front end's own origin, whose rewrite answers every path with
 * `index.html` and 200, so the deployment looks healthy and nothing works. The hatch is the site
 * key's: a bundle built under `VITE_ALLOW_INSECURE_LOCAL_DEV` warns and builds, as CI's and the
 * gate's builds do.
 */
function assertApiHost(env: Record<string, string>) {
  if (env.VITE_FLASK_HOST?.trim()) {
    return;
  }
  if (env.VITE_ALLOW_INSECURE_LOCAL_DEV === 'true') {
    console.warn(
      '[api] VITE_ALLOW_INSECURE_LOCAL_DEV is set: building a bundle with no VITE_FLASK_HOST. It ' +
        'calls its own origin. Never deploy this bundle.',
    );
    return;
  }
  throw new Error(
    'VITE_FLASK_HOST is not set, so this bundle would send every API request to its own origin, ' +
      "where every path answers index.html with 200 and nothing works. Set it to the back end's " +
      'address (https://api.conventioner.io in production), or set ' +
      'VITE_ALLOW_INSECURE_LOCAL_DEV=true if this build only ever talks to a local back end.',
  );
}

/**
 * Refuse the hatch on a Vercel build outright (T273): it lets a bundle build with no site key, or
 * one of Cloudflare's test keys, and no API address, and a build Vercel makes is one that may be
 * served. Vercel's build sets `VERCEL=1` while the project's "Enable access to System Environment
 * Variables" setting is ticked, and not otherwise, so the refusal is armed only with that box ticked. It is not a `VITE_`
 * variable, so it is read from the build's process environment, as `BUILD_COMMIT` is, and no `.env`
 * file can set it.
 */
function assertNoLocalHatchOnVercel(env: Record<string, string>) {
  if (!process.env.VERCEL?.trim() || env.VITE_ALLOW_INSECURE_LOCAL_DEV !== 'true') {
    return;
  }
  throw new Error(
    'VITE_ALLOW_INSECURE_LOCAL_DEV is set on a Vercel build. It lets a bundle build with no ' +
      'Turnstile site key or API address, which a deployed front end must never ship. Remove it ' +
      "from the front-end project's environment on Vercel.",
  );
}

/**
 * The headers `vercel.json` sends on every path, so `vite preview` serves a production build under
 * the same security headers and Content-Security-Policy as production does. `vercel.json` is the one
 * place they are declared; walk a page with `npm run build-only && npm run preview` to see what the
 * policy refuses there.
 */
function deployedHeaders(): Record<string, string> {
  const vercel = JSON.parse(readFileSync(new URL('./vercel.json', import.meta.url), 'utf8')) as {
    headers: { source: string; headers: { key: string; value: string }[] }[];
  };
  const everyPath = vercel.headers.find((rule) => rule.source === '/(.*)');
  return Object.fromEntries((everyPath?.headers ?? []).map(({ key, value }) => [key, value]));
}

/** Whether the `connect-src` source `source` allows an HTTPS request to `host`. */
function sourceAllowsHost(source: string, host: string): boolean {
  const match = /^https:\/\/([^/:]+)\/?$/.exec(source);
  if (!match) return false;
  const allowed = match[1]!.toLowerCase();
  if (allowed.startsWith('*.')) return host.endsWith(allowed.slice(1));
  return host === allowed;
}

/**
 * Refuse an error tracker DSN the browser could not send to (T584).
 *
 * `VITE_SENTRY_DSN` is optional: blank, the bundle has no Sentry chunk and tracking is off. Set, it
 * must be a Sentry DSN, and its host one the policy's `connect-src` in `vercel.json` allows, read
 * as `vite preview` reads it, an exact host or a `*.` pattern matched as the policy matches one;
 * otherwise every event would be refused by the policy, and nothing would say why. So the
 * mistake fails the build, naming the variable. There is no hatch: a blank one builds.
 */
function assertErrorTrackerDsn(env: Record<string, string>) {
  const dsn = env.VITE_SENTRY_DSN?.trim();
  if (!dsn) return;
  const parts = /^https:\/\/[A-Za-z0-9]+@([A-Za-z0-9.-]+)\/\d+$/.exec(dsn);
  if (!parts) {
    throw new Error(
      'VITE_SENTRY_DSN is not a Sentry DSN (https://<key>@<host>/<project id>). Copy it from the ' +
        "front-end Sentry project's Client Keys page, or leave it blank to build with error " +
        'tracking off.',
    );
  }
  const host = parts[1]!.toLowerCase();
  const policy = deployedHeaders()['Content-Security-Policy'] ?? '';
  const connect =
    policy
      .split(';')
      .map((directive) => directive.trim().split(/\s+/))
      .find(([name]) => name === 'connect-src')
      ?.slice(1) ?? [];
  if (connect.some((source) => sourceAllowsHost(source, host))) return;
  throw new Error(
    `VITE_SENTRY_DSN names the host ${host}, which the Content-Security-Policy's connect-src in ` +
      'vercel.json does not allow, so the browser would refuse every event. Use a DSN of a ' +
      'project in the region connect-src allows, or add its ingest host there.',
  );
}

/**
 * vuedraggable's own ES source, which it publishes beside its builds. Its builds are webpack UMD
 * bundles carrying core-js, whose global lookup runs `Function('return this')()`: a string
 * evaluated as script, which the Content-Security-Policy refuses, so the call would break every page
 * with a drag list. The source is the same component without that, importing SortableJS's ES build.
 */
export const VUEDRAGGABLE_SOURCE = {
  find: /^vuedraggable$/,
  replacement: 'vuedraggable/src/vuedraggable.js',
};

/** A module of Vue (its `@vue/` packages included), the router or Pinia, by its id. */
const VUE_RUNTIME = /[\\/]node_modules[\\/](@vue|vue|vue-router|pinia)[\\/]/;

/** The id `@vitejs/plugin-vue` gives the helper it imports into every single-file component. */
const VUE_SFC_HELPER = '\0plugin-vue:export-helper';

/**
 * `src/dev/` spelled as Vite spells a module id, so they compare: its real path, since Vite resolves
 * every id through symbolic links, and with `/` for a separator, as Vite writes ids on Windows too.
 */
const DEV_DIR = `${normalizePath(realpathSync(fileURLToPath(new URL('./src/dev/', import.meta.url))))}/`;

/**
 * No development page ships (T200): a production build fails when any module of the component
 * library, `src/dev/`, is in any chunk it emits, and names each chunk and module.
 *
 * The library is reached only through the router's `if (import.meta.env.DEV)` block, which a
 * production build drops with its lazy imports. Anything else that reaches `src/dev/` (a shipped
 * file importing the fixture's synthetic applicants or a part, by any path, or that block kept
 * alive) puts it in a chunk, and this is where it is caught, on every production build: CI's, the
 * gate's and the deploy's. ESLint's `app/dev-pages-stay-out` refuses the import before it is built.
 */
export function noDevModules(): Plugin {
  let production = false;
  let root = '';
  return {
    name: 'conventioner:no-dev-modules',
    apply: 'build',
    configResolved(config) {
      production = config.isProduction;
      root = config.root;
    },
    generateBundle(_options, bundle) {
      if (!production) return;
      const found = Object.values(bundle).flatMap((output) => {
        if (output.type !== 'chunk') return [];
        const modules = new Set(
          output.moduleIds
            .filter((id) => id.startsWith(DEV_DIR))
            .map((id) => relative(root, id.split('?')[0]!)),
        );
        return [...modules].map((module) => `  ${output.fileName}: ${module}`);
      });
      if (found.length === 0) return;
      this.error(
        [
          'The component library, a development build only, is in this production build:',
          ...found,
          'Only the router may reach src/dev/, inside `if (import.meta.env.DEV)`, by a lazy ' +
            'import(); find what reaches it another way and remove it.',
        ].join('\n'),
      );
    },
  };
}

/** `src/utils/errorTrackingClient.ts` spelled as Vite spells a module id, as `DEV_DIR` is. */
const ERROR_TRACKER_CLIENT = normalizePath(
  realpathSync(fileURLToPath(new URL('./src/utils/errorTrackingClient.ts', import.meta.url))),
);

/** A module of the Sentry SDK, by its id. */
const SENTRY_SDK = /[\\/]node_modules[\\/]@sentry[\\/]/;

/**
 * No error tracker ships without a DSN (T584): a production build with a blank `VITE_SENTRY_DSN`
 * fails when any chunk it emits holds the tracker's client or a module of `@sentry/`, and names
 * each chunk and module.
 *
 * `errorTracking.ts` reaches the client only by an `import()` behind the DSN's check, spelled out
 * in each function that loads it, which a build with no DSN drops with its branch. Moved behind a
 * helper, the check is no longer folded and the build keeps the import, emitting the SDK's chunk;
 * this is where that is caught, on every production build: CI's, the gate's and the deploy's.
 */
export function noErrorTrackerWithoutDsn(dsn: string | undefined): Plugin {
  let production = false;
  let root = '';
  return {
    name: 'conventioner:no-error-tracker-without-dsn',
    apply: 'build',
    configResolved(config) {
      production = config.isProduction;
      root = config.root;
    },
    generateBundle(_options, bundle) {
      if (!production || dsn?.trim()) return;
      const found = Object.values(bundle).flatMap((output) => {
        if (output.type !== 'chunk') return [];
        const modules = new Set(
          output.moduleIds
            .map((id) => id.split('?')[0]!)
            .filter((id) => id === ERROR_TRACKER_CLIENT || SENTRY_SDK.test(id))
            .map((id) => relative(root, id)),
        );
        return [...modules].map((module) => `  ${output.fileName}: ${module}`);
      });
      if (found.length === 0) return;
      this.error(
        [
          'The error tracker is in this production build, which sets no VITE_SENTRY_DSN:',
          ...found,
          'Only errorTracking.ts may reach errorTrackingClient.ts, by an import() behind the ' +
            'DSN check spelled out in the function that loads it; find what reaches it ' +
            'another way.',
        ].join('\n'),
      );
    },
  };
}

/**
 * Every build says which commit it was built from (T254): it emits `version.json` at the root of
 * its output, `{"commit":"<sha>"}`, or `{"commit":null}` for a build made without one (CI's, the
 * gate's, a local one), so it is never mistaken for a released commit.
 *
 * The Deploy workflow reads it, on the staged deployment and then on `conventioner.io`, to prove
 * the domain serves the commit it released; a person reads it with
 * `curl https://conventioner.io/version.json` to learn which build is live. The workflow sets
 * `BUILD_COMMIT` with `vercel deploy --build-env`, and this reads it from the build's process
 * environment. It is not a `VITE_` variable, and not read through `loadEnv`, so it is never inlined
 * into the bundle, a new commit leaves every chunk's hash as it was, and no `.env` file can set it.
 */
export function buildCommit(): Plugin {
  return {
    name: 'conventioner:build-commit',
    apply: 'build',
    generateBundle() {
      const commit = process.env.BUILD_COMMIT;
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify({ commit: commit?.trim() ? commit : null }),
      });
    },
  };
}

// https://vite.dev/config/
export default defineConfig(({ command, mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), 'VITE_');

  if (command === 'build') {
    assertNoLocalHatchOnVercel(env);
    assertHumanCheckSiteKey(env);
    assertApiHost(env);
    assertErrorTrackerDsn(env);
  }

  return {
    plugins: [
      vue(),
      vueJsx(),
      vueDevTools(),
      noDevModules(),
      noErrorTrackerWithoutDsn(env.VITE_SENTRY_DSN),
      buildCommit(),
    ],
    resolve: {
      alias: [
        { find: '@', replacement: fileURLToPath(new URL('./src', import.meta.url)) },
        VUEDRAGGABLE_SOURCE,
      ],
    },
    build: {
      rolldownOptions: {
        output: {
          // Licence notices survive minifying, which drops every comment by default: the copied
          // Lucide icons carry ISC's notice as a `/*! @license */` comment, and that licence (like
          // the MIT notices of the libraries bundled here) asks for it in all copies.
          comments: { legal: true, annotation: false, jsdoc: false },
          // Vue, its router and Pinia, which every page runs, as a chunk named for them. Left to
          // itself the build named that shared chunk `_plugin-vue_export-helper`, after the helper
          // the Vue plugin adds to every single-file component, which read as one helper rather
          // than the runtime; the helper goes in with them, so it is no chunk of its own either.
          codeSplitting: {
            groups: [{ name: 'vue', test: (id) => VUE_RUNTIME.test(id) || id === VUE_SFC_HELPER }],
          },
        },
      },
    },
    server: {
      // Where every local URL points (T48). Left to `localhost`, Vite listens on ::1 alone, which
      // nothing dialling 127.0.0.1 reaches. The container's `--host 0.0.0.0` overrides it.
      host: '127.0.0.1',
      hmr: true,
      watch: {
        usePolling: true,
        // A test run's own output is not the app. Watched, the report Playwright writes at the end
        // of a run reloaded every page open on this server, a developer's included.
        ignored: ['**/test-results/**', '**/playwright-report/**', '**/blob-report/**'],
      },
      proxy: {
        '/api': {
          target: process.env.VITE_BACKEND_URL || 'https://127.0.0.1:5001',
          changeOrigin: true,
          secure: false, // Ignore SSL certificate errors (needed for adhoc cert)
          rewrite: (path) => path.replace(/^\/api/, ''),
        },
      },
    },
    preview: {
      host: '127.0.0.1',
      headers: deployedHeaders(),
    },
  };
});
