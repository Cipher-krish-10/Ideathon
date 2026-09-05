import js from "@eslint/js";
import next from "eslint-config-next";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "src/generated/**", // Prisma output
      "next-env.d.ts",
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,
  ...next,

  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // `consistent-type-imports` is deliberately omitted: it requires typed
      // linting, which the Next parser does not forward, and the cost of
      // enabling full type-aware linting is not worth a style rule here.
      eqeqeq: ["error", "smart"],
      "no-console": "off",
    },
  },

  // ---------------------------------------------------------------------
  // Architectural boundary.
  //
  // The Prisma client must not escape src/server/**. Application code goes
  // through the repository layer, which forces a merchant scope onto every
  // query. A single unscoped findMany is a cross-tenant data leak, and it
  // looks exactly like ordinary code in review -- so the boundary is
  // enforced by the linter rather than by discipline.
  // ---------------------------------------------------------------------
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/server/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@/server/db",
              message:
                "Do not import the Prisma client directly. Use src/server/repositories, " +
                "which scopes every query to a merchant.",
            },
          ],
          patterns: [
            {
              group: ["@/generated/prisma/client", "**/generated/prisma/client"],
              message:
                "Do not construct a Prisma client outside src/server. Use the repository layer.",
            },
          ],
        },
      ],
    },
  },

  // ---------------------------------------------------------------------
  // Purity boundary for src/core/**.
  //
  // The domain layer must stay framework-free and side-effect-free: it is the
  // part of RevenuePilot whose answers have to be reproducible and auditable.
  // Reaching for Prisma, Next, the network, or an LLM from here would make a
  // detector's output depend on something a test cannot pin down.
  //
  // Persistence happens OUTSIDE the detector, in src/server/services.
  // ---------------------------------------------------------------------
  {
    files: ["src/core/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "@/server/db", message: "src/core must not touch the database." },
            {
              name: "@/lib/env",
              message:
                "src/core must not read environment configuration. Pass values in as explicit inputs.",
            },
            {
              name: "server-only",
              message: "src/core is environment-agnostic and must not be server-pinned.",
            },
          ],
          patterns: [
            {
              group: [
                "@/app/*", "@/app",
                "@/server/*", "@/server",
                "@/generated/*", "@/generated",
                "**/generated/prisma/*",
                "@prisma/*", "prisma", ".prisma/*",
                "next", "next/*",
                "react", "react-dom",
              ],
              message:
                "src/core is a pure domain layer: no Prisma, no Next, no React. " +
                "Accept explicit inputs and let src/server handle persistence.",
            },
            {
              group: [
                "node:http", "node:https", "node:net", "node:dns", "node:fs",
                "node:fs/*", "axios", "node-fetch", "undici",
                "@anthropic-ai/*", "openai", "razorpay",
              ],
              message:
                "src/core performs no I/O: no network, no filesystem, no LLM, no payment provider.",
            },
          ],
        },
      ],
    },
  },

  // Type-only imports of generated enums and model types are safe and useful
  // anywhere; only the client constructor is restricted above.
  {
    files: ["prisma/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"],
    rules: { "no-restricted-imports": "off" },
  },
);
